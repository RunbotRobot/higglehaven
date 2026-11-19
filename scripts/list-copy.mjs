#!/usr/bin/env node
// #3888 (One voice): list every string a person can read, with area, file and line, for reading in one
// sitting. Usage:
//   node scripts/list-copy.mjs                 all areas, one line each (area <TAB> file:line <TAB> text)
//   node scripts/list-copy.mjs --area Shop     one area (a name from the summary, case-insensitive)
//   node scripts/list-copy.mjs --count         a count per area
//   node scripts/list-copy.mjs --json          machine-readable
// It reads index.html, public/*.html (admin pages), src/**/*.js (not tests) and worker/**/*.js (the
// error and message strings the client shows as they are). It lists a little too much rather than
// miss a real sentence; the file and line are there so a reader can judge.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { copyOf, AREAS } from './list-copy-lib.mjs';

const root = new URL('..', import.meta.url).pathname;
function walk(dir, ok, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ok, out);
    else if (ok(relative(root, p))) out.push(relative(root, p));
  }
  return out;
}
const isSource = (f) => /\.js$/.test(f) && !/\.test\.js$/.test(f);
const files = [
  'index.html',
  ...walk(join(root, 'public'), (f) => /^public\/admin[^/]*\.html$/.test(f)),
  ...walk(join(root, 'src'), isSource),
  ...walk(join(root, 'worker'), (f) => isSource(f) && !/migrations-manifest/.test(f)),
];

const args = process.argv.slice(2);
const areaArg = args.includes('--area') ? args[args.indexOf('--area') + 1]?.toLowerCase() : null;
const rows = files.flatMap((f) => copyOf(f, readFileSync(join(root, f), 'utf8')));
const chosen = areaArg ? rows.filter((r) => r.area.toLowerCase().includes(areaArg)) : rows;

if (args.includes('--count')) {
  for (const a of AREAS) console.log(`${String(rows.filter((r) => r.area === a).length).padStart(6)}  ${a}`);
  console.log(`${String(rows.length).padStart(6)}  total`);
} else if (args.includes('--json')) {
  console.log(JSON.stringify(chosen, null, 2));
} else {
  for (const r of chosen) console.log(`${r.area}\t${r.file}:${r.line}\t${r.text}`);
}
