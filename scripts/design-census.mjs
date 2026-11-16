#!/usr/bin/env node
// #3541 (interface week, #3539): count how many distinct font sizes, colours,
// radii, shadows and spacing steps the app's one stylesheet uses, so the
// clutter has a number and a later pass can show it going down. Deterministic:
// reads src/app.css (+ src/tokens.css) and prints a table, or --json.
//
// A value counts once however often it is used. A value written as a token
// (var(--...)) is counted separately as "on a token", so the share of the
// stylesheet that already speaks the design language is visible too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Every `property: value;` declaration outside of the :root token blocks.
export function declarations(css) {
  const text = stripComments(css);
  const out = [];
  const re = /([a-z0-9-]+)\s*:\s*([^;{}]+?)\s*(?:;|(?=}))/g;
  let m;
  while ((m = re.exec(text))) out.push({ prop: m[1], value: m[2].trim() });
  return out;
}

// rgb(...) may hold a var(--x-rgb) inside it, so one level of nesting is allowed.
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\((?:[^()]|\([^()]*\))*\)/g;
const NAMED = ['white', 'black', 'transparent', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'yellow'];

// The same colour at a different opacity is one hue: rgb(22 36 10 / .25) and
// rgb(22 36 10 / .65) are both the ink.
function colorBase(c) {
  const n = normColor(c);
  const m = n.match(/^(rgba?)\(([^)]*)\)$/);
  if (!m) return n;
  const nums = m[2].replace(/\s*\/.*$/, '').split(/[,\s]+/).filter(Boolean).slice(0, 3);
  return `rgb(${nums.join(' ')})`;
}

function normColor(c) {
  return c.toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / ').replace(/,\s*/g, ', ').trim();
}

// Replace every var(--token) with the value src/tokens.css gives it, so the
// count of values IN USE does not change when a value is moved onto a token.
export function resolveTokens(css, tokensCss) {
  const defs = new Map();
  for (const { prop, value } of declarations(tokensCss)) if (prop.startsWith('--')) defs.set(prop, value);
  let out = css;
  for (let pass = 0; pass < 6 && /var\(--/.test(out); pass++) {
    out = out.replace(/var\((--[a-z0-9-]+)\)/g, (whole, name) => (defs.has(name) ? defs.get(name) : whole));
  }
  return out;
}

export function census(css, tokensCss = '') {
  const inUse = tokensCss ? countDistinct(resolveTokens(css, tokensCss)) : null;
  const result = countRaw(css);
  result.inUse = inUse;
  return result;
}

function countDistinct(css) {
  const r = countRaw(css);
  return r.distinct;
}

function countRaw(css) {
  const decls = declarations(css);
  const sets = { fontSizes: new Map(), fontFamilies: new Map(), colors: new Map(), colorBases: new Map(), radii: new Map(), shadows: new Map(), spacing: new Map() };
  const tokenUses = { fontSizes: 0, colors: 0, radii: 0, shadows: 0, spacing: 0 };
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const { prop, value } of decls) {
    if (prop.startsWith('--')) continue; // token definitions are not uses
    if (prop === 'font-size') {
      if (/var\(/.test(value)) tokenUses.fontSizes++; else bump(sets.fontSizes, value);
    }
    if (prop === 'font') {
      const size = value.match(/^(?:[a-z0-9 ]+\s)?(\d+(?:\.\d+)?(?:px|rem|em))/);
      if (/^var\(--text/.test(value)) tokenUses.fontSizes++; else if (size) bump(sets.fontSizes, size[1]);
      const fam = value.replace(/^.*?\/[\d.]+\s*/, '');
      if (/var\(--font/.test(value)) { /* token */ } else if (fam) bump(sets.fontFamilies, fam);
    }
    if (prop === 'font-family') {
      if (/var\(/.test(value)) tokenUses.fontSizes += 0; else bump(sets.fontFamilies, value);
    }
    if (prop === 'border-radius') {
      if (/var\(/.test(value)) tokenUses.radii++; else bump(sets.radii, value);
    }
    if (prop === 'box-shadow' || prop === 'text-shadow') {
      if (/^var\(/.test(value)) tokenUses.shadows++; else if (value !== 'none') bump(sets.shadows, value.replace(/\s+/g, ' '));
    }
    if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?$/.test(prop)) {
      for (const part of value.split(/\s+/)) {
        if (/^var\(/.test(part)) tokenUses.spacing++;
        else if (/^-?\d+(?:\.\d+)?px$/.test(part) && part !== '0px') bump(sets.spacing, part);
      }
    }
    {
      // Colours: a literal is one distinct hard-coded colour; anything built
      // from a var() counts as a use of the design tokens instead. Shadows
      // are scanned for the colours inside them too.
      const found = value.match(COLOR_RE) || [];
      for (const c of found) {
        if (/var\(/.test(c)) tokenUses.colors++; else { bump(sets.colors, normColor(c)); bump(sets.colorBases, colorBase(c)); }
      }
      const bare = value.replace(COLOR_RE, ' ');
      for (const n of NAMED) {
        if (new RegExp(`(^|[\\s,(])${n}($|[\\s,)])`).test(bare) && /color|background|border|outline|fill|stroke|shadow/.test(prop)) bump(sets.colors, n);
      }
      for (const m of bare.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
        if (/^(ink|white|world-fallback|danger|danger-[a-z-]+|leaf-[a-z]+|sky|sun|scrim|scrim-soft|brand-green|pill-text|pill-text-soft)$/.test(m[1])) tokenUses.colors++;
      }
    }
  }
  const distinct = (m) => m.size;
  return {
    distinct: {
      fontSizes: distinct(sets.fontSizes), fontFamilies: distinct(sets.fontFamilies), colors: distinct(sets.colors), hues: distinct(sets.colorBases),
      radii: distinct(sets.radii), shadows: distinct(sets.shadows), spacing: distinct(sets.spacing),
    },
    onTokens: tokenUses,
    values: Object.fromEntries(Object.entries(sets).map(([k, m]) => [k, [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))])),
  };
}

function table(result) {
  const u = result.inUse || result.distinct;
  const rows = [
    ['font sizes', u.fontSizes, result.distinct.fontSizes, result.onTokens.fontSizes],
    ['font families', u.fontFamilies, result.distinct.fontFamilies, 0],
    ['colours (with opacity)', u.colors, result.distinct.colors, result.onTokens.colors],
    ['colours (hues only)', u.hues, result.distinct.hues, 0],
    ['corner radii', u.radii, result.distinct.radii, result.onTokens.radii],
    ['shadows', u.shadows, result.distinct.shadows, result.onTokens.shadows],
    ['spacing steps (px)', u.spacing, result.distinct.spacing, result.onTokens.spacing],
  ];
  const lines = ['what                     distinct in use   hard-coded   uses on a token'];
  for (const [k, inUse, d, t] of rows) lines.push(`${k.padEnd(24)} ${String(inUse).padStart(8)}   ${String(d).padStart(12)}   ${String(t).padStart(12)}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const css = readFileSync(fileArg ? path.resolve(fileArg) : path.join(root, 'src/app.css'), 'utf8');
  const tokensCss = readFileSync(path.join(root, 'src/tokens.css'), 'utf8');
  const result = census(css, tokensCss);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(table(result));
    if (process.argv.includes('--values')) {
      for (const [k, list] of Object.entries(result.values)) {
        console.log(`\n${k}:`);
        for (const [v, n] of list) console.log(`  ${String(n).padStart(4)}  ${v}`);
      }
    }
  }
}
