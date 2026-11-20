// Tokenizes test/fixtures/sample.ecr with the real TextMate engine (HTML grammar from tm-grammars).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vsctm from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await oniguruma.loadWASM(readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);

const files = {
  'text.html.ecr': join(root, 'syntaxes/ecr.tmLanguage.json'),
  'source.crystal': join(root, 'syntaxes/crystal.tmLanguage.json'),
  'text.html.basic': join(root, 'node_modules/tm-grammars/grammars/html.json'),
};
const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (p) => new oniguruma.OnigScanner(p),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  loadGrammar: async (scope) => (files[scope] ? vsctm.parseRawGrammar(readFileSync(files[scope], 'utf8'), files[scope]) : null),
});
const grammar = await registry.loadGrammar('text.html.ecr');
const lines = readFileSync(join(root, 'test/fixtures/sample.ecr'), 'utf8').split('\n');

let state = vsctm.INITIAL;
const tokens = [];
for (const line of lines) {
  const r = grammar.tokenizeLine(line, state);
  tokens.push(r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes })));
  state = r.ruleStack;
}

let failures = 0;
const find = (needle) => lines.findIndex((l) => l.includes(needle));
function expect(needle, text, fragment) {
  const li = find(needle);
  const hit = (tokens[li] ?? []).find((t) => t.text.trim() === text && t.scopes.some((s) => s.includes(fragment)));
  if (!hit) {
    failures++;
    const seen = (tokens[li] ?? []).filter((t) => t.text.trim() === text).map((t) => t.scopes.join(' > '));
    console.error(`FAIL "${needle}": "${text}" should have ~${fragment}; got ${seen.join(' | ') || '(not found)'}`);
  }
}

expect('<title>', '<%=', 'punctuation.section.embedded.begin.ecr'); // inside HTML element content
expect('<title>', 'title', 'source.crystal');
expect('<title>', '%>', 'punctuation.section.embedded.end.ecr');
expect('<body class', '<%=', 'punctuation.section.embedded.begin.ecr'); // inside an HTML attribute string
expect('<body class', 'klass', 'source.crystal');
expect('a comment', '<%#', 'comment.block.ecr');
expect('if user', 'if', 'keyword.control.crystal');
expect('if user', 'current_user', 'source.crystal');
expect('if user', '-', 'punctuation.section.embedded.trim.ecr');
expect('Hello,', 'upcase', 'meta.method-call');
expect('items.each', 'do', 'keyword.control.crystal');
expect('items.each', 'item', 'variable.parameter.block');
expect('item-<%=', '<%=', 'punctuation.section.embedded.begin.ecr'); // attribute value mixing text and code
expect('item-<%=', 'id', 'meta.method-call');
expect('<% end %>', 'end', 'keyword.control.crystal');
expect('literal', '<%%', 'constant.character.escape.ecr');
expect('<!DOCTYPE', '<!', 'meta.tag'); // HTML still works around ECR
expect('<p>Hello', 'p', 'entity.name.tag');

// "not code" between escapes must stay plain text, not Crystal.
const li = find('literal');
const nc = tokens[li].find((t) => t.text.includes('not code'));
if (!nc || nc.scopes.some((s) => s.includes('source.crystal'))) {
  failures++;
  console.error('FAIL escaped <%% ... %%> content was treated as Crystal');
}

// No scope leakage at end of file.
const lastTok = tokens[tokens.length - 2]?.[0] ?? tokens[tokens.length - 1][0];
if (state.depth > 2) {
  failures++;
  console.error('FAIL unterminated rule stack at EOF (depth ' + state.depth + ')');
}

if (failures) {
  console.error(`${failures} ECR check(s) failed`);
  process.exit(1);
}
console.log('ecr grammar: all checks passed');
