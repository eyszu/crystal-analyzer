// Tokenizes test/fixtures/sample.cr with the real TextMate engine and checks key scopes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vsctm from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
await oniguruma.loadWASM(wasm);

const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (p) => new oniguruma.OnigScanner(p),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  loadGrammar: async (scope) =>
    scope === 'source.crystal'
      ? vsctm.parseRawGrammar(readFileSync(join(root, 'syntaxes/crystal.tmLanguage.json'), 'utf8'), 'crystal.json')
      : null,
});
const grammar = await registry.loadGrammar('source.crystal');
const lines = readFileSync(join(root, 'test/fixtures/sample.cr'), 'utf8').split('\n');

let state = vsctm.INITIAL;
const tokensByLine = [];
for (const line of lines) {
  const r = grammar.tokenizeLine(line, state);
  tokensByLine.push(r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes })));
  state = r.ruleStack;
}

let failures = 0;
function expect(lineNo, text, scopeFragment) {
  const toks = tokensByLine[lineNo - 1] ?? [];
  const hit = toks.find((t) => t.text === text && t.scopes.some((s) => s.includes(scopeFragment)));
  if (!hit) {
    failures++;
    const seen = toks.filter((t) => t.text === text).map((t) => t.scopes.join(' > '));
    console.error(`FAIL line ${lineNo}: "${text}" should have scope ~${scopeFragment}; got: ${seen.join(' | ') || '(token not found)'}`);
  }
}

const find = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;

expect(find('require "json"'), 'require', 'keyword.control.import');
expect(find('# A documented'), ' A documented module', 'comment.line');
expect(find('module Greeter'), 'Greeter', 'entity.name.type.class');
expect(find('DEFAULT_NAME ='), 'DEFAULT_NAME', 'constant.other');
expect(find('class Hello'), 'Hello', 'entity.name.type.class');
expect(find('class Hello'), 'Base', 'entity.other.inherited-class');
expect(find('include Comparable'), 'Comparable', 'entity.other.inherited-class');
expect(find('getter name'), 'getter', 'support.function.macro');
expect(find('@@instances = 0'), '@@instances', 'variable.other.readwrite.class');
expect(find('def initialize'), 'initialize', 'entity.name.function');
expect(find('def initialize'), 'count', 'variable.parameter');
expect(find('def greet(name : String) : String\n'.trim()) , 'greet', 'entity.name.function');
expect(find('msg = "Hello'), '"', 'string.quoted.double');
expect(find('msg = "Hello'), 'upcase', 'meta.method-call');
expect(find('def self.build'), 'self', 'variable.language.self');
expect(find('macro define_thing'), 'define_thing', 'entity.name.function.macro');
expect(find('{{ thing.id }}'), '{{', 'punctuation.section.embedded.begin');
expect(find('def <=>'), '<=>', 'entity.name.function');
expect(find('pattern ='), 'i', 'keyword.other.regexp-option');
expect(find('words ='), 'a b c', 'string.quoted.other');
expect(find('sym ='), ':symbol', 'constant.other.symbol');
expect(find('x = 10 / 2'), '/', 'keyword.operator');
expect(find('[1, 2, 3]'), '1', 'constant.numeric');
expect(find('|n|'), 'n', 'variable.parameter.block');

// heredoc body must be a string
const hd = find('heredoc "body"');
if (!tokensByLine[hd - 1].every((t) => t.scopes.some((s) => s.startsWith('string.unquoted.heredoc')))) {
  failures++;
  console.error('FAIL heredoc body is not fully scoped as heredoc string');
}

// Nothing may leak: the final code line must be back at the root scope.
const last = find('puts "done"');
const first = tokensByLine[last - 1][0];
if (first.scopes.length !== 1 || first.scopes[0] !== 'source.crystal') {
  failures++;
  console.error(`FAIL scope leak before last line: ${first.scopes.join(' > ')}`);
}

if (failures > 0) {
  console.error(`${failures} grammar check(s) failed`);
  process.exit(1);
}
console.log('grammar: all checks passed');
