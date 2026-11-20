/**
 * Lightweight Crystal lexer helpers shared by the built-in fallback providers.
 * No dependency on the `vscode` module so it can be unit-tested with plain node.
 */

const VALUE_PRECEDERS = new Set('(,=[{;!&|?:~<>+-*%^'.split(''));
const KEYWORD_BEFORE_VALUE =
  /\b(?:when|if|unless|while|until|then|return|puts|print|p|pp|in|else|elsif|yield|case)\s*$/;

const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * Replaces the content of comments, strings, char literals, regexes, percent literals and heredoc
 * bodies with spaces (keeping newlines and all offsets intact). Code inside `#{...}` interpolation
 * is preserved.
 */
export function maskText(text: string): string {
  const n = text.length;
  const out = text.split('');
  const pendingHeredocs: string[] = [];

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  const valuePosition = (i: number): boolean => {
    let k = i - 1;
    while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
    if (k < 0 || text[k] === '\n') return true;
    if (VALUE_PRECEDERS.has(text[k])) return true;
    const lineStart = text.lastIndexOf('\n', k) + 1;
    return KEYWORD_BEFORE_VALUE.test(text.slice(lineStart, k + 1));
  };

  const closesOnLine = (from: number, close: string): boolean => {
    for (let k = from; k < n && text[k] !== '\n'; k++) {
      if (text[k] === '\\') {
        k++;
        continue;
      }
      if (text[k] === close) return true;
    }
    return false;
  };

  const consumeHeredocs = (start: number): number => {
    let i = start;
    while (pendingHeredocs.length > 0) {
      const id = pendingHeredocs.shift()!;
      let found = false;
      while (i < n && !found) {
        let e = text.indexOf('\n', i);
        if (e < 0) e = n;
        found = text.slice(i, e).trim() === id;
        blank(i, e);
        i = Math.min(e + 1, n);
      }
      if (!found) break;
    }
    pendingHeredocs.length = 0;
    return i;
  };

  // Scans a delimited literal body starting just after the opening delimiter. Returns the index
  // just after the closing delimiter.
  const scanDelimited = (start: number, open: string, close: string, interpolate: boolean): number => {
    let i = start;
    let segStart = start;
    let depth = 1;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (interpolate && c === '#' && text[i + 1] === '{') {
        blank(segStart, i + 2);
        const after = scanCode(i + 2, true);
        segStart = after;
        i = after;
        continue;
      }
      if (open !== close && c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          blank(segStart, i + 1);
          return i + 1;
        }
      }
      i++;
    }
    blank(segStart, n);
    return n;
  };

  const skipRegexFlags = (i: number): number => {
    while (i < n && /[imx]/.test(text[i])) i++;
    return i;
  };

  const scanCode = (start: number, interpolation: boolean): number => {
    let i = start;
    let braces = 0;
    while (i < n) {
      const c = text[i];

      if (c === '\n') {
        i++;
        if (pendingHeredocs.length > 0) i = consumeHeredocs(i);
        continue;
      }
      if (c === '#') {
        let e = text.indexOf('\n', i);
        if (e < 0) e = n;
        blank(i, e);
        i = e;
        continue;
      }
      if (interpolation) {
        if (c === '{') braces++;
        else if (c === '}') {
          if (braces === 0) return i + 1;
          braces--;
        }
      }
      if (c === '"' || c === '`') {
        blank(i, i + 1);
        i = scanDelimited(i + 1, c, c, true);
        continue;
      }
      if (c === "'") {
        const m = /^'(?:\\(?:u\{[0-9a-fA-F ]+\}|u[0-9a-fA-F]{4}|.)|[^\\'])'/.exec(text.slice(i, i + 16));
        if (m) {
          blank(i, i + m[0].length);
          i += m[0].length;
        } else {
          i++;
        }
        continue;
      }
      if (c === ':' && text[i + 1] === '"' && text[i - 1] !== ':') {
        blank(i, i + 2);
        i = scanDelimited(i + 2, '"', '"', true);
        continue;
      }
      if (c === '/' && text[i + 1] !== ' ' && text[i + 1] !== '=' && text[i + 1] !== '/' && valuePosition(i) && closesOnLine(i + 1, '/')) {
        blank(i, i + 1);
        i = skipRegexFlags(scanDelimited(i + 1, '/', '/', true));
        continue;
      }
      if (c === '%') {
        const m = /^%([qQwirx]?)([(\[{<|])/.exec(text.slice(i, i + 3));
        if (m && (m[1] !== '' || valuePosition(i))) {
          const open = m[2];
          const close = CLOSERS[open] ?? open;
          const interpolate = m[1] === '' || m[1] === 'Q' || m[1] === 'r' || m[1] === 'x';
          blank(i, i + m[0].length);
          i = scanDelimited(i + m[0].length, open, close, interpolate);
          if (m[1] === 'r') i = skipRegexFlags(i);
          continue;
        }
      }
      if (c === '<' && text[i + 1] === '<' && text[i + 2] === '-') {
        const m = /^<<-(['"]?)([A-Za-z_]\w*)\1/.exec(text.slice(i, i + 80));
        if (m) {
          pendingHeredocs.push(m[2]);
          blank(i, i + m[0].length);
          i += m[0].length;
          continue;
        }
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return out.join('');
}

export function maskLines(text: string): string[] {
  return maskText(text).split('\n');
}

export interface Segment {
  text: string;
  start: number;
}

/** Splits `s` on top-level occurrences of `sep` (ignores separators nested in (), [] or {}). */
export function splitTopLevel(s: string, sep = ','): Segment[] {
  const parts: Segment[] = [];
  let depth = 0;
  let segStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push({ text: s.slice(segStart, i), start: segStart });
      segStart = i + 1;
    }
  }
  const last = s.slice(segStart);
  if (last.trim() !== '' || parts.length > 0) parts.push({ text: last, start: segStart });
  return parts;
}

/** Index of the `)` matching the `(` at `open`, or -1. Operates on masked text. */
export function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export const KEYWORDS = new Set([
  'abstract', 'alias', 'annotation', 'as', 'asm', 'begin', 'break', 'case', 'class', 'def', 'do', 'else', 'elsif',
  'end', 'ensure', 'enum', 'extend', 'false', 'for', 'fun', 'if', 'in', 'include', 'instance_sizeof', 'is_a?', 'lib',
  'macro', 'module', 'next', 'nil', 'nil?', 'of', 'out', 'pointerof', 'previous_def', 'private', 'protected', 'require',
  'rescue', 'responds_to?', 'return', 'select', 'self', 'sizeof', 'struct', 'super', 'then', 'true', 'type', 'typeof',
  'uninitialized', 'union', 'unless', 'until', 'verbatim', 'when', 'while', 'with', 'yield', 'alignof', 'offsetof',
  'instance_alignof',
]);
