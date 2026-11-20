// Generates syntaxes/crystal.tmLanguage.json.
// Written as JS so regexes can use String.raw and repeated pieces (percent literals) are generated.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = String.raw;

const KEYWORDS = [
  'abstract', 'alias', 'annotation', 'asm', 'begin', 'break', 'case', 'class', 'def', 'do', 'else', 'elsif', 'end',
  'ensure', 'enum', 'extend', 'for', 'fun', 'if', 'in', 'include', 'lib', 'macro', 'module', 'next', 'of', 'out',
  'private', 'protected', 'require', 'rescue', 'return', 'select', 'struct', 'then', 'type', 'union', 'unless',
  'until', 'verbatim', 'when', 'while', 'with', 'yield',
];
const CONTROL = ['if', 'else', 'elsif', 'unless', 'case', 'when', 'in', 'then', 'while', 'until', 'for', 'do', 'begin',
  'rescue', 'ensure', 'return', 'next', 'break', 'yield', 'select', 'end'];

const identBoundary = R`(?<![\w@$.:])`;     // not preceded by identifier char, sigil, dot or colon
const notNamedArg = R`(?![\w?!]|:(?!:))`;   // not followed by identifier char or `name:`

const typePath = R`(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*`;

const escapes = {
  name: 'constant.character.escape.crystal',
  match: R`\\(?:[\\"'abefnrtv0]|x\h{2}|u\h{4}|u\{[\h ]+\}|[0-7]{1,3}|.)`,
};

const interpolation = {
  name: 'meta.embedded.line.crystal',
  begin: R`#\{`,
  end: R`\}`,
  beginCaptures: { 0: { name: 'punctuation.section.embedded.begin.crystal' } },
  endCaptures: { 0: { name: 'punctuation.section.embedded.end.crystal' } },
  patterns: [{ include: '$self' }],
};

const interpolatedContent = [escapes, interpolation];

// --- percent literals ------------------------------------------------------------------------
const delimiters = [
  ['(', ')', R`\(`, R`\)`],
  ['[', ']', R`\[`, R`\]`],
  ['{', '}', R`\{`, R`\}`],
  ['<', '>', '<', '>'],
];

const NAMES = { '(': 'paren', '[': 'bracket', '{': 'curly', '<': 'angle' };
const percentRules = [];
const percentNesting = {}; // repository entries for nested delimiters
for (const [o, c, eo, ec] of delimiters) {
  percentNesting[`nest-${NAMES[o]}`] = { begin: eo, end: ec, patterns: [{ include: `#nest-${NAMES[o]}` }] };
}
function percentRule(letters, scope, interpolate, requireValuePosition) {
  for (const [o, , eo, ec] of delimiters) {
    const lead = requireValuePosition
      ? R`(?:^|(?<=[(,=:;!&|?{}\[~<>+\-*]|\bwhen|\bif|\bunless|\bwhile|\bthen|\breturn|\bputs))\s*`
      : '';
    percentRules.push({
      name: scope,
      begin: `${lead}(%${letters})${eo}`,
      end: ec,
      beginCaptures: { 1: { name: 'punctuation.definition.string.begin.crystal' } },
      endCaptures: { 0: { name: 'punctuation.definition.string.end.crystal' } },
      patterns: [...(interpolate ? interpolatedContent : []), { include: `#nest-${NAMES[o]}` }],
    });
  }
  // pipe delimiter
  const lead = requireValuePosition
    ? R`(?:^|(?<=[(,=:;!&|?{}\[~<>+\-*]|\bwhen|\bif|\bunless|\bwhile|\bthen|\breturn|\bputs))\s*`
    : '';
  percentRules.push({
    name: scope,
    begin: `${lead}(%${letters})\\|`,
    end: R`\|`,
    beginCaptures: { 1: { name: 'punctuation.definition.string.begin.crystal' } },
    endCaptures: { 0: { name: 'punctuation.definition.string.end.crystal' } },
    patterns: interpolate ? interpolatedContent : [],
  });
}
percentRule('[wi]', 'string.quoted.other.crystal', false, false);
percentRule('q', 'string.quoted.other.crystal', false, false);
percentRule('Q', 'string.quoted.other.interpolated.crystal', true, false);
percentRule('x', 'string.interpolated.crystal', true, false);
percentRule('r', 'string.regexp.crystal', true, false);
percentRule('', 'string.quoted.other.interpolated.crystal', true, true);

// --- grammar -----------------------------------------------------------------------------------
const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'Crystal',
  scopeName: 'source.crystal',
  fileTypes: ['cr'],
  firstLineMatch: R`^#!.*\bcrystal\b`,
  patterns: [{ include: '#main' }],
  repository: {
    main: {
      patterns: [
        { include: '#comments' },
        { include: '#heredoc' },
        { include: '#annotation' },
        { include: '#macro-control' },
        { include: '#macro-expression' },
        { include: '#strings' },
        { include: '#percent-literals' },
        { include: '#regex' },
        { include: '#definitions' },
        { include: '#block-params' },
        { include: '#special-macros' },
        { include: '#keywords' },
        { include: '#literals' },
        { include: '#variables' },
        { include: '#types' },
        { include: '#named-args' },
        { include: '#calls' },
        { include: '#operators' },
        { include: '#braces' },
      ],
    },

    comments: {
      match: R`(#).*$\n?`,
      name: 'comment.line.number-sign.crystal',
      captures: { 1: { name: 'punctuation.definition.comment.crystal' } },
    },

    heredoc: {
      name: 'string.unquoted.heredoc.crystal',
      begin: R`(<<-)(['"]?)([A-Za-z_]\w*)\2`,
      end: R`^\s*\3\s*$`,
      beginCaptures: {
        1: { name: 'punctuation.definition.string.begin.crystal' },
        3: { name: 'keyword.operator.heredoc.crystal' },
      },
      endCaptures: { 0: { name: 'keyword.operator.heredoc.crystal' } },
      patterns: interpolatedContent,
    },

    annotation: {
      name: 'meta.annotation.crystal',
      begin: R`@\[`,
      end: R`\]`,
      beginCaptures: { 0: { name: 'punctuation.definition.annotation.begin.crystal' } },
      endCaptures: { 0: { name: 'punctuation.definition.annotation.end.crystal' } },
      patterns: [
        { match: R`(?<=@\[)\s*(` + typePath + R`)`, name: 'entity.name.function.decorator.crystal' },
        { include: '$self' },
      ],
    },

    'macro-control': {
      name: 'meta.macro.control.crystal',
      begin: R`\{%`,
      end: R`%\}`,
      beginCaptures: { 0: { name: 'punctuation.section.embedded.begin.crystal' } },
      endCaptures: { 0: { name: 'punctuation.section.embedded.end.crystal' } },
      patterns: [{ include: '$self' }],
    },

    'macro-expression': {
      name: 'meta.macro.expression.crystal',
      begin: R`\{\{`,
      end: R`\}\}`,
      beginCaptures: { 0: { name: 'punctuation.section.embedded.begin.crystal' } },
      endCaptures: { 0: { name: 'punctuation.section.embedded.end.crystal' } },
      patterns: [{ include: '$self' }],
    },

    strings: {
      patterns: [
        {
          name: 'string.quoted.double.crystal',
          begin: '"',
          end: '"',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.crystal' } },
          endCaptures: { 0: { name: 'punctuation.definition.string.end.crystal' } },
          patterns: interpolatedContent,
        },
        {
          name: 'string.interpolated.crystal',
          begin: '`',
          end: '`',
          beginCaptures: { 0: { name: 'punctuation.definition.string.begin.crystal' } },
          endCaptures: { 0: { name: 'punctuation.definition.string.end.crystal' } },
          patterns: interpolatedContent,
        },
        {
          name: 'string.quoted.single.char.crystal',
          match: R`'(?:\\(?:u\{[\h ]+\}|u\h{4}|.)|[^\\'])'`,
        },
        {
          name: 'constant.other.symbol.quoted.crystal',
          begin: R`(?<![:\w]):"`,
          end: '"',
          patterns: interpolatedContent,
        },
        {
          name: 'constant.other.symbol.crystal',
          match: R`(?<![:\w]):(?:[A-Za-z_]\w*[?!=]?|\[\]\??|\[\]=|<=>|===?|=~|!=|!~|<<|>>|<=|>=|\*\*|[-+*/%&|^~<>!])`,
        },
      ],
    },

    'percent-literals': { patterns: [...percentRules] },
    ...percentNesting,

    regex: {
      name: 'string.regexp.crystal',
      begin: R`(?:^|(?<=[(,=:;!&|?{}\[~<>+\-*%^]|\bwhen|\bif|\bunless|\bwhile|\buntil|\bthen|\breturn|\bputs))\s*(/)(?![ =*])`,
      end: R`(/)([imx]*)`,
      beginCaptures: { 1: { name: 'punctuation.definition.string.begin.crystal' } },
      endCaptures: {
        1: { name: 'punctuation.definition.string.end.crystal' },
        2: { name: 'keyword.other.regexp-option.crystal' },
      },
      patterns: [{ match: R`\\.`, name: 'constant.character.escape.crystal' }, interpolation],
    },

    definitions: {
      patterns: [
        {
          // class / struct / module / enum / lib / annotation
          match:
            R`^\s*(?:(abstract)\s+)?(?:(private|protected)\s+)?(class|struct|module|enum|lib|annotation)\s+(` +
            typePath +
            R`)(?:\s*(\([^)]*\)))?(?:\s*(<)\s*(` +
            typePath +
            R`))?`,
          name: 'meta.definition.type.crystal',
          captures: {
            1: { name: 'storage.modifier.abstract.crystal' },
            2: { name: 'storage.modifier.visibility.crystal' },
            3: { name: 'storage.type.class.crystal' },
            4: { name: 'entity.name.type.class.crystal' },
            5: { name: 'variable.other.generic-type.crystal' },
            6: { name: 'keyword.operator.inheritance.crystal' },
            7: { name: 'entity.other.inherited-class.crystal' },
          },
        },
        {
          // def with (params)
          name: 'meta.function.crystal',
          begin:
            R`^\s*((?:(?:abstract|private|protected)\s+)*)(def)\s+(?:(self|[A-Z]\w*(?:::[A-Z]\w*)*)(\.))?([A-Za-z_]\w*[?!=]?|\[\]\??=?|<=>|===?|=~|!=|!~|<<|>>|<=|>=|\*\*|&[-+*]|[-+*/%&|^~<>!]|[-+!]@)`,
          end: R`(?<=\))|$`,
          beginCaptures: {
            1: { name: 'storage.modifier.crystal' },
            2: { name: 'keyword.control.def.crystal' },
            3: { name: 'variable.language.self.crystal' },
            4: { name: 'punctuation.separator.method.crystal' },
            5: { name: 'entity.name.function.crystal' },
          },
          patterns: [{ include: '#def-params' }],
        },
        {
          match: R`^\s*(macro)\s+([a-z_]\w*[?!]?)`,
          captures: {
            1: { name: 'keyword.control.macro.crystal' },
            2: { name: 'entity.name.function.macro.crystal' },
          },
        },
        {
          match: R`^\s*(fun)\s+([a-z_]\w*)(?:\s*(=)\s*([A-Za-z_]\w*|"[^"]*"))?`,
          captures: {
            1: { name: 'keyword.control.fun.crystal' },
            2: { name: 'entity.name.function.crystal' },
            3: { name: 'keyword.operator.assignment.crystal' },
            4: { name: 'entity.name.function.crystal' },
          },
        },
        {
          match: R`^\s*(alias)\s+(` + typePath + R`)\s*(=)`,
          captures: {
            1: { name: 'keyword.control.alias.crystal' },
            2: { name: 'entity.name.type.alias.crystal' },
            3: { name: 'keyword.operator.assignment.crystal' },
          },
        },
        {
          match: R`^\s*(require)\s+("(?:[^"\\]|\\.)*")`,
          captures: {
            1: { name: 'keyword.control.import.crystal' },
            2: { name: 'string.quoted.double.crystal' },
          },
        },
        {
          match: R`^\s*(include|extend)\s+(` + typePath + R`)`,
          captures: {
            1: { name: 'keyword.control.mixin.crystal' },
            2: { name: 'entity.other.inherited-class.crystal' },
          },
        },
      ],
    },

    'def-params': {
      begin: R`\(`,
      end: R`\)`,
      beginCaptures: { 0: { name: 'punctuation.definition.parameters.begin.crystal' } },
      endCaptures: { 0: { name: 'punctuation.definition.parameters.end.crystal' } },
      name: 'meta.function.parameters.crystal',
      patterns: [
        { include: '#comments' },
        { match: R`\*\*?|&`, name: 'keyword.operator.splat.crystal' },
        { match: R`(@{1,2})[a-z_]\w*`, name: 'variable.parameter.instance.crystal' },
        { match: R`(?<![\w@$.:])[a-z_]\w*[?!]?(?![\w(])`, name: 'variable.parameter.crystal' },
        { include: '#types' },
        { include: '#literals' },
        { include: '#strings' },
        { include: '#operators' },
        { include: '#braces' },
      ],
    },

    'block-params': {
      match: R`(?<=\{|\bdo)\s*(\|)([^|]*)(\|)`,
      captures: {
        1: { name: 'punctuation.separator.variable.crystal' },
        2: { name: 'variable.parameter.block.crystal' },
        3: { name: 'punctuation.separator.variable.crystal' },
      },
    },

    'special-macros': {
      match:
        identBoundary +
        R`(?:(?:class_)?(?:getter|setter|property)[?!]?|record|delegate|forward_missing_to|def_equals_and_hash|def_equals|def_hash|def_clone|annotation)(?![\w?!])`,
      name: 'support.function.macro.crystal',
    },

    keywords: {
      patterns: [
        { match: identBoundary + R`\b(?:` + CONTROL.join('|') + R`)\b` + notNamedArg, name: 'keyword.control.crystal' },
        { match: identBoundary + R`\b(?:abstract|private|protected)\b` + notNamedArg, name: 'storage.modifier.crystal' },
        {
          match:
            identBoundary +
            R`\b(?:` +
            KEYWORDS.filter((k) => !CONTROL.includes(k) && !['abstract', 'private', 'protected'].includes(k)).join('|') +
            R`)\b` +
            notNamedArg,
          name: 'keyword.other.crystal',
        },
        {
          match: R`(?<=\.)(?:is_a\?|nil\?|responds_to\?|as\?|as!|as)(?![\w?!])`,
          name: 'keyword.other.crystal',
        },
        {
          match: identBoundary + R`(?:sizeof|instance_sizeof|alignof|instance_alignof|offsetof|pointerof|typeof|uninitialized|super|previous_def|as\?|as|is_a\?|nil\?|responds_to\?)(?![\w?!])`,
          name: 'keyword.other.special-method.crystal',
        },
      ],
    },

    literals: {
      patterns: [
        { match: R`\b(?:true|false)\b`, name: 'constant.language.boolean.crystal' },
        { match: R`\bnil\b`, name: 'constant.language.nil.crystal' },
        { match: R`\bself\b`, name: 'variable.language.self.crystal' },
        { match: R`\b__(?:DIR|FILE|LINE|END_LINE)__\b`, name: 'constant.language.crystal' },
        { match: R`\b0x[0-9a-fA-F_]+(?:_?[iu](?:8|16|32|64|128))?\b`, name: 'constant.numeric.hex.crystal' },
        { match: R`\b0b[01_]+(?:_?[iu](?:8|16|32|64|128))?\b`, name: 'constant.numeric.binary.crystal' },
        { match: R`\b0o[0-7_]+(?:_?[iu](?:8|16|32|64|128))?\b`, name: 'constant.numeric.octal.crystal' },
        {
          match: R`\b\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?(?:_?f(?:32|64))?\b|\b\d[\d_]*[eE][+-]?\d+(?:_?f(?:32|64))?\b|\b\d[\d_]*_?f(?:32|64)\b`,
          name: 'constant.numeric.float.crystal',
        },
        { match: R`\b\d[\d_]*(?:_?[iu](?:8|16|32|64|128))?\b`, name: 'constant.numeric.integer.crystal' },
      ],
    },

    variables: {
      patterns: [
        { match: R`@@[a-zA-Z_]\w*`, name: 'variable.other.readwrite.class.crystal' },
        { match: R`@[a-zA-Z_]\w*`, name: 'variable.other.readwrite.instance.crystal' },
        { match: R`\$(?:~|\?|\d+)`, name: 'variable.other.predefined.crystal' },
      ],
    },

    types: {
      patterns: [
        { match: R`(?<![\w@$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?![\w])`, name: 'constant.other.crystal' },
        { match: R`(?<![\w@$])[A-Z]\w*`, name: 'entity.name.type.crystal' },
        { match: R`::`, name: 'punctuation.separator.namespace.crystal' },
      ],
    },

    'named-args': {
      match: R`(?<![:\w.])([a-z_]\w*[?]?)(:)(?=\s)`,
      captures: {
        1: { name: 'variable.parameter.named.crystal' },
        2: { name: 'punctuation.separator.key-value.crystal' },
      },
    },

    calls: {
      patterns: [
        {
          match: R`(?<=\.)[a-z_]\w*[?!]?(?=\s*[({])`,
          name: 'entity.name.function.call.crystal',
        },
        {
          match: R`(?<=\.)[a-z_]\w*[?!]?`,
          name: 'meta.method-call.crystal',
        },
        {
          match: identBoundary + R`[a-z_]\w*[?!]?(?=\()`,
          name: 'entity.name.function.call.crystal',
        },
      ],
    },

    operators: {
      patterns: [
        { match: R`->`, name: 'keyword.operator.proc.crystal' },
        { match: R`=>`, name: 'keyword.operator.hash-rocket.crystal' },
        { match: R`&\.`, name: 'keyword.operator.safe-navigation.crystal' },
        { match: R`\.\.\.?`, name: 'keyword.operator.range.crystal' },
        { match: R`<=>|===|==|!=|=~|!~|<=|>=|&&|\|\||\*\*|<<|>>|&[-+*]`, name: 'keyword.operator.comparison.crystal' },
        { match: R`(?:\|\||&&|\*\*|<<|>>|[-+*/%|&^])=|=`, name: 'keyword.operator.assignment.crystal' },
        { match: R`[-+*/%&|^~<>!?]`, name: 'keyword.operator.crystal' },
        { match: R`[,;]`, name: 'punctuation.separator.crystal' },
        { match: R`\.`, name: 'punctuation.separator.method.crystal' },
      ],
    },

    // Balanced braces so `}` inside `#{ ... { |x| x } }` does not end the interpolation early.
    braces: {
      name: 'meta.braces.crystal',
      begin: R`\{`,
      end: R`\}`,
      patterns: [{ include: '$self' }],
    },
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'syntaxes', 'crystal.tmLanguage.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(grammar, null, 2) + '\n');
console.log('wrote', out);
