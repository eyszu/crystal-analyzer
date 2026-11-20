import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';

const CODELLDB_ID = 'vadimcn.vscode-lldb';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('crystal');
}
function compiler(): string {
  return cfg().get<string>('compiler.path') || 'crystal';
}

function activeCrystalFile(): vscode.Uri | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'crystal') {
    void vscode.window.showWarningMessage('Open a Crystal (.cr) file first.');
    return undefined;
  }
  return ed.document.uri;
}

function folderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];
}

function runTask(label: string, command: string, args: string[], folder?: vscode.WorkspaceFolder, group?: vscode.TaskGroup): Thenable<vscode.TaskExecution> {
  const exec = new vscode.ShellExecution(command, args, { cwd: folder?.uri.fsPath });
  const task = new vscode.Task({ type: 'crystal', command: label }, folder ?? vscode.TaskScope.Workspace, `crystal ${label}`, 'crystal', exec);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: true };
  if (group) task.group = group;
  return vscode.tasks.executeTask(task);
}

// --- run / spec -------------------------------------------------------------------------------

async function runFile(uri?: vscode.Uri): Promise<void> {
  const file = uri ?? activeCrystalFile();
  if (!file) return;
  await vscode.window.activeTextEditor?.document.save();
  await runTask('run', compiler(), ['run', file.fsPath], folderFor(file));
}

async function runSpec(uri: vscode.Uri | undefined, line?: number): Promise<void> {
  const file = uri ?? activeCrystalFile();
  if (!file) return;
  const folder = folderFor(file);
  const rel = folder ? path.relative(folder.uri.fsPath, file.fsPath) : file.fsPath;
  const target = line ? `${rel}:${line}` : rel;
  await vscode.workspace.saveAll(false);
  await runTask('spec', compiler(), ['spec', target], folder, vscode.TaskGroup.Test);
}

async function runAllSpecs(): Promise<void> {
  await vscode.workspace.saveAll(false);
  await runTask('spec', compiler(), ['spec'], folderFor(vscode.window.activeTextEditor?.document.uri), vscode.TaskGroup.Test);
}

async function formatFile(): Promise<void> {
  const file = activeCrystalFile();
  if (!file) return;
  await vscode.window.activeTextEditor?.document.save();
  await new Promise<void>((resolve) => {
    execFile(compiler(), ['tool', 'format', file.fsPath], { cwd: folderFor(file)?.uri.fsPath }, (err, _out, stderr) => {
      if (err) void vscode.window.showErrorMessage(`crystal tool format failed: ${stderr || err.message}`);
      resolve();
    });
  });
}

// --- debugging (CodeLLDB) -----------------------------------------------------------------------

async function ensureCodeLLDB(): Promise<boolean> {
  if (vscode.extensions.getExtension(CODELLDB_ID)) return true;
  const choice = await vscode.window.showInformationMessage(
    'Debugging Crystal programs needs the CodeLLDB extension.',
    'Install CodeLLDB',
  );
  if (choice === 'Install CodeLLDB') {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', CODELLDB_ID);
    void vscode.window.showInformationMessage('CodeLLDB installed. Run the debug command again.');
  }
  return false;
}

function build(source: string, out: string, flags: string[], cwd: string | undefined, log: vscode.OutputChannel): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['build', '--debug', '--no-color', ...flags, source, '-o', out];
    log.appendLine(`$ ${compiler()} ${args.join(' ')}`);
    execFile(compiler(), args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout) log.appendLine(stdout);
      if (stderr) log.appendLine(stderr);
      if (err) {
        log.show(true);
        void vscode.window.showErrorMessage('Crystal build failed. See the "Crystal Build" output.');
      }
      resolve(!err);
    });
  });
}

export interface CrystalDebugConfig extends vscode.DebugConfiguration {
  program?: string;
  args?: string[];
  cwd?: string;
  buildFlags?: string[];
  env?: Record<string, string>;
}

async function debugProgram(config: CrystalDebugConfig, log: vscode.OutputChannel): Promise<void> {
  if (!(await ensureCodeLLDB())) return;
  const program = config.program;
  if (!program) {
    void vscode.window.showErrorMessage('Crystal debug configuration needs a "program".');
    return;
  }
  const folder = folderFor(vscode.Uri.file(program));
  const cwd = config.cwd ?? folder?.uri.fsPath ?? path.dirname(program);
  let binary = program;

  if (program.endsWith('.cr')) {
    const outDir = path.join(os.tmpdir(), 'crystal-vscode-debug');
    fs.mkdirSync(outDir, { recursive: true });
    binary = path.join(outDir, path.basename(program, '.cr'));
    const flags = [...cfg().get<string[]>('debug.buildFlags', []), ...(config.buildFlags ?? [])];
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Building ${path.basename(program)} (debug)` },
      () => build(program, binary, flags, cwd, log),
    );
    if (!ok) return;
  }

  const lldbConfig: vscode.DebugConfiguration = {
    type: 'lldb',
    request: 'launch',
    name: config.name ?? `Crystal: ${path.basename(program)}`,
    program: binary,
    args: config.args ?? [],
    cwd,
    env: config.env,
    ...cfg().get<Record<string, unknown>>('debug.launchOverrides', {}),
  };
  await vscode.debug.startDebugging(folder, lldbConfig);
}

class CrystalDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(private readonly log: vscode.OutputChannel) {}

  resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration | undefined {
    if (!config.type && !config.request && !config.name) {
      const ed = vscode.window.activeTextEditor;
      if (ed?.document.languageId !== 'crystal') return undefined;
      return { type: 'crystal', request: 'launch', name: 'Debug Crystal file', program: '${file}', args: [], cwd: '${workspaceFolder}' };
    }
    return config;
  }

  resolveDebugConfigurationWithSubstitutedVariables(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): undefined {
    // Hand the session over to CodeLLDB once the program has been built; cancel this placeholder session.
    void debugProgram(config as CrystalDebugConfig, this.log);
    return undefined;
  }
}

// --- tasks ---------------------------------------------------------------------------------------

interface CrystalTaskDefinition extends vscode.TaskDefinition {
  command: 'build' | 'spec' | 'run' | 'install';
  file?: string;
  args?: string[];
}

function executionFor(def: CrystalTaskDefinition, folder?: vscode.WorkspaceFolder): vscode.ShellExecution | undefined {
  const options = { cwd: folder?.uri.fsPath };
  const extra = def.args ?? [];
  switch (def.command) {
    case 'build':
      return new vscode.ShellExecution('shards', ['build', ...extra], options);
    case 'install':
      return new vscode.ShellExecution('shards', ['install', ...extra], options);
    case 'spec':
      return new vscode.ShellExecution(compiler(), ['spec', ...(def.file ? [def.file] : []), ...extra], options);
    case 'run':
      return def.file ? new vscode.ShellExecution(compiler(), ['run', def.file, ...extra], options) : undefined;
    default:
      return undefined;
  }
}

class CrystalTaskProvider implements vscode.TaskProvider {
  async provideTasks(): Promise<vscode.Task[]> {
    const tasks: vscode.Task[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (!fs.existsSync(path.join(folder.uri.fsPath, 'shard.yml'))) continue;
      const make = (command: CrystalTaskDefinition['command'], group?: vscode.TaskGroup): vscode.Task => {
        const def: CrystalTaskDefinition = { type: 'crystal', command };
        const task = new vscode.Task(def, folder, command, 'crystal', executionFor(def, folder));
        if (group) task.group = group;
        return task;
      };
      tasks.push(make('build', vscode.TaskGroup.Build), make('spec', vscode.TaskGroup.Test), make('install'));
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as CrystalTaskDefinition;
    const folder = typeof task.scope === 'object' ? (task.scope as vscode.WorkspaceFolder) : vscode.workspace.workspaceFolders?.[0];
    const exec = executionFor(def, folder);
    if (!exec) return undefined;
    return new vscode.Task(def, task.scope ?? vscode.TaskScope.Workspace, task.name, 'crystal', exec);
  }
}

// --- spec code lenses ------------------------------------------------------------------------------

class SpecCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.endsWith('_spec.cr') || !cfg().get<boolean>('codeLens.specs', true)) return [];
    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      if (/^\s*(?:describe|context|it|pending)\b/.test(document.lineAt(i).text)) {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
            title: '$(play) Run',
            command: 'crystal.runSpecAtLine',
            arguments: [document.uri, i + 1],
          }),
        );
      }
    }
    return lenses;
  }
}

// --- registration ------------------------------------------------------------------------------------

export function registerCommands(context: vscode.ExtensionContext): void {
  const buildLog = vscode.window.createOutputChannel('Crystal Build');
  context.subscriptions.push(
    buildLog,
    vscode.commands.registerCommand('crystal.runFile', (uri?: vscode.Uri) => runFile(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('crystal.debugFile', async (uri?: vscode.Uri) => {
      const file = uri instanceof vscode.Uri ? uri : activeCrystalFile();
      if (file) await debugProgram({ type: 'crystal', request: 'launch', name: `Crystal: ${path.basename(file.fsPath)}`, program: file.fsPath }, buildLog);
    }),
    vscode.commands.registerCommand('crystal.runSpecFile', (uri?: vscode.Uri) => runSpec(uri instanceof vscode.Uri ? uri : undefined)),
    vscode.commands.registerCommand('crystal.runSpecAtLine', (uri?: vscode.Uri, line?: number) => {
      if (uri instanceof vscode.Uri && typeof line === 'number') return runSpec(uri, line);
      const ed = vscode.window.activeTextEditor;
      return runSpec(ed?.document.uri, ed ? ed.selection.active.line + 1 : undefined);
    }),
    vscode.commands.registerCommand('crystal.runAllSpecs', runAllSpecs),
    vscode.commands.registerCommand('crystal.formatFile', formatFile),
    vscode.debug.registerDebugConfigurationProvider('crystal', new CrystalDebugConfigurationProvider(buildLog)),
    vscode.tasks.registerTaskProvider('crystal', new CrystalTaskProvider()),
    vscode.languages.registerCodeLensProvider({ language: 'crystal' }, new SpecCodeLensProvider()),
  );
}
