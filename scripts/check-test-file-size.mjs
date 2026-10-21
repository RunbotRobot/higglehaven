#!/usr/bin/env node
// #2498 (sub-issue of #2497): a worker/*.test.js file that grows past
// roughly 200 tests sharing one D1 instance/worker isolate (vitest-pool-
// workers' per-file isolation model) can crash the whole `unit-tests` CI
// job outright with `RangeError: Maximum call stack size exceeded`, in
// tests completely unrelated to whatever PR happened to push it over the
// edge -- not a slow-test timeout, a hard crash. This has now hit three
// different files the same way: worker/index.test.js (#385/#389, 300+
// tests), worker/commerce.test.js (#1853, confirmed deterministic:
// 204 tests passed clean, 205 crashed), worker/land.test.js (#2448,
// crashed at ~6300 lines/197 tests). Each time, the fix was the same
// mechanical "split along existing describe blocks" move (#390, #1855,
// #2454) -- done reactively, after CI already broke on someone else's
// unrelated PR.
//
// This script makes that proactive instead: run as `pretest` (see
// package.json), it WARNS (never fails/exits non-zero) when a worker/
// *.test.js file's test count approaches the known crash range, with
// real margin below the observed 197-205 crash point -- a deliberately
// non-blocking signal, per #2498's own ask, so flagging this never
// becomes its own CI-blocking surprise. When it fires, the right
// response is filing a split issue the same shape as #2448 -> #2454,
// as routine maintenance, not an emergency.
//
// e2e/*.test.mjs files run via Playwright/wrangler dev (e2e/run-all.mjs),
// never through vitest-pool-workers' shared-D1-instance-per-file model --
// they are not at risk of this specific crash. They're still checked
// here (by line count only, no test-count data to calibrate against)
// purely as a general "this file is getting large" sanity signal, per
// #2498's own text naming both globs -- a much more generous threshold
// than the worker/ one, since nothing suggests they share the same
// failure mode.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// #1853's own file passed clean at 204 tests and crashed deterministically
// at 205 -- #2448's crashed at 197. 150 leaves real margin below both
// while still comfortably above every file in this repo as of #2498 (the
// largest, worker/worker-api.test.js, sits at 100).
export const WORKER_TEST_COUNT_WARNING = 150;
// Line count is a secondary signal alongside test count -- two files with
// the same test count can differ a lot in bulk depending on how much each
// individual test does. #2448's file was ~6300 lines at crash time; this
// leaves real margin below that too.
export const WORKER_LINE_COUNT_WARNING = 4500;
// No crash data backs this one (see header comment) -- just a generous
// "getting unwieldy" line beyond anything currently in e2e/.
export const E2E_LINE_COUNT_WARNING = 1500;

function countTests(source) {
  // Matches both `it(...)` and `it.only(...)`/`it.skip(...)` at any
  // indentation -- every worker/*.test.js file in this repo declares
  // tests this way (no it.each(), confirmed via a repo-wide grep when
  // this script was written).
  const matches = source.match(/\bit(\.(only|skip))?\(/g);
  return matches ? matches.length : 0;
}

function countLines(source) {
  return source.split('\n').length;
}

// Exported for direct testing -- see this file's own header for context.
// `files` is an array of { path, source } so this stays pure/testable
// without touching the real filesystem.
export function findOversizedTestFiles(files) {
  const warnings = [];
  for (const { path, source } of files) {
    const lines = countLines(source);
    if (path.endsWith('.test.js')) {
      const tests = countTests(source);
      if (tests >= WORKER_TEST_COUNT_WARNING || lines >= WORKER_LINE_COUNT_WARNING) {
        warnings.push({ path, lines, tests, threshold: 'worker' });
      }
    } else if (lines >= E2E_LINE_COUNT_WARNING) {
      warnings.push({ path, lines, tests: null, threshold: 'e2e' });
    }
  }
  return warnings;
}

function listTestFiles(dir, suffix) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name));
}

function main() {
  const paths = [
    ...listTestFiles(join(repoRoot, 'worker'), '.test.js'),
    ...listTestFiles(join(repoRoot, 'e2e'), '.test.mjs'),
  ];
  const files = paths.map((path) => ({ path, source: readFileSync(path, 'utf8') }));
  const warnings = findOversizedTestFiles(files);

  if (warnings.length > 0) {
    console.warn('Test file(s) approaching the known CI-crash/unwieldy-size threshold:');
    for (const { path, lines, tests, threshold } of warnings) {
      const relative = path.slice(repoRoot.length + 1);
      const testsPart = tests === null ? '' : `, ${tests} tests`;
      console.warn(`  ${relative}: ${lines} lines${testsPart} (${threshold} threshold)`);
    }
    console.warn(
      'Consider splitting along existing top-level describe blocks (see #390/#1855/#2454 for the ' +
      'established, zero-test-content-change recipe) as routine maintenance, before this grows into ' +
      'a CI-blocking crash (worker/*.test.js) or just becomes unwieldy (e2e/*.test.mjs).',
    );
  } else {
    console.log('No test files approaching the known size thresholds.');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
