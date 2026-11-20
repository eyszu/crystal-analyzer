import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerCapabilities, ServerOptions } from 'vscode-languageclient/node';
import { registerCommands } from './commands';
import { registerRequireNavigation } from './requireLinks';
import { CrystalInlayHintsProvider } from './inlayFallback';
import { CrystalSemanticTokensProvider, legend } from './semanticFallback';
import { explainMissingServer, resolveServer } from './server';
import {
  FallbackDefinitionProvider,
  FallbackImplementationProvider,
  FallbackReferenceProvider,
  WorkspaceIndex,
} from './workspaceIndex';

const SELECTOR: vscode.DocumentFilter[] = [
  { scheme: 'file', language: 'crystal' },
  { scheme: 'untitled', language: 'crystal' },
];

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel;
let traceChannel: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let index: WorkspaceIndex | undefined;
let fallbacks: vscode.Disposable[] = [];
let inlayProvider: CrystalInlayHintsProvider | undefined;
let lastCapabilities: ServerCapabilities | undefined;
let serverRunning = false;
let missingServerNotified = false;

function setStatus(text: string, tooltip: string, warn = false): void {
  status.text = text;
  status.tooltip = tooltip;
  status.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  status.show();
}

function disposeFallbacks(): void {
  fallbacks.forEach((d) => d.dispose());
  fallbacks = [];
  inlayProvider?.dispose();
  inlayProvider = undefined;
}

/**
 * Registers built-in providers only for what the running server does not offer.
 * With no server at all, navigation falls back to the text-based workspace index.
 */
function registerFallbacks(caps: ServerCapabilities | undefined): void {
  disposeFallbacks();
  const cfg = vscode.workspace.getConfiguration('crystal');
  const have = (key: keyof ServerCapabilities): boolean => !!caps && !!caps[key];

  // Navigation
  index ??= new WorkspaceIndex();
  const idx = index;
  if (!have('definitionProvider')) fallbacks.push(vscode.languages.registerDefinitionProvider(SELECTOR, new FallbackDefinitionProvider(idx)));
  if (!have('implementationProvider')) fallbacks.push(vscode.languages.registerImplementationProvider(SELECTOR, new FallbackImplementationProvider(idx)));
  if (!have('referencesProvider')) fallbacks.push(vscode.languages.registerReferenceProvider(SELECTOR, new FallbackReferenceProvider(idx)));

  // Semantic tokens
  const semantic = cfg.get<'auto' | 'always' | 'never'>('semanticTokens.fallback', 'auto');
  if (semantic === 'always' || (semantic === 'auto' && !have('semanticTokensProvider'))) {
    fallbacks.push(vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, new CrystalSemanticTokensProvider(), legend));
  }

  // Inlay hints
  const hints = cfg.get<'auto' | 'always' | 'never'>('inlayHints.fallback', 'auto');
  if (hints === 'always' || (hints === 'auto' && !have('inlayHintProvider'))) {
    inlayProvider = new CrystalInlayHintsProvider();
    fallbacks.push(vscode.languages.registerInlayHintsProvider(SELECTOR, inlayProvider));
  }
}

function describeCapabilities(caps: ServerCapabilities): string {
  const rows: Array<[string, boolean]> = [
    ['completion', !!caps.completionProvider],
    ['hover', !!caps.hoverProvider],
    ['signature help', !!caps.signatureHelpProvider],
    ['definition', !!caps.definitionProvider],
    ['type definition', !!caps.typeDefinitionProvider],
    ['implementation', !!caps.implementationProvider],
    ['references', !!caps.referencesProvider],
    ['semantic tokens', !!caps.semanticTokensProvider],
    ['inlay hints', !!caps.inlayHintProvider],
  ];
  return rows.map(([name, ok]) => `${ok ? '✓' : '✗'} ${name}`).join('\n');
}

async function stopServer(): Promise<void> {
  const c = client;
  client = undefined;
  serverRunning = false;
  if (c) {
    try {
      await c.stop();
    } catch {
      /* already stopped */
    }
  }
}

async function startServer(): Promise<void> {
  await stopServer();
  lastCapabilities = undefined;
  const cfg = vscode.workspace.getConfiguration('crystal');

  if (!cfg.get<boolean>('server.enable', true)) {
    registerFallbacks(undefined);
    setStatus('$(circle-slash) Crystal', 'Language server disabled (crystal.server.enable). Using text-based fallbacks.', true);
    return;
  }

  setStatus('$(sync~spin) Crystal', 'Starting Crystal language server…');
  const server = await resolveServer();
  if (!server) {
    registerFallbacks(undefined);
    setStatus('$(warning) Crystal', 'Language server not found. Using text-based fallbacks. Click for details.', true);
    if (!missingServerNotified) {
      missingServerNotified = true;
      void explainMissingServer();
    }
    return;
  }

  const exec = { command: server.command, args: server.args, options: { env: server.env, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath } };
  const serverOptions: ServerOptions = { run: exec, debug: exec };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'crystal' },
      { scheme: 'untitled', language: 'crystal' },
    ],
    outputChannel,
    traceOutputChannel: traceChannel,
    synchronize: {
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.cr'),
        vscode.workspace.createFileSystemWatcher('**/shard.{yml,lock}'),
      ],
    },
  };

  const newClient = new LanguageClient('crystal', 'Crystal Language Server', serverOptions, clientOptions);
  client = newClient;
  try {
    await newClient.start();
    serverRunning = true;
    lastCapabilities = newClient.initializeResult?.capabilities;
    registerFallbacks(lastCapabilities);
    setStatus('$(check) Crystal', `Crystal language server running (${server.command}).\n\n${lastCapabilities ? describeCapabilities(lastCapabilities) : ''}`);
  } catch (err) {
    serverRunning = false;
    client = undefined;
    registerFallbacks(undefined);
    setStatus('$(error) Crystal', `Language server failed to start: ${String(err)}`, true);
    void vscode.window.showErrorMessage(`Crystal language server failed to start: ${String(err)}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Crystal Language Server');
  traceChannel = vscode.window.createOutputChannel('Crystal Language Server Trace');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'crystal.showServerLog';
  context.subscriptions.push(outputChannel, traceChannel, status, { dispose: () => disposeFallbacks() }, { dispose: () => index?.dispose() });

  registerCommands(context);
  registerRequireNavigation(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('crystal.restartServer', async () => {
      missingServerNotified = false;
      await startServer();
    }),
    vscode.commands.registerCommand('crystal.showServerLog', () => outputChannel.show(true)),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('crystal.server') || e.affectsConfiguration('crystal.trace')) {
        await startServer();
      } else if (e.affectsConfiguration('crystal.semanticTokens') || e.affectsConfiguration('crystal.inlayHints.fallback')) {
        registerFallbacks(serverRunning ? lastCapabilities : undefined);
      } else if (e.affectsConfiguration('crystal.inlayHints')) {
        inlayProvider?.refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed?.document.languageId === 'crystal') status.show();
      else status.hide();
    }),
  );

  await startServer();
  if (vscode.window.activeTextEditor?.document.languageId !== 'crystal') status.hide();
}

export async function deactivate(): Promise<void> {
  await stopServer();
}
