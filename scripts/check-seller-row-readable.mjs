#!/usr/bin/env node
// #3589: in Sell > My products a product's detail lines ("Not priced", "Returns: accepted", the
// size, ...) and its Edit/More/Reviews/Sales links are things a person reads and taps on a phone.
// They were 11px at 65% ink (about 4.3 on the expanded row's green, under the 4.5 floor in
// docs/DESIGN.md) and the links were about 18px tall. This keeps them at 13px in full ink, with
// 44px tap targets. (A node check, not a vitest case: vitest hands tests an empty app.css.)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

const DETAIL_LINES = [
  '.seller-row-dims',
  '.seller-row-price',
  '.seller-row-digital-good',
  '.seller-row-no-returns',
  '.seller-row-domestic-only',
];

export function findProblems(rawCss) {
  const css = stripComments(rawCss);
  const problems = [];
  for (const selector of DETAIL_LINES) {
    const body = ruleBody(css, selector);
    if (body === null) {
      problems.push(`${selector}: rule not found`);
      continue;
    }
    if (!/font-size:\s*var\(--text-sm\)/.test(body)) problems.push(`${selector}: must be 13px (var(--text-sm))`);
    if (!/color:\s*var\(--pill-text\)\s*;/.test(body)) problems.push(`${selector}: must be full ink (var(--pill-text))`);
  }
  const toggle = ruleBody(css, '.seller-extensibility-toggle');
  if (toggle === null) problems.push('.seller-extensibility-toggle: rule not found');
  else {
    if (!/min-height:\s*44px/.test(toggle)) problems.push('.seller-extensibility-toggle: must be at least 44px tall');
    if (!/color:\s*var\(--pill-text\)\s*;/.test(toggle)) problems.push('.seller-extensibility-toggle: must be full ink (var(--pill-text))');
    if (!/font:\s*var\(--text-sm\)/.test(toggle)) problems.push('.seller-extensibility-toggle: must be 13px (var(--text-sm))');
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = findProblems(readFileSync(path.join(root, 'src/app.css'), 'utf8'));
  if (problems.length) {
    console.error('check-seller-row-readable (#3589) failed:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('check-seller-row-readable: ok');
}
