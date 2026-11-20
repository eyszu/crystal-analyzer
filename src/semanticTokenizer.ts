/**
 * Scanner-based semantic tokenizer for Crystal. Pure functions, no `vscode` import.
 * It is a heuristic fallback used when the language server does not provide semantic tokens:
 * it knows declarations, parameters, locals, constants, instance variables and call shapes, but
 * not types, overloads or macro expansion.
 */
import { KEYWORDS, maskText, splitTopLevel } from './scanner';

export const TOKEN_TYPES = [
  'namespace', 'class', 'struct', 'enum', 'interface', 'typeParameter', 'parameter', 'variable', 'property',
  'function', 'method', 'macro', 'enumMember', 'decorator',
] as const;
export const TOKEN_MODIFIERS = ['declaration', 'static', 'readonly', 'defaultLibrary', 'abstract'] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

const TYPE_INDEX = Object.fromEntries(TOKEN_TYPES.map((t, i) => [t, i])) as Record<TokenType, number>;
export const MOD = { declaration: 1, static: 2, readonly: 4, defaultLibrary: 8, abstract: 16 } as const;

export interface Tok {
  line: number;
  start: number;
  length: number;
  type: number;
  mods: number;
  seq: number;
}

const STDLIB_STRUCTS = new Set([
  'Int8', 'Int16', 'Int32', 'Int64', 'Int128', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UInt128', 'Float32',
  'Float64', 'Bool', 'Char', 'Nil', 'Symbol', 'Tuple', 'NamedTuple', 'Pointer', 'Slice', 'StaticArray', 'Range',
  'Proc', 'Time', 'Path', 'BigInt', 'BigFloat', 'BigRational', 'BigDecimal', 'UUID', 'Enumerable::Chunk',
]);
const STDLIB_MODULES = new Set([
  'Comparable', 'Enumerable', 'Indexable', 'Iterable', 'Iterator', 'Colorize', 'Math', 'Signal', 'GC', 'Random',
  'JSON', 'YAML', 'HTTP', 'Crystal', 'Process', 'Benchmark', 'Spec', 'Log', 'CSV', 'XML',
]);
const STDLIB_CLASSES = new Set([
  'String', 'Array', 'Hash', 'Set', 'IO', 'File', 'Dir', 'Exception', 'Regex', 'Channel', 'Fiber', 'Mutex', 'Object',
  'Reference', 'Class', 'Struct', 'Value', 'Number', 'Int', 'Float', 'Deque', 'Socket', 'TCPSocket', 'TCPServer',
  'URI', 'Base64', 'Digest', 'Process', 'Thread', 'Atomic', 'Box', 'Errno', 'ArgumentError', 'IndexError', 'KeyError',
  'TypeCastError', 'NilAssertionError', 'RuntimeError', 'NotImplementedError', 'InvalidByteSequenceError',
]);
const STDLIB_CONSTANTS = new Set(['ARGV', 'ARGF', 'ENV', 'STDIN', 'STDOUT', 'STDERR', 'PROGRAM_NAME', 'VERSION']);
const STDLIB_FUNCTIONS = new Set([
  'puts', 'print', 'p', 'pp', 'printf', 'sprintf', 'gets', 'raise', 'loop', 'spawn', 'sleep', 'exit', 'abort',
  'at_exit', 'rand', 'srand', 'caller', 'with_color', 'read_line', 'system', 'assert', 'fail',
]);
const STDLIB_MACROS = new Set([
  'getter', 'setter', 'property', 'getter?', 'getter!', 'property?', 'property!', 'class_getter', 'class_setter',
  'class_property', 'record', 'delegate', 'forward_missing_to', 'def_equals', 'def_hash', 'def_equals_and_hash',
  'def_clone', 'debugger', 'pp!', 'p!', 'macro_missing', 'method_missing',
]);
const NOT_METHOD = new Set(['is_a?', 'nil?', 'responds_to?', 'as', 'as?', 'as!']);

const DECL_RE =
  /^\s*((?:(?:abstract|private|protected)\s+)*)(class|struct|module|enum|lib|annotation)\s+((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*)/;
const DEF_RE =
  /^(\s*)((?:(?:abstract|private|protected)\s+)*)def\s+(self\.|[A-Z]\w*(?:::[A-Z]\w*)*\.)?([A-Za-z_]\w*[?!=]?)/;
const MACRO_RE = /^(\s*)macro\s+([a-z_]\w*[?!]?)/;
const FUN_RE = /^\s*fun\s+([a-z_]\w*)/;
const ALIAS_RE = /^\s*alias\s+((?:::)?[A-Z]\w*)/;
const CONST_DECL_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=(?![=~>])/;
const ENUM_MEMBER_RE = /^\s*([A-Z]\w*)\s*(?:=.*)?$/;
const ASSIGN_RE = /^\s*([a-z_]\w*)\s*(?:\|\|=|&&=|<<=|>>=|[-+*/%|&^]=|=(?![=~>]))/;
const MULTI_ASSIGN_RE = /^\s*([a-z_]\w*(?:\s*,\s*\*?[a-z_]\w*)+)\s*=(?![=~>])/;
const COND_ASSIGN_RE = /\b(?:if|unless|while|until|elsif)\s+\(?\s*([a-z_]\w*)\s*=(?![=~>])/;
const BLOCK_PARAMS_RE = /(?:\bdo|\{)\s*\|([^|]*)\|/g;
const FOR_RE = /\bfor\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s+in\b/;
const RESCUE_RE = /\brescue\s+([a-z_]\w*)\s*(?::|$)/;
const ACCESSOR_RE = /^\s*(?:(?:private|protected)\s+)?(?:class_)?(?:getter|setter|property)[?!]?\s+(.*)$/;
const RECORD_RE = /^\s*record\s+([A-Z]\w*)/;
const INCLUDE_RE = /^\s*(?:include|extend)\s+/;
const ANNOTATION_RE = /@\[\s*((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*)/g;
const SYMBOL_RE = /(?<![:\w]):(?:[A-Za-z_]\w*[?!=]?|\[\]\??|<=>|===?|=~|!=|<<|>>|<=|>=|\*\*|[-+*/%&|^~<>!])/g;
const IVAR_RE = /@@?[a-zA-Z_]\w*/g;
const CONST_RE = /(?<![\w@$])(::)?([A-Z]\w*(?:::[A-Z]\w*)*)/g;

interface Frame {
  kind: 'def' | 'enum';
  indent: number;
  names: Map<string, 'parameter' | 'variable'>;
}

export function tokenize(text: string): Tok[] {
  const lines = maskText(text).split('\n');
  return tokenizeMasked(lines);
}

export function tokenizeMasked(rawLines: string[]): Tok[] {
  const toks: Tok[] = [];
  let seq = 0;
  const add = (line: number, start: number, length: number, type: TokenType, mods = 0): void => {
    if (length <= 0 || start < 0) return;
    toks.push({ line, start, length, type: TYPE_INDEX[type], mods, seq: seq++ });
  };

  const lines = rawLines.map((l) => l.replace(SYMBOL_RE, (m) => ' '.repeat(m.length)));

  // Pre-pass: what kind of thing is each declared name?
  const kinds = new Map<string, TokenType>();
  const constants = new Set<string>();
  for (const line of lines) {
    const d = DECL_RE.exec(line);
    if (d) {
      const name = d[3].split('::').pop()!;
      kinds.set(name, d[2] === 'class' ? 'class' : d[2] === 'struct' ? 'struct' : d[2] === 'enum' ? 'enum' : 'namespace');
      continue;
    }
    const r = RECORD_RE.exec(line);
    if (r) kinds.set(r[1], 'struct');
    const a = ALIAS_RE.exec(line);
    if (a) kinds.set(a[1].replace(/^::/, ''), 'class');
    const c = CONST_DECL_RE.exec(line);
    if (c) constants.add(c[1]);
  }

  const classify = (name: string, preferInterface: boolean): [TokenType, number] => {
    if (STDLIB_CONSTANTS.has(name)) return ['variable', MOD.readonly | MOD.defaultLibrary];
    if (constants.has(name) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return ['variable', MOD.readonly];
    const declared = kinds.get(name);
    if (declared) return [preferInterface && declared === 'namespace' ? 'interface' : declared, 0];
    if (/^[A-Z][A-Z0-9]?$/.test(name)) return ['typeParameter', 0];
    if (STDLIB_STRUCTS.has(name)) return ['struct', MOD.defaultLibrary];
    if (STDLIB_MODULES.has(name)) return [preferInterface ? 'interface' : 'namespace', MOD.defaultLibrary];
    if (STDLIB_CLASSES.has(name)) return ['class', MOD.defaultLibrary];
    return [preferInterface ? 'interface' : 'class', 0];
  };

  const rootNames = new Map<string, 'parameter' | 'variable'>();
  const stack: Frame[] = [];
  const currentNames = (): Map<string, 'parameter' | 'variable'> => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === 'def') return stack[i].names;
    return rootNames;
  };

  // Parameter list state (may span lines).
  let params: { depth: number; seg: string; segLine: number; segCol: number; frame: Frame } | undefined;

  const flushParam = (p: NonNullable<typeof params>): void => {
    const seg = p.seg;
    const m = /^(\s*)(?:\*\*|\*|&)?\s*(?:@{1,2})?([a-z_]\w*[?]?)(?:\s+([a-z_]\w*))?/.exec(seg);
    if (!m) return;
    const first = m[2];
    const firstIdx = seg.indexOf(first, m[1].length);
    if (m[3]) {
      add(p.segLine, p.segCol + firstIdx, first.length, 'parameter', MOD.declaration);
      const secondIdx = seg.indexOf(m[3], firstIdx + first.length);
      add(p.segLine, p.segCol + secondIdx, m[3].length, 'parameter', MOD.declaration);
      p.frame.names.set(m[3], 'parameter');
    } else {
      add(p.segLine, p.segCol + firstIdx, first.length, 'parameter', MOD.declaration);
      p.frame.names.set(first, 'parameter');
    }
  };

  const feedParams = (line: string, li: number, from: number): void => {
    const p = params;
    if (!p) return;
    for (let i = from; i < line.length; i++) {
      const c = line[i];
      if (c === '(' || c === '[' || c === '{') {
        p.depth++;
        if (p.depth === 1) continue; // the opening paren of the list itself
      } else if (c === ')' || c === ']' || c === '}') {
        p.depth--;
        if (p.depth === 0) {
          flushParam(p);
          params = undefined;
          return;
        }
      } else if (c === ',' && p.depth === 1) {
        flushParam(p);
        p.seg = '';
        continue;
      }
      if (p.seg === '') {
        p.segLine = li;
        p.segCol = i;
      }
      p.seg += c;
    }
    p.seg += ' ';
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.trim() === '') continue;

    // Continue a multi-line parameter list.
    if (params) feedParams(line, li, 0);

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();

    // Close frames.
    if (/^end\b/.test(trimmed)) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
        break;
      }
    }

    let declaredInLine = false;

    // --- declarations ---------------------------------------------------------------------------
    const d = DECL_RE.exec(line);
    if (d) {
      declaredInLine = true;
      const full = d[3];
      const nameStart = line.indexOf(full, d[0].length - full.length);
      const abstract = d[1].includes('abstract') ? MOD.abstract : 0;
      let off = nameStart + (full.startsWith('::') ? 2 : 0);
      const segs = full.replace(/^::/, '').split('::');
      segs.forEach((seg, idx) => {
        const last = idx === segs.length - 1;
        if (last) {
          const kind: TokenType = d[2] === 'class' ? 'class' : d[2] === 'struct' ? 'struct' : d[2] === 'enum' ? 'enum' : 'namespace';
          add(li, off, seg.length, kind, MOD.declaration | abstract);
        } else {
          add(li, off, seg.length, 'namespace');
        }
        off += seg.length + 2;
      });
      if (d[2] === 'enum') stack.push({ kind: 'enum', indent, names: new Map() });
    }

    const df = DEF_RE.exec(line);
    if (df) {
      declaredInLine = true;
      const name = df[4];
      const nameStart = df[0].length - name.length;
      const isStatic = df[3] ? MOD.static : 0;
      const abstract = df[2].includes('abstract') ? MOD.abstract : 0;
      add(li, nameStart, name.length, 'method', MOD.declaration | isStatic | abstract);
      const oneLiner = /\bend\s*$/.test(line) || /\)\s*=\s*[^=~>\s]/.test(line) || /def\s+\S+\s+=\s/.test(line) || abstract !== 0;
      const frame: Frame = { kind: 'def', indent, names: new Map() };
      if (!oneLiner) stack.push(frame);
      let k = nameStart + name.length;
      while (line[k] === ' ') k++;
      if (line[k] === '(') {
        params = { depth: 0, seg: '', segLine: li, segCol: k, frame };
        feedParams(line, li, k);
      }
    }

    const mc = MACRO_RE.exec(line);
    if (mc) {
      declaredInLine = true;
      const nameStart = mc[0].length - mc[2].length;
      add(li, nameStart, mc[2].length, 'macro', MOD.declaration);
      const frame: Frame = { kind: 'def', indent, names: new Map() };
      stack.push(frame);
      let k = nameStart + mc[2].length;
      while (line[k] === ' ') k++;
      if (line[k] === '(') {
        params = { depth: 0, seg: '', segLine: li, segCol: k, frame };
        feedParams(line, li, k);
      }
    }

    const fn = FUN_RE.exec(line);
    if (fn) add(li, line.indexOf(fn[1], 3), fn[1].length, 'function', MOD.declaration);

    const al = ALIAS_RE.exec(line);
    if (al) add(li, line.indexOf(al[1]) + (al[1].startsWith('::') ? 2 : 0), al[1].replace(/^::/, '').length, 'class', MOD.declaration);

    const cd = CONST_DECL_RE.exec(line);
    if (cd) add(li, line.indexOf(cd[1]), cd[1].length, 'variable', MOD.declaration | MOD.readonly);

    const top = stack[stack.length - 1];
    if (!declaredInLine && top && top.kind === 'enum' && indent > top.indent) {
      const em = ENUM_MEMBER_RE.exec(line);
      if (em && !cd) add(li, line.indexOf(em[1]), em[1].length, 'enumMember', MOD.declaration | MOD.readonly);
      else if (cd) {
        // Enum member with a value: re-tag as enum member instead of a constant.
        toks.pop();
        add(li, line.indexOf(cd[1]), cd[1].length, 'enumMember', MOD.declaration | MOD.readonly);
      }
    }

    const acc = ACCESSOR_RE.exec(line);
    if (acc) {
      const restStart = line.length - acc[1].length;
      for (const seg of splitTopLevel(acc[1])) {
        const m = /^\s*([a-z_]\w*[?!]?)/.exec(seg.text);
        if (m) add(li, restStart + seg.start + seg.text.indexOf(m[1]), m[1].length, 'property', MOD.declaration);
      }
    }

    // --- locals / block params ------------------------------------------------------------------
    const names = currentNames();
    const declareLocal = (name: string, col: number): void => {
      if (KEYWORDS.has(name)) return;
      const existing = names.get(name);
      if (existing === 'parameter') add(li, col, name.length, 'parameter');
      else if (existing === 'variable') add(li, col, name.length, 'variable');
      else {
        names.set(name, 'variable');
        add(li, col, name.length, 'variable', MOD.declaration);
      }
    };

    const ma = MULTI_ASSIGN_RE.exec(line);
    if (ma) {
      const base = line.indexOf(ma[1]);
      for (const m of ma[1].matchAll(/[a-z_]\w*/g)) declareLocal(m[0], base + (m.index ?? 0));
    } else {
      const asg = ASSIGN_RE.exec(line);
      if (asg && !declaredInLine) declareLocal(asg[1], line.indexOf(asg[1]));
    }
    const ca = COND_ASSIGN_RE.exec(line);
    if (ca) declareLocal(ca[1], line.indexOf(ca[1], ca.index));

    for (const bp of line.matchAll(BLOCK_PARAMS_RE)) {
      const listStart = (bp.index ?? 0) + bp[0].indexOf('|') + 1;
      for (const m of bp[1].matchAll(/[a-z_]\w*/g)) {
        const col = listStart + (m.index ?? 0);
        add(li, col, m[0].length, 'parameter', MOD.declaration);
        names.set(m[0], 'parameter');
      }
    }
    const fr = FOR_RE.exec(line);
    if (fr) {
      const base = line.indexOf(fr[1], fr.index);
      for (const m of fr[1].matchAll(/[a-z_]\w*/g)) {
        add(li, base + (m.index ?? 0), m[0].length, 'variable', MOD.declaration);
        names.set(m[0], 'variable');
      }
    }
    const rs = RESCUE_RE.exec(line);
    if (rs) {
      const col = line.indexOf(rs[1], rs.index + 6);
      add(li, col, rs[1].length, 'variable', MOD.declaration);
      names.set(rs[1], 'variable');
    }

    // --- annotations ----------------------------------------------------------------------------
    for (const m of line.matchAll(ANNOTATION_RE)) {
      const col = (m.index ?? 0) + m[0].length - m[1].length;
      add(li, col, m[1].length, 'decorator');
    }

    // --- constants / types ----------------------------------------------------------------------
    const preferInterface = INCLUDE_RE.test(line);
    for (const m of line.matchAll(CONST_RE)) {
      const text = m[2];
      let col = (m.index ?? 0) + (m[1] ? 2 : 0);
      const segs = text.split('::');
      segs.forEach((seg, idx) => {
        if (idx < segs.length - 1) {
          add(li, col, seg.length, 'namespace', STDLIB_MODULES.has(seg) ? MOD.defaultLibrary : 0);
        } else {
          const [type, mods] = classify(seg, preferInterface);
          add(li, col, seg.length, type, mods);
        }
        col += seg.length + 2;
      });
    }

    // --- instance variables ---------------------------------------------------------------------
    for (const m of line.matchAll(IVAR_RE)) {
      const isClassVar = m[0].startsWith('@@');
      add(li, m.index ?? 0, m[0].length, 'property', isClassVar ? MOD.static : 0);
    }

    // --- calls ----------------------------------------------------------------------------------
    for (const m of line.matchAll(/(?<=\.)([a-z_]\w*[?!]?)(?![\w?!]|:(?!:))/g)) {
      if (NOT_METHOD.has(m[1])) continue;
      add(li, m.index ?? 0, m[1].length, 'method');
    }
    for (const m of line.matchAll(/(?<![\w.@$:%])([a-z_]\w*[?!]?)(?![\w?!]|:(?!:))/g)) {
      const name = m[1];
      const col = m.index ?? 0;
      if (KEYWORDS.has(name)) continue;
      if (STDLIB_MACROS.has(name)) add(li, col, name.length, 'macro', MOD.defaultLibrary);
      else if (STDLIB_FUNCTIONS.has(name) && !names.has(name)) add(li, col, name.length, 'function', MOD.defaultLibrary);
      else if (/^\s*\(/.test(line.slice(col + name.length)) && line[col + name.length] === '(') {
        add(li, col, name.length, 'function');
      } else {
        const kind = names.get(name);
        if (kind) add(li, col, name.length, kind);
      }
    }
  }

  return finalize(toks);
}

/** Sorts tokens, drops overlaps (earlier priority wins at equal starts) and returns them in order. */
function finalize(toks: Tok[]): Tok[] {
  toks.sort((a, b) => a.line - b.line || a.start - b.start || a.seq - b.seq);
  const result: Tok[] = [];
  let lastLine = -1;
  let lastEnd = 0;
  for (const t of toks) {
    if (t.line === lastLine && t.start < lastEnd) continue;
    result.push(t);
    lastLine = t.line;
    lastEnd = t.start + t.length;
  }
  return result;
}
