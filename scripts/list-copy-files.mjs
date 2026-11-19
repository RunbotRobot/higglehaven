// #3888: which files hold copy, and reading them. Split from list-copy-lib.mjs so the pure functions
// there can be unit tested without the file system.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { copyOf } from './list-copy-lib.mjs';

export const REPO_ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, ok, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ok, out);
    else if (ok(relative(REPO_ROOT, p))) out.push(relative(REPO_ROOT, p));
  }
  return out;
}
const isSource = (f) => /\.js$/.test(f) && !/\.test\.js$/.test(f);

export function copyFiles(root = REPO_ROOT) {
  return [
    'index.html',
    ...walk(join(root, 'public'), (f) => /^public\/admin[^/]*\.html$/.test(f)),
    ...walk(join(root, 'src'), isSource),
    ...walk(join(root, 'worker'), (f) => isSource(f) && !/migrations-manifest/.test(f)),
  ];
}

export function collectCopy(root = REPO_ROOT) {
  return copyFiles(root).flatMap((f) => copyOf(f, readFileSync(join(root, f), 'utf8')));
}
