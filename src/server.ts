import * as vscode from 'vscode';
import { execFile } from 'child_process';

export interface ResolvedServer {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Returns true when `command` can be spawned (even if it exits non-zero for the probe flag). */
function canSpawn(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(command, ['--version'], { timeout: 8000 }, (err) => {
      if (!err) return resolve(true);
      const code = (err as NodeJS.ErrnoException).code;
      resolve(code !== 'ENOENT' && code !== 'EACCES');
    });
    child.on('error', () => resolve(false));
  });
}

export async function resolveServer(): Promise<ResolvedServer | undefined> {
  const cfg = vscode.workspace.getConfiguration('crystal');
  const command = (cfg.get<string>('server.path') || 'crystalline').trim();
  if (!(await canSpawn(command))) return undefined;
  return {
    command,
    args: cfg.get<string[]>('server.args', []),
    env: { ...process.env, ...cfg.get<Record<string, string>>('server.env', {}) },
  };
}

export async function explainMissingServer(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Crystal language server not found. Install crystalline (https://github.com/elbywan/crystalline) or point "crystal.server.path" at another LSP server. Basic text-based navigation stays available.',
    'Open Settings',
    'Installation Guide',
  );
  if (choice === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'crystal.server');
  } else if (choice === 'Installation Guide') {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/elbywan/crystalline#installation'));
  }
}
