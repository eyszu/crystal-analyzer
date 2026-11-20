// Checks the scanner-based semantic tokenizer and masker against test/fixtures/sample.cr.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { tokenize, TOKEN_TYPES, TOKEN_MODIFIERS } = await import(join(root, 'out/test/semanticTokenizer.mjs'));
const { maskText, splitTopLevel } = await import(join(root, 'out/test/scanner.mjs'));

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL ' + msg);
};

// --- masker -------------------------------------------------------------------------------------
{
  const src = 'a = "x # not comment #{b}" # real comment\nc = /a#b/ + 1\nd = <<-E\n  body "q"\n  E\ne = %w[a b]\nf = x / 2 / 3\n';
  const m = maskText(src);
  if (m.length !== src.length) fail('mask changes length');
  const lines = m.split('\n');
  if (lines[0].includes('not') || lines[0].includes('real')) fail('string/comment not masked: ' + lines[0]);
  if (!lines[0].includes('b')) fail('interpolation code should stay visible: ' + lines[0]);
  if (lines[1].includes('a#b')) fail('regex not masked: ' + lines[1]);
  if (lines[3].includes('body')) fail('heredoc body not masked');
  if (lines[5].includes('a b')) fail('%w literal not masked');
  if (!lines[6].includes('x / 2 / 3')) fail('division must not be treated as regex: ' + lines[6]);
}
{
  const parts = splitTopLevel('a, f(b, c), [1, 2], {x => y}');
  if (parts.length !== 4) fail('splitTopLevel count: ' + parts.length);
}

// --- tokens -------------------------------------------------------------------------------------
const src = readFileSync(join(root, 'test/fixtures/sample.cr'), 'utf8');
const lines = src.split('\n');
const toks = tokenize(src);

function expectTok(needle, word, type, modName, fromEnd = false) {
  const line = lines.findIndex((l) => l.includes(needle));
  if (line < 0) return fail(`needle not in fixture: ${needle}`);
  const start = fromEnd ? lines[line].lastIndexOf(word) : lines[line].indexOf(word, lines[line].indexOf(needle));
  const t = toks.find((x) => x.line === line && x.start === start && x.length === word.length);
  if (!t) return fail(`no token for "${word}" in "${needle.trim()}"`);
  if (TOKEN_TYPES[t.type] !== type) return fail(`"${word}" in "${needle.trim()}": expected ${type}, got ${TOKEN_TYPES[t.type]}`);
  if (modName) {
    const bit = 1 << TOKEN_MODIFIERS.indexOf(modName);
    if (!(t.mods & bit)) fail(`"${word}" in "${needle.trim()}": missing modifier ${modName}`);
  }
}

expectTok('module Greeter', 'Greeter', 'namespace', 'declaration');
expectTok('DEFAULT_NAME =', 'DEFAULT_NAME', 'variable', 'readonly');
expectTok('enum Mood', 'Mood', 'enum', 'declaration');
expectTok('    Happy', 'Happy', 'enumMember', 'declaration');
expectTok('Sad = 5', 'Sad', 'enumMember', 'declaration');
expectTok('abstract class Base', 'Base', 'class', 'abstract');
expectTok('abstract def greet', 'greet', 'method', 'abstract');
expectTok('class Hello', 'Hello', 'class', 'declaration');
expectTok('class Hello < Base', 'Base', 'class');
expectTok('include Comparable', 'Comparable', 'interface', 'defaultLibrary');
expectTok('getter name', 'getter', 'macro', 'defaultLibrary');
expectTok('getter name', 'name', 'property', 'declaration');
expectTok('@@instances = 0', '@@instances', 'property', 'static');
expectTok('def initialize', 'initialize', 'method', 'declaration');
expectTok('def initialize', 'count', 'parameter', 'declaration');
expectTok('def initialize', 'String', 'class', 'defaultLibrary');
expectTok('def self.build', 'build', 'method', 'static');
expectTok('msg = "Hello', 'msg', 'variable', 'declaration');
expectTok('msg = "Hello', 'upcase', 'method');
expectTok('[1, 2, 3].each do |n|', 'n', 'parameter', 'declaration');
expectTok('total += n', 'n', 'parameter');
expectTok('total += n', 'total', 'variable');
expectTok('puts msg, total', 'puts', 'function', 'defaultLibrary');
expectTok('puts msg, total', 'msg', 'variable');
expectTok('macro define_thing', 'define_thing', 'macro', 'declaration');
expectTok('macro define_thing', 'thing', 'parameter', 'declaration', true);
expectTok('{{ thing }}', 'thing', 'parameter');
expectTok('greeting =', 'Hello', 'class');
expectTok('greeting =', 'Greeter', 'namespace');
expectTok('greeting =', 'new', 'method');

// Parameters must not leak out of their def: `name` after the class is not a parameter here.
const leak = toks.find((t) => t.line === lines.findIndex((l) => l.startsWith('puts "done"')) && TOKEN_TYPES[t.type] === 'parameter');
if (leak) fail('parameter token leaked outside def');

// Tokens must be sorted and non-overlapping.
for (let i = 1; i < toks.length; i++) {
  const a = toks[i - 1];
  const b = toks[i];
  if (a.line === b.line && b.start < a.start + a.length) fail(`overlap on line ${a.line + 1}`);
  if (b.line < a.line) fail('tokens not sorted');
}

if (failures > 0) {
  console.error(`${failures} tokenizer check(s) failed`);
  process.exit(1);
}
console.log(`tokenizer: all checks passed (${toks.length} tokens)`);
