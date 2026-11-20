import * as vscode from 'vscode';
import { TOKEN_MODIFIERS, TOKEN_TYPES, tokenize } from './semanticTokenizer';

export const legend = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

const MAX_LINES = 30000;

export class CrystalSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(legend);
    if (document.lineCount > MAX_LINES || token.isCancellationRequested) return builder.build();
    for (const t of tokenize(document.getText())) {
      builder.push(t.line, t.start, t.length, t.type, t.mods);
    }
    return builder.build();
  }
}
