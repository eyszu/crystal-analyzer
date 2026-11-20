import * as vscode from 'vscode';
import { maskText } from './scanner';

/**
 * Text-based navigation fallback (go to definition / implementation / find references).
 * Only registered when the language server is missing or does not advertise the capability.
 * It matches by name, so it cannot tell overloads or same-named methods on different types apart.
 */

interface Decl {
  name: string;
  line: number;
  col: number;
  abstract: boolean;
  kind: 'def' | 'type' | 'macro' | 'const' | 'other';
}

interface FileInfo {
  uri: vscode.Uri;
  masked: string[];
  decls: Decl[];
  subtypes: Array<{ parent: string; line: number; col: number; name: string }>;
}

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1_500_000;

const DECL_PATTERNS: Array<{ re: RegExp; kind: Decl['kind'] }> = [
  { re: /^(\s*)((?:(?:abstract|private|protected)\s+)*)def\s+(?:self\.|[A-Z]\w*(?:::[A-Z]\w*)*\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'def' },
  { re: /^(\s*)((?:(?:abstract|private|protected)\s+)*)(?:class|struct|module|enum|lib|annotation)\s+(?:(?:::)?[A-Z]\w*::)*([A-Z]\w*)/, kind: 'type' },
  { re: /^(\s*)()macro\s+([a-z_]\w*[?!]?)/, kind: 'macro' },
  { re: /^(\s*)()fun\s+([a-z_]\w*)/, kind: 'def' },
  { re: /^(\s*)()alias\s+([A-Z]\w*)/, kind: 'type' },
  { re: /^(\s*)()record\s+([A-Z]\w*)/, kind: 'type' },
  { re: /^(\s*)()([A-Z][A-Z0-9_]*)\s*=(?![=~>])/, kind: 'const' },
];
const ACCESSOR_RE = /^\s*(?:(?:private|protected)\s+)?(?:class_)?(?:getter|setter|property)[?!]?\s+(.*)$/;

export class WorkspaceIndex implements vscode.Disposable {
  private files = new Map<string, FileInfo>();
  private dirty = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private populated = false;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cr');
    const invalidate = (uri: vscode.Uri): void => {
      this.dirty.add(uri.toString());
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(invalidate),
      watcher.onDidCreate(invalidate),
      watcher.onDidDelete((uri) => {
        this.files.delete(uri.toString());
        this.dirty.delete(uri.toString());
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'crystal') invalidate(e.document.uri);
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.files.clear();
  }

  private async load(uri: vscode.Uri): Promise<FileInfo | undefined> {
    const key = uri.toString();
    const cached = this.files.get(key);
    if (cached && !this.dirty.has(key)) return cached;
    let text: string;
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (open) text = open.getText();
      else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.byteLength > MAX_FILE_BYTES) return undefined;
        text = Buffer.from(bytes).toString('utf8');
      }
    } catch {
      return undefined;
    }
    const info = indexText(uri, text);
    this.files.set(key, info);
    this.dirty.delete(key);
    return info;
  }

  private async all(): Promise<FileInfo[]> {
    const uris = await vscode.workspace.findFiles('**/*.cr', '**/{node_modules,.git,.crystal}/**', MAX_FILES);
    const infos = await Promise.all(uris.map((u) => this.load(u)));
    this.populated = true;
    return infos.filter((i): i is FileInfo => !!i);
  }

  async findDeclarations(name: string, near: vscode.Uri): Promise<Array<{ info: FileInfo; decl: Decl }>> {
    const result: Array<{ info: FileInfo; decl: Decl }> = [];
    for (const info of await this.all()) {
      for (const decl of info.decls) if (decl.name === name) result.push({ info, decl });
    }
    const rank = (u: vscode.Uri): number => (u.toString() === near.toString() ? 0 : /[\\/]lib[\\/]/.test(u.fsPath) ? 2 : 1);
    result.sort((a, b) => rank(a.info.uri) - rank(b.info.uri));
    return result;
  }

  async findSubtypes(name: string): Promise<vscode.Location[]> {
    const out: vscode.Location[] = [];
    for (const info of await this.all()) {
      for (const s of info.subtypes) {
        if (s.parent === name) out.push(new vscode.Location(info.uri, new vscode.Position(s.line, s.col)));
      }
    }
    return out;
  }

  async findReferences(name: string, includeDeclaration: boolean): Promise<vscode.Location[]> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w@$])${escaped}(?![\\w?!])`, 'g');
    const out: vscode.Location[] = [];
    for (const info of await this.all()) {
      const declPositions = new Set(info.decls.filter((d) => d.name === name).map((d) => `${d.line}:${d.col}`));
      info.masked.forEach((line, li) => {
        for (const m of line.matchAll(re)) {
          const col = m.index ?? 0;
          if (!includeDeclaration && declPositions.has(`${li}:${col}`)) continue;
          out.push(new vscode.Location(info.uri, new vscode.Range(li, col, li, col + name.length)));
        }
      });
      if (out.length > 5000) break;
    }
    return out;
  }

  get ready(): boolean {
    return this.populated;
  }
}

function indexText(uri: vscode.Uri, text: string): FileInfo {
  const masked = maskText(text).split('\n');
  const decls: Decl[] = [];
  const subtypes: FileInfo['subtypes'] = [];
  const typeStack: Array<{ name: string; indent: number }> = [];

  masked.forEach((line, li) => {
    if (line.trim() === '') return;
    const indent = line.length - line.trimStart().length;
    while (typeStack.length > 0 && typeStack[typeStack.length - 1].indent >= indent && /^\s*end\b/.test(line)) {
      typeStack.pop();
      break;
    }
    for (const { re, kind } of DECL_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[3];
      const col = m[0].length - name.length;
      decls.push({ name, line: li, col, abstract: (m[2] ?? '').includes('abstract'), kind });
      if (kind === 'type') {
        typeStack.push({ name, indent });
        const inh = /<\s*(?:(?:::)?[A-Z]\w*::)*([A-Z]\w*)/.exec(line.slice(m[0].length));
        if (inh) subtypes.push({ parent: inh[1], line: li, col, name });
      }
      break;
    }
    const inc = /^\s*(?:include|extend)\s+(?:(?:::)?[A-Z]\w*::)*([A-Z]\w*)/.exec(line);
    if (inc && typeStack.length > 0) {
      const owner = typeStack[typeStack.length - 1];
      const ownerDecl = [...decls].reverse().find((d) => d.kind === 'type' && d.name === owner.name);
      if (ownerDecl) subtypes.push({ parent: inc[1], line: ownerDecl.line, col: ownerDecl.col, name: owner.name });
    }
    const acc = ACCESSOR_RE.exec(line);
    if (acc) {
      const base = line.length - acc[1].length;
      for (const m of acc[1].matchAll(/(?:^|,)\s*([a-z_]\w*[?!]?)/g)) {
        const name = m[1];
        decls.push({ name, line: li, col: base + (m.index ?? 0) + m[0].indexOf(name), abstract: false, kind: 'other' });
      }
    }
  });
  return { uri, masked, decls, subtypes };
}

function wordAt(document: vscode.TextDocument, position: vscode.Position): { word: string; range: vscode.Range } | undefined {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*[?!]?/);
  if (!range) return undefined;
  return { word: document.getText(range), range };
}

function toLocation(info: FileInfo, decl: Decl): vscode.Location {
  return new vscode.Location(info.uri, new vscode.Range(decl.line, decl.col, decl.line, decl.col + decl.name.length));
}

export class FallbackDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: WorkspaceIndex) {}
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
    const w = wordAt(document, position);
    if (!w) return undefined;
    // `foo=`-style setters and `?`/`!` are part of the name; also try the bare name for getters.
    const decls = await this.index.findDeclarations(w.word, document.uri);
    const picked = decls.filter((d) => !(d.decl.line === position.line && d.info.uri.toString() === document.uri.toString() && d.decl.col === w.range.start.character));
    return (picked.length > 0 ? picked : decls).slice(0, 25).map((d) => toLocation(d.info, d.decl));
  }
}

export class FallbackImplementationProvider implements vscode.ImplementationProvider {
  constructor(private readonly index: WorkspaceIndex) {}
  async provideImplementation(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
    const w = wordAt(document, position);
    if (!w) return undefined;
    if (/^[A-Z]/.test(w.word)) return this.index.findSubtypes(w.word);
    const decls = await this.index.findDeclarations(w.word, document.uri);
    return decls.filter((d) => d.decl.kind === 'def' && !d.decl.abstract).slice(0, 50).map((d) => toLocation(d.info, d.decl));
  }
}

export class FallbackReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly index: WorkspaceIndex) {}
  async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[] | undefined> {
    const w = wordAt(document, position);
    if (!w) return undefined;
    return this.index.findReferences(w.word, context.includeDeclaration);
  }
}
