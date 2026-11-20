import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { expandSearchRoots, Fs, parseRequire, resolveRequire } from './requireResolve';

const fsAdapter: Fs = {
  async isFile(p) {
    try {
      return ((await vscode.workspace.fs.stat(vscode.Uri.file(p))).type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  },
  async isDir(p) {
    try {
      return ((await vscode.workspace.fs.stat(vscode.Uri.file(p))).type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  },
  async readDir(p) {
    try {
      return (await vscode.workspace.fs.readDirectory(vscode.Uri.file(p))).map(([name]) => name);
    } catch {
      return [];
    }
  },
};

// `crystal env CRYSTAL_PATH` prints e.g. "lib:/usr/share/crystal/src". Cached per compiler path.
const crystalPathCache = new Map<string, Promise<string[]>>();

function compilerCrystalPath(): Promise<string[]> {
  const compiler = vscode.workspace.getConfiguration('crystal').get<string>('compiler.path') || 'crystal';
  let cached = crystalPathCache.get(compiler);
  if (!cached) {
    cached = new Promise<string[]>((resolve) => {
      execFile(compiler, ['env', 'CRYSTAL_PATH'], { timeout: 8000 }, (err, stdout) => {
        resolve(err ? [] : stdout.trim().split(path.delimiter).filter((s) => s !== ''));
      });
    });
    crystalPathCache.set(compiler, cached);
  }
  return cached;
}

export function resetRequireCaches(): void {
  crystalPathCache.clear();
}

async function resolveFor(document: vscode.TextDocument, spec: string): Promise<string[]> {
  if (document.uri.scheme !== 'file') return [];
  const entries = [...(process.env.CRYSTAL_PATH ?? '').split(path.delimiter), ...(await compilerCrystalPath()), 'lib'];
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const roots = expandSearchRoots(entries, document.uri.fsPath, folders);
  return resolveRequire(spec, document.uri.fsPath, roots, fsAdapter);
}

const ZERO = new vscode.Range(0, 0, 0, 0);

class RequireDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.LocationLink[] | undefined> {
    const req = parseRequire(document.lineAt(position.line).text);
    if (!req || position.character < req.start || position.character > req.end) return undefined;
    const files = await resolveFor(document, req.spec);
    if (files.length === 0) return undefined;
    const origin = new vscode.Range(position.line, req.start, position.line, req.end);
    return files.map((f) => ({ originSelectionRange: origin, targetUri: vscode.Uri.file(f), targetRange: ZERO, targetSelectionRange: ZERO }));
  }
}

class RequireLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const req = parseRequire(document.lineAt(i).text);
      if (!req || req.spec === '') continue;
      const link = new vscode.DocumentLink(new vscode.Range(i, req.start, i, req.end));
      link.tooltip = 'Open required file';
      links.push(link);
    }
    return links;
  }

  async resolveDocumentLink(link: vscode.DocumentLink): Promise<vscode.DocumentLink | undefined> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !link.range) return undefined;
    const spec = doc.getText(link.range);
    const files = await resolveFor(doc, spec);
    if (files.length === 0) return undefined;
    link.target = vscode.Uri.file(files[0]);
    return link;
  }
}

export function registerRequireNavigation(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentFilter[] = [{ scheme: 'file', language: 'crystal' }];
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new RequireDefinitionProvider()),
    vscode.languages.registerDocumentLinkProvider(selector, new RequireLinkProvider()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('crystal.compiler')) resetRequireCaches();
    }),
  );
}
