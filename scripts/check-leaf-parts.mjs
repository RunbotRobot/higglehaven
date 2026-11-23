#!/usr/bin/env node
// #3942 (part of #3933, interface week): a ratchet on how many different button and field
// looks src/app.css draws. docs/DESIGN.md "Inside a leaf" names one primary button, one quiet
// button and one field; the leaves are being brought onto them one PR at a time, so the count
// of distinct looks may fall but must not grow. When a PR lowers it, lower BASELINE in
// scripts/leaf-parts-baseline.json in the same PR (this check says so); a new look that is not
// one of the named parts fails here and belongs on the named part instead.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function declMap(body) {
  const m = new Map();
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    m.set(part.slice(0, i).trim(), part.slice(i + 1).trim().replace(/\s+/g, ' '));
  }
  return m;
}

// The innermost { } blocks are the rules, so rules inside @media are found too.
export function looks(css) {
  const buttons = new Set();
  const fields = new Set();
  const rows = new Set(); // added for #3939: a list row is one look, so a new row class joins the shared rule
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  const text = stripComments(css);
  while ((m = re.exec(text))) {
    const selector = m[1].trim();
    if (selector.startsWith('@') || selector.includes(':')) continue; // states and at-rules
    const d = declMap(m[2]);
    const key = (props) => props.map((p) => d.get(p) || '').join('|');
    if (/-btn\b|button/.test(selector) && d.has('border-radius')) {
      buttons.add(key(['padding', 'border', 'background', 'border-radius', 'color']));
    }
    if (/\binput\b|\bselect\b|\btextarea\b|-control\b/.test(selector) && d.has('border')) {
      fields.add(key(['padding', 'border', 'background', 'border-radius', 'font']));
    }
    // a list row: a selector whose last class ends in -row and that sets its own fill and shape
    if (/-row$/.test(selector.split(',').pop().trim()) && d.has('background') && d.has('border-radius') && d.has('padding')) {
      rows.add(key(['padding', 'background', 'border-radius']));
    }
  }
  return { buttons: buttons.size, fields: fields.size, rows: rows.size };
}

const baselinePath = path.join(root, 'scripts', 'leaf-parts-baseline.json');

function main() {
  const css = readFileSync(path.join(root, 'src', 'app.css'), 'utf8');
  const now = looks(css);
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  let failed = false;
  for (const kind of ['buttons', 'fields', 'rows']) {
    if (now[kind] > base[kind]) {
      console.error(`check-leaf-parts: ${kind} grew from ${base[kind]} to ${now[kind]} looks. Use the named part from docs/DESIGN.md "Inside a leaf" instead of a new look.`);
      failed = true;
    } else if (now[kind] < base[kind]) {
      console.error(`check-leaf-parts: ${kind} fell from ${base[kind]} to ${now[kind]}. Lower "${kind}" in scripts/leaf-parts-baseline.json to ${now[kind]} so it cannot grow back.`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`check-leaf-parts: ${now.buttons} button looks, ${now.fields} field looks, ${now.rows} row looks (at the baseline)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
