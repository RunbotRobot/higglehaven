#!/usr/bin/env node
// #4681: money a person reads is turned from cents into text by ONE function, shared/money.js's formatCents (public/admin-money.js
// for the admin pages, which are plain scripts). It used to be written out five times, and six admin pages did it by hand with
// toFixed, which printed "$1234.56" and "$-24.00" where the rest of the app printed "$1,234.56" and "-$24.00". Run as `pretest`
// (see package.json) so a new hand-written copy fails here instead of reading differently on one page. Only the pure part is
// unit-tested (scripts/check-money-formatter.test.mjs); main() reads the real repository files.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files that may carry the currency options themselves: the formatter, its admin copy, and src/main.js, where
// formatDollarsForPriceInput takes DOLLARS a seller typed (a different unit) and is the one allowed use there.
const ALLOWED = new Map([
  ['shared/money.js', Infinity],
  ['public/admin-money.js', Infinity],
  ['src/main.js', 1],
]);

const CURRENCY_STYLE = /style:\s*['"]currency['"]/g;
// "(cents / 100).toFixed(" and "cents/100)).toFixed(" alike: dividing by 100 and printing with toFixed.
const HAND_DIVIDED = /\/\s*100\s*\)*\s*\.toFixed\(/;

// files: [{ path: 'src/x.js', text }] with forward slashes. Returns [{ path, problem }].
export function findHandFormattedMoney(files) {
  const found = [];
  for (const { path, text } of files) {
    const allowed = ALLOWED.get(path) ?? 0;
    const currency = (text.match(CURRENCY_STYLE) || []).length;
    if (currency > allowed) found.push({ path, problem: `formats a currency by hand (${currency} use${currency === 1 ? '' : 's'}); call formatCents from shared/money.js` });
    if (/^public\/admin-/.test(path) && HAND_DIVIDED.test(text)) found.push({ path, problem: 'divides cents by 100 and prints with toFixed; call window.hhFormatCents' });
  }
  return found;
}

function listCodeFiles(dir, accept) {
  const out = [];
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCodeFiles(rel, accept));
    else if (accept(entry.name)) out.push(rel);
  }
  return out;
}

export function main() {
  const isCode = (name) => /\.(js|mjs|html)$/.test(name) && !/\.test\.(js|mjs)$/.test(name);
  const paths = [
    ...listCodeFiles('src', isCode),
    ...listCodeFiles('worker', (n) => isCode(n) && n !== 'migrations-manifest.json'),
    ...listCodeFiles('shared', isCode),
    ...listCodeFiles('public', (n) => /^admin-.*\.(js|html)$/.test(n) && isCode(n)),
  ];
  const files = paths.map((p) => ({ path: relative(repoRoot, join(repoRoot, p)).split(sep).join('/'), text: readFileSync(join(repoRoot, p), 'utf8') }));
  const problems = findHandFormattedMoney(files);
  if (problems.length > 0) {
    for (const { path, problem } of problems) console.error(`check-money-formatter: ${path}: ${problem}`);
    console.error('One function turns cents into the text a person reads (#4681).');
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
