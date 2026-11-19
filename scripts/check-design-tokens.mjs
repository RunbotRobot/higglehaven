#!/usr/bin/env node
// #3541: docs/DESIGN.md and src/tokens.css must name the same tokens, the
// stylesheet may only use variables that exist, and index.html must load the
// token file before the stylesheet that uses it. Runs from `pretest` (a plain
// Node script, like check-fly-button-icons.mjs) because the vitest pool
// stubs CSS imports to an empty string.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { declarations, stripComments } from './design-census.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const tokensCss = read('src/tokens.css');
const appCss = read('src/app.css');
const designMd = read('docs/DESIGN.md');
const html = read('index.html');

const problems = [];
const defined = new Set(declarations(tokensCss).filter((d) => d.prop.startsWith('--')).map((d) => d.prop));

for (const t of defined) if (!designMd.includes(`\`${t}\``)) problems.push(`docs/DESIGN.md does not name ${t} (defined in src/tokens.css)`);
const named = new Set([...designMd.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]));
for (const t of named) if (!defined.has(t)) problems.push(`docs/DESIGN.md names ${t}, which src/tokens.css does not define`);

const known = new Set(defined);
for (const d of declarations(appCss)) if (d.prop.startsWith('--')) known.add(d.prop);
// Variables a script sets at run time (element.style.setProperty('--x', ...))
// are defined too: the stylesheet reads them with a fallback.
import { readdirSync, statSync } from 'node:fs';
function jsFiles(dir, out = []) {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) jsFiles(rel, out);
    else if (/\.js$/.test(name) && !/\.test\./.test(name)) out.push(rel);
  }
  return out;
}
for (const f of jsFiles('src')) {
  for (const m of read(f).matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)['"`]/g)) known.add(m[1]);
}
const used = new Set([...stripComments(appCss).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
for (const v of used) if (!known.has(v)) problems.push(`src/app.css uses var(${v}), which is defined nowhere`);

// #3876: every moving part of the flower takes its duration from a motion token, so they
// share timings and feel like one thing. A literal "0.35s" on one of these animations is how
// they drifted apart in the first place. (The breath, the pulses and the opening screen's own
// loops are not parts growing or folding; they are not listed.)
const FLOWER_MOTIONS = ['bud-note-grow', 'bud-note-fold', 'bud-unfold', 'bud-grow', 'bud-fold', 'bud-fade', 'bud-stem-grow', 'product-card-bloom', 'product-card-fade'];
for (const d of declarations(appCss)) {
  if (d.prop !== 'animation') continue;
  const name = FLOWER_MOTIONS.find((n) => new RegExp(`(^|\\s)${n}(\\s|$)`).test(d.value));
  if (name && !/var\(--motion-/.test(d.value)) problems.push(`src/app.css: animation "${d.value}" (${name}) must take its duration from a --motion-* token`);
}

const tokensAt = html.indexOf('/src/tokens.css');
const appAt = html.indexOf('/src/app.css');
if (tokensAt < 0 || appAt < tokensAt) problems.push('index.html must load /src/tokens.css before /src/app.css');

if (problems.length) {
  console.error('check-design-tokens failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`check-design-tokens: ${defined.size} tokens agree with docs/DESIGN.md`);
