import * as vscode from 'vscode';
import { maskText, matchingParen, splitTopLevel } from './scanner';

/**
 * Built-in, scanner-based inlay hints. Used only when the language server does not provide inlay
 * hints (or when forced via `crystal.inlayHints.fallback = "always"`).
 *
 * - Variable types: only where the type is evident from the right-hand side (literals, `Foo.new`).
 * - Parameter names: resolves the callee through the *definition provider* (so it works with any
 *   server or with the text-based fallback) and reads the parameter names from the `def` line.
 *
 * Chained-call return types need real type inference and are left to the language server.
 */

const DEF_HEADER_RE = /^\s*(?:(?:abstract|private|protected)\s+)*(?:def|macro|fun)\b/;
const NOT_CALLS = new Set([
  'if', 'unless', 'while', 'until', 'case', 'when', 'elsif', 'return', 'yield', 'typeof', 'sizeof', 'instance_sizeof',
  'pointerof', 'alignof', 'offsetof', 'as', 'as?', 'is_a?', 'nil?', 'responds_to?', 'super', 'previous_def', 'in',
  'rescue', 'puts', 'print', 'p', 'pp',
]);
const INT_SUFFIX: Record<string, string> = {
  i8: 'Int8', i16: 'Int16', i32: 'Int32', i64: 'Int64', i128: 'Int128',
  u8: 'UInt8', u16: 'UInt16', u32: 'UInt32', u64: 'UInt64', u128: 'UInt128',
};

interface ParamInfo {
  labels: string[]; // positional parameter names in order (stops before any splat)
}

export class CrystalInlayHintsProvider implements vscode.InlayHintsProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.changed.event;

  private defCache = new Map<string, ParamInfo | null>();
  private resolveCache = new Map<string, { uri: vscode.Uri; line: number } | null>();

  refresh(): void {
    this.defCache.clear();
    this.resolveCache.clear();
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const cfg = vscode.workspace.getConfiguration('crystal.inlayHints');
    const wantTypes = cfg.get<boolean>('variableTypes', true);
    const paramMode = cfg.get<'none' | 'literals' | 'all'>('parameterNames', 'literals');
    if (!wantTypes && paramMode === 'none') return [];

    const raw = document.getText().split('\n');
    const masked = maskText(document.getText()).split('\n');
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.min(raw.length - 1, range.end.line, startLine + 600);

    const hints: vscode.InlayHint[] = [];

    if (wantTypes) this.variableTypeHints(raw, masked, startLine, endLine, hints);

    if (paramMode !== 'none') {
      const jobs: Array<() => Promise<void>> = [];
      for (let li = startLine; li <= endLine; li++) {
        const ml = masked[li];
        if (ml === undefined || DEF_HEADER_RE.test(ml)) continue;
        for (const m of ml.matchAll(/(?<![\w@$])([a-z_]\w*[?!]?)\(/g)) {
          const name = m[1];
          if (NOT_CALLS.has(name)) continue;
          const nameCol = m.index ?? 0;
          const open = nameCol + name.length;
          const close = matchingParen(ml, open);
          if (close < 0) continue;
          const args = splitTopLevel(ml.slice(open + 1, close)).filter((a) => a.text.trim() !== '');
          if (args.length === 0) continue;
          const rawLine = raw[li];
          const argBase = open + 1;
          const positional = args.filter((a) => !/^\s*(?:&|\*)/.test(a.text) && !/^\s*[a-z_]\w*[?]?:(?!:)/.test(a.text));
          if (positional.length === 0) continue;
          if (paramMode === 'literals' && !positional.some((a) => isLiteral(rawLine.slice(argBase + a.start, argBase + a.start + a.text.length).trim()))) {
            continue;
          }
          jobs.push(async () => {
            if (token.isCancellationRequested) return;
            const info = await this.paramsFor(document, li, nameCol);
            if (!info) return;
            positional.forEach((a, idx) => {
              const label = info.labels[idx];
              if (!label) return;
              const argText = rawLine.slice(argBase + a.start, argBase + a.start + a.text.length);
              const trimmed = argText.trim();
              if (trimmed === label || trimmed === '') return;
              if (paramMode === 'literals' && !isLiteral(trimmed)) return;
              const col = argBase + a.start + (argText.length - argText.trimStart().length);
              const hint = new vscode.InlayHint(new vscode.Position(li, col), `${label}:`, vscode.InlayHintKind.Parameter);
              hint.paddingRight = true;
              hints.push(hint);
            });
          });
        }
      }
      await pool(jobs, 6);
    }

    if (this.defCache.size > 3000) this.defCache.clear();
    if (this.resolveCache.size > 3000) this.resolveCache.clear();
    return hints;
  }

  // --- variable type hints --------------------------------------------------------------------

  private variableTypeHints(raw: string[], masked: string[], startLine: number, endLine: number, out: vscode.InlayHint[]): void {
    // Start from the enclosing def so "first assignment" is judged within one method body.
    let scanStart = startLine;
    for (let i = startLine; i >= Math.max(0, startLine - 800); i--) {
      scanStart = i;
      if (DEF_HEADER_RE.test(masked[i] ?? '')) break;
    }
    let seen = new Set<string>();
    for (let li = scanStart; li <= endLine; li++) {
      const ml = masked[li] ?? '';
      if (DEF_HEADER_RE.test(ml)) {
        seen = new Set<string>();
        continue;
      }
      const m = /^(\s*)([a-z_]\w*)(\s*)=(?![=~>])\s*/.exec(ml);
      if (!m) continue;
      const name = m[2];
      const firstAssignment = !seen.has(name);
      seen.add(name);
      if (!firstAssignment || li < startLine) continue;
      const rhsStart = m[0].length;
      const rhs = raw[li].slice(rhsStart).replace(/\s+#.*$/, '').trim();
      const type = literalType(rhs);
      if (!type) continue;
      const col = m[1].length + name.length;
      const hint = new vscode.InlayHint(new vscode.Position(li, col), `: ${type}`, vscode.InlayHintKind.Type);
      hint.paddingLeft = false;
      out.push(hint);
    }
  }

  // --- parameter name resolution --------------------------------------------------------------

  private async paramsFor(document: vscode.TextDocument, line: number, col: number): Promise<ParamInfo | null> {
    const key = `${document.uri.toString()}@${document.version}:${line}:${col}`;
    let target = this.resolveCache.get(key);
    if (target === undefined) {
      target = null;
      try {
        const res = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeDefinitionProvider',
          document.uri,
          new vscode.Position(line, col),
        );
        const first = res?.[0];
        if (first) {
          if ('targetUri' in first) target = { uri: first.targetUri, line: (first.targetSelectionRange ?? first.targetRange).start.line };
          else target = { uri: first.uri, line: first.range.start.line };
        }
      } catch {
        target = null;
      }
      this.resolveCache.set(key, target);
    }
    if (!target) return null;

    const defKey = `${target.uri.toString()}#${target.line}`;
    const cached = this.defCache.get(defKey);
    if (cached !== undefined) return cached;
    let info: ParamInfo | null = null;
    try {
      const doc = await vscode.workspace.openTextDocument(target.uri);
      info = parseDefParams(doc, target.line);
    } catch {
      info = null;
    }
    this.defCache.set(defKey, info);
    return info;
  }
}

function parseDefParams(doc: vscode.TextDocument, line: number): ParamInfo | null {
  let header = '';
  const last = Math.min(doc.lineCount, line + 15);
  for (let l = line; l < last; l++) {
    header += doc.lineAt(l).text + '\n';
    const open = header.indexOf('(');
    if (open >= 0 && matchingParen(header, open) >= 0) break;
    if (open < 0 && /\S/.test(header) && l > line) break;
  }
  const masked = maskText(header);
  const m = /\b(?:def|macro|fun)\s+(?:self\.|[A-Z]\w*(?:::[A-Z]\w*)*\.)?[^\s(;]+\s*(\()?/.exec(masked);
  if (!m) return null;
  if (!m[1]) return { labels: [] };
  const open = m.index + m[0].length - 1;
  const close = matchingParen(masked, open);
  if (close < 0) return null;
  const labels: string[] = [];
  for (const seg of splitTopLevel(masked.slice(open + 1, close))) {
    const t = seg.text.trim();
    if (t === '') continue;
    if (t.startsWith('*') || t.startsWith('&')) break; // splat / block: nothing positional after this
    const pm = /^(?:@{1,2})?([a-z_]\w*[?]?)/.exec(t);
    if (!pm) break;
    labels.push(pm[1]);
  }
  return { labels };
}

// --- literal helpers -------------------------------------------------------------------------

const LITERAL_RE =
  /^(?:-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:_?[iuf]\d+)?|true|false|nil|:[A-Za-z_]\w*[?!]?|:"(?:[^"\\]|\\.)*"|'(?:\\.|[^\\'])+'|"(?:[^"\\]|\\.)*"|%[wiqQ]?[(\[{<].*[)\]}>]|\[.*\]|\{.*\})$/s;

function isLiteral(text: string): boolean {
  return LITERAL_RE.test(text);
}

function scalarType(text: string): string | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^-?\d[\d_]*(?:_?([iu](?:8|16|32|64|128)))?$/.exec(text))) return m[1] ? INT_SUFFIX[m[1]] : 'Int32';
  if ((m = /^-?\d[\d_]*(?:\.\d[\d_]*(?:[eE][+-]?\d+)?|[eE][+-]?\d+)(?:_?f(32|64))?$/.exec(text))) return m[1] === '32' ? 'Float32' : 'Float64';
  if (/^-?\d[\d_]*_?f32$/.test(text)) return 'Float32';
  if (/^-?\d[\d_]*_?f64$/.test(text)) return 'Float64';
  if (/^(?:true|false)$/.test(text)) return 'Bool';
  if (text === 'nil') return 'Nil';
  if (/^"(?:[^"\\]|\\.)*"$/.test(text) || /^%[qQ]?\(.*\)$/.test(text)) return 'String';
  if (/^'(?:\\.|[^\\'])+'$/.test(text)) return 'Char';
  if (/^:(?:[A-Za-z_]\w*[?!]?|"(?:[^"\\]|\\.)*")$/.test(text)) return 'Symbol';
  return undefined;
}

function literalType(rhs: string): string | undefined {
  if (rhs === '') return undefined;
  const scalar = scalarType(rhs);
  if (scalar) return scalar;

  // Foo.new / Foo(T).new / Foo::Bar.new(args)
  const nm = /^((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*)(\([^()]*(?:\([^()]*\)[^()]*)*\))?\.new\b/.exec(rhs);
  if (nm) {
    const rest = rhs.slice(nm[0].length);
    if (rest === '') return nm[1].replace(/^::/, '') + (nm[2] ?? '');
    if (rest.startsWith('(')) {
      const close = matchingParen(rest, 0);
      if (close === rest.length - 1) return nm[1].replace(/^::/, '') + (nm[2] ?? '');
    }
    return undefined;
  }

  let m: RegExpExecArray | null;
  if ((m = /^\[\]\s+of\s+(.+)$/.exec(rhs))) return `Array(${m[1].trim()})`;
  if ((m = /^\{\}\s+of\s+(.+?)\s*=>\s*(.+)$/.exec(rhs))) return `Hash(${m[1].trim()}, ${m[2].trim()})`;

  if (rhs.startsWith('[') && rhs.endsWith(']')) {
    const items = splitTopLevel(rhs.slice(1, -1)).map((s) => s.text.trim()).filter((s) => s !== '');
    if (items.length === 0) return undefined;
    const types = items.map(scalarType);
    if (types.some((t) => !t) || new Set(types).size !== 1) return undefined;
    return `Array(${types[0]})`;
  }

  if (rhs.startsWith('{') && rhs.endsWith('}')) {
    const items = splitTopLevel(rhs.slice(1, -1)).map((s) => s.text.trim()).filter((s) => s !== '');
    if (items.length === 0) return undefined;
    if (items.every((s) => s.includes('=>'))) {
      const ks: Array<string | undefined> = [];
      const vs: Array<string | undefined> = [];
      for (const item of items) {
        const idx = item.indexOf('=>');
        ks.push(scalarType(item.slice(0, idx).trim()));
        vs.push(scalarType(item.slice(idx + 2).trim()));
      }
      if (ks.some((t) => !t) || vs.some((t) => !t) || new Set(ks).size !== 1 || new Set(vs).size !== 1) return undefined;
      return `Hash(${ks[0]}, ${vs[0]})`;
    }
    if (items.some((s) => /^[a-z_]\w*:\s/.test(s) || s.includes('=>'))) return undefined; // named tuple / mixed
    const types = items.map(scalarType);
    if (types.some((t) => !t)) return undefined;
    return `Tuple(${types.join(', ')})`;
  }
  return undefined;
}

async function pool(jobs: Array<() => Promise<void>>, size: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  });
  await Promise.all(workers);
}
