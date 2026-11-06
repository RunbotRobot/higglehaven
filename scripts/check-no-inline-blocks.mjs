#!/usr/bin/env node
// #1360: worker/lib/csp.js's script-src and style-src no longer carry
// 'unsafe-inline', so an inline <script> block or <style> element in a served
// HTML page is silently ignored by the browser -- the page just stops
// working, and nothing on the server side can see it. This runs as `pretest`
// (see package.json) so adding one is a loud failure here instead of a broken
// admin page found later.
//
// What it flags, per HTML file (index.html and public/*.html):
//   - <script> with no src attribute and an executable type (no type, or a
//     JavaScript/module type). Data blocks (type="application/json" and
//     similar) are never executed, so CSP does not touch them.
//   - any <style> element.
// What it does not flag: style="" attributes. Those stay allowed through
// style-src-attr (see csp.js for why), so they are not this script's business.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXECUTABLE_SCRIPT_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);

function attributeOf(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

// Returns [{ kind: 'script' | 'style', line }] for each offending element.
export function findInlineBlocks(html) {
  const found = [];
  const tagPattern = /<(script|style)\b[^>]*>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const kind = match[1].toLowerCase();
    const line = html.slice(0, match.index).split('\n').length;
    if (kind === 'style') {
      found.push({ kind, line });
      continue;
    }
    if (attributeOf(match[0], 'src') !== null) continue;
    const type = (attributeOf(match[0], 'type') ?? '').trim().toLowerCase();
    if (EXECUTABLE_SCRIPT_TYPES.has(type)) found.push({ kind, line });
  }
  return found;
}

export function listHtmlFiles(root = repoRoot, readdirImpl = readdirSync) {
  const files = [join(root, 'index.html')];
  for (const entry of readdirImpl(join(root, 'public'), { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name.endsWith('.html')) files.push(join(root, 'public', entry.name));
  }
  return files;
}

function main() {
  const failures = [];
  const files = listHtmlFiles();
  for (const file of files) {
    for (const block of findInlineBlocks(readFileSync(file, 'utf8'))) {
      failures.push(`${file.slice(repoRoot.length + 1)}:${block.line} inline <${block.kind}>`);
    }
  }
  if (failures.length > 0) {
    console.error(
      'Inline <script>/<style> blocks are blocked by the Content-Security-Policy (worker/lib/csp.js has no ' +
      "'unsafe-inline' for scripts or style elements), so the page would silently stop working:",
    );
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('Move the block to a file and reference it with <script src> / <link rel="stylesheet"> (#1360).');
    process.exit(1);
  }
  console.log(`No inline <script>/<style> blocks in ${files.length} HTML file(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
