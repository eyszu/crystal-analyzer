/**
 * Resolution of `require "..."` paths using Crystal's lookup rules. Pure node code (no `vscode`
 * import) so it can be tested with plain node.
 *
 * Relative (`./x`, `../x`):   <dir>/x.cr, <dir>/x/x.cr
 * Globs (`./x/*`, `./x/**`):  every .cr file in <dir>/x (recursively for `**`)
 * Other (`json`, `kemal/x`):  for each search root R (CRYSTAL_PATH, `lib`, stdlib):
 *                             R/x.cr, R/x/x.cr, R/<shard>/src/x.cr, R/<shard>/src/<shard>.cr ...
 */
import * as path from 'path';

export interface Fs {
  isFile(p: string): Promise<boolean>;
  isDir(p: string): Promise<boolean>;
  readDir(p: string): Promise<string[]>;
}

export interface RequireMatch {
  spec: string;
  /** Column of the first character of the path (just after the opening quote). */
  start: number;
  /** Column just past the last character of the path (the closing quote). */
  end: number;
}

export function parseRequire(line: string): RequireMatch | undefined {
  const m = /^(\s*require\s+)"([^"\\]*)"/.exec(line);
  if (!m) return undefined;
  const start = m[1].length + 1;
  return { spec: m[2], start, end: start + m[2].length };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function firstFile(fs: Fs, candidates: string[]): Promise<string | undefined> {
  for (const c of candidates) if (await fs.isFile(c)) return c;
  return undefined;
}

async function listCrystalFiles(fs: Fs, dir: string, recursive: boolean, depth = 0): Promise<string[]> {
  if (depth > 8 || !(await fs.isDir(dir))) return [];
  const out: string[] = [];
  const names = (await fs.readDir(dir)).sort();
  for (const name of names) {
    const full = path.join(dir, name);
    if (name.endsWith('.cr') && (await fs.isFile(full))) out.push(full);
    else if (recursive && !name.startsWith('.') && (await fs.isDir(full))) out.push(...(await listCrystalFiles(fs, full, true, depth + 1)));
  }
  return out;
}

function fileCandidates(base: string, spec: string): string[] {
  const full = path.resolve(base, spec);
  const last = path.basename(full);
  return unique([...(spec.endsWith('.cr') ? [full] : []), `${full}.cr`, path.join(full, `${last}.cr`)]);
}

export async function resolveRequire(spec: string, fromFile: string, searchRoots: string[], fs: Fs): Promise<string[]> {
  if (spec === '') return [];
  const glob = /^(.*?)\/?(\*\*?)$/.exec(spec);
  const isRelative = spec.startsWith('./') || spec.startsWith('../');

  if (isRelative) {
    const base = path.dirname(fromFile);
    if (glob) return listCrystalFiles(fs, path.resolve(base, glob[1] || '.'), glob[2] === '**');
    const hit = await firstFile(fs, fileCandidates(base, spec));
    return hit ? [hit] : [];
  }

  const parts = spec.split('/');
  const first = parts[0];
  if (glob) {
    const prefix = glob[1];
    for (const root of searchRoots) {
      for (const dir of [path.join(root, prefix), path.join(root, first, 'src', prefix)]) {
        const files = await listCrystalFiles(fs, dir, glob[2] === '**');
        if (files.length > 0) return files;
      }
    }
    return [];
  }

  for (const root of searchRoots) {
    const candidates = [
      ...fileCandidates(root, spec),
      path.join(root, first, 'src', `${spec}.cr`),
      path.join(root, first, 'src', spec, `${parts[parts.length - 1]}.cr`),
      ...(parts.length > 1 ? [path.join(root, first, 'src', `${parts.slice(1).join('/')}.cr`)] : []),
    ];
    const hit = await firstFile(fs, unique(candidates));
    if (hit) return [hit];
  }
  return [];
}

/**
 * Turns CRYSTAL_PATH style entries into absolute directories. Relative entries (like `lib`) are
 * resolved against every ancestor of the requiring file and every extra base (workspace folders).
 */
export function expandSearchRoots(entries: string[], fromFile: string, extraBases: string[]): string[] {
  const bases: string[] = [];
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 12; i++) {
    bases.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  bases.push(...extraBases);

  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.trim() === '') continue;
    if (path.isAbsolute(entry)) roots.push(entry);
    else for (const b of bases) roots.push(path.resolve(b, entry));
  }
  // Project shards are often required by name from specs; src/ of the workspace is a cheap, low-priority guess.
  for (const b of extraBases) roots.push(path.join(b, 'src'));
  return unique(roots);
}
