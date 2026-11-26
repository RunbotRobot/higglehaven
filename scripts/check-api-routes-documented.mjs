#!/usr/bin/env node
// #4496: docs/API.md is what every session reads before changing the backend,
// and a route that exists but is not written there is how a sibling surface
// ends up without a protection (AGENTS.md, "Parity across sibling surfaces").
// Three routes (change-email, card-refusal, higgles-grants) shipped with no
// line in it before this check existed.
//
// The worker's router is a chain of `route[N] === 'literal'` tests spread
// over worker/index.js and worker/lib/*.js, not a table, so this reads those
// tests as text. Two rules, both about the routes a session adds the usual way:
//   1. every literal compared with `route[N]` appears in docs/API.md as a
//      path segment (`/literal`);
//   2. where the same line also names the HTTP method, the method and that
//      last literal appear within three lines of each other in docs/API.md.
// A route whose literal is built some other way is not seen; that is the limit
// of reading text, and the list of what is exempt is EXEMPT_SEGMENTS below.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// A segment that is a path parameter's own value or an internal word, never a
// documented route. Keep empty unless a real one turns up.
export const EXEMPT_SEGMENTS = new Set([]);

export function routeTests(source) {
  const out = [];
  source.split('\n').forEach((line, index) => {
    const literals = [...line.matchAll(/route\[\d\] === '([\w-]+)'/g)].map((m) => m[1]);
    if (!literals.length) return;
    const method = /request\.method === '(\w+)'/.exec(line);
    out.push({ line: index + 1, literals, method: method ? method[1] : null });
  });
  return out;
}

export function undocumentedRoutes(tests, docText) {
  const docLines = docText.split('\n');
  const problems = [];
  for (const t of tests) {
    for (const literal of t.literals) {
      if (EXEMPT_SEGMENTS.has(literal)) continue;
      if (!new RegExp(`/${literal.replace(/[-]/g, '\\-')}(?![\\w-])`).test(docText)) {
        problems.push({ ...t, missing: literal, why: 'no "/' + literal + '" anywhere in docs/API.md' });
      }
    }
    if (t.method) {
      const last = t.literals[t.literals.length - 1];
      if (EXEMPT_SEGMENTS.has(last)) continue;
      const re = new RegExp(`/${last.replace(/[-]/g, '\\-')}(?![\\w-])`);
      const near = docLines.some((d, i) => re.test(d)
        && docLines.slice(Math.max(0, i - 3), i + 4).some((n) => n.includes(t.method)));
      if (!near) problems.push({ ...t, missing: last, why: `no ${t.method} within three lines of "/${last}" in docs/API.md` });
    }
  }
  return problems;
}

function sourceFiles() {
  const dir = join(repoRoot, 'worker');
  const files = [join(dir, 'index.js')];
  for (const entry of readdirSync(join(dir, 'lib'))) {
    if (entry.endsWith('.js') && !entry.endsWith('.test.js')) files.push(join(dir, 'lib', entry));
  }
  return files;
}

function main() {
  const docText = readFileSync(join(repoRoot, 'docs/API.md'), 'utf8');
  let failed = 0;
  for (const file of sourceFiles()) {
    const problems = undocumentedRoutes(routeTests(readFileSync(file, 'utf8')), docText);
    for (const p of problems) {
      failed += 1;
      console.error(`${file.replace(`${repoRoot}/`, '')}:${p.line}: route "${p.literals.join('/')}" is not in docs/API.md (${p.why})`);
    }
  }
  if (failed) {
    console.error(`\n${failed} route(s) missing from docs/API.md. Add a section for each (method, auth, body, refusals) before merging (#4496).`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
