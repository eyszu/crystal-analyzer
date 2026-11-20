// Tests require-path resolution against a throwaway directory tree.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parseRequire, resolveRequire, expandSearchRoots } = await import(join(root, 'out/test/requireResolve.mjs'));

const tmp = mkdtempSync(join(tmpdir(), 'cr-require-'));
const files = [
  'src/app.cr',
  'src/blog/markdown.cr',
  'src/blog/post/post.cr',
  'src/blog/a.cr',
  'src/blog/sub/b.cr',
  'spec/app_spec.cr',
  'lib/kemal/src/kemal.cr',
  'lib/kemal/src/kemal/handlers.cr',
  'lib/plain/plain.cr',
  'stdlib/json.cr',
  'stdlib/http/http.cr',
  'stdlib/http/client.cr',
];
for (const f of files) {
  mkdirSync(dirname(join(tmp, f)), { recursive: true });
  writeFileSync(join(tmp, f), '# fixture\n');
}

const fs = {
  isFile: async (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  isDir: async (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  readDir: async (p) => { try { return readdirSync(p); } catch { return []; } },
};

let failures = 0;
const rel = (arr) => arr.map((p) => p.slice(tmp.length + 1)).sort();
async function expectResolve(spec, from, expected) {
  const entries = ['lib', join(tmp, 'stdlib')];
  const roots = expandSearchRoots(entries, join(tmp, from), [tmp]);
  const got = rel(await resolveRequire(spec, join(tmp, from), roots, fs));
  if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) {
    failures++;
    console.error(`FAIL require "${spec}" from ${from}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }
}

// parseRequire
{
  const m = parseRequire('require "./blog/markdown"');
  if (!m || m.spec !== './blog/markdown' || m.start !== 9 || m.end !== 24) {
    failures++;
    console.error('FAIL parseRequire basic: ' + JSON.stringify(m));
  }
  if (parseRequire('# require "x"') || parseRequire('x = "require"') || parseRequire('  requires "x"')) {
    failures++;
    console.error('FAIL parseRequire matched a non-require line');
  }
  if (!parseRequire('  require "json" # c')) {
    failures++;
    console.error('FAIL parseRequire indented');
  }
}

await expectResolve('./blog/markdown', 'src/app.cr', ['src/blog/markdown.cr']);
await expectResolve('./blog/post', 'src/app.cr', ['src/blog/post/post.cr']);
await expectResolve('../src/app', 'spec/app_spec.cr', ['src/app.cr']);
await expectResolve('./blog/nope', 'src/app.cr', []);
await expectResolve('./blog/*', 'src/app.cr', ['src/blog/a.cr', 'src/blog/markdown.cr']);
await expectResolve('./blog/**', 'src/app.cr', ['src/blog/a.cr', 'src/blog/markdown.cr', 'src/blog/post/post.cr', 'src/blog/sub/b.cr']);
await expectResolve('json', 'src/app.cr', ['stdlib/json.cr']);
await expectResolve('http', 'src/app.cr', ['stdlib/http/http.cr']);
await expectResolve('http/client', 'src/app.cr', ['stdlib/http/client.cr']);
await expectResolve('kemal', 'src/app.cr', ['lib/kemal/src/kemal.cr']);
await expectResolve('kemal/handlers', 'spec/app_spec.cr', ['lib/kemal/src/kemal/handlers.cr']);
await expectResolve('plain', 'src/app.cr', ['lib/plain/plain.cr']);
await expectResolve('app', 'spec/app_spec.cr', ['src/app.cr']); // workspace src/ fallback
await expectResolve('does_not_exist', 'src/app.cr', []);

if (failures) {
  console.error(`${failures} require check(s) failed`);
  process.exit(1);
}
console.log('require resolution: all checks passed');
