#!/usr/bin/env node
// #3003: replaces discover-e2e-files' own plain alphabetical, equal-COUNT
// chunking (the old `.../$SHARD_COUNT roughly-even chunks` jq slicing in
// .github/workflows/ci.yml) with weight-aware bin-packing, since equal
// count != equal time -- shard 1 (every admin-dashboard suite, the
// heaviest files in the repo, alphabetically first) took ~120min under
// fleet load against 53-81min for its siblings, past every patience
// threshold the fleet had been using, getting killed and re-queued
// repeatedly into the same already-contended pool.
//
// Uses the Longest-Processing-Time-first (LPT) greedy heuristic: sort
// files by weight descending, assign each one to whichever shard
// currently has the smallest running total. No exact-optimum guarantee,
// but SHARD_COUNT is small (4-6) and the real goal is "no shard radically
// longer than the others," not perfect balance -- LPT is simple and
// good enough for that.
//
// Weights come from e2e/shard-weights.json (filename -> last-observed
// elapsed ms, written by scripts/update-shard-weights.mjs from a green
// CI run's own job logs -- see that script's header comment). A file
// missing from the snapshot (a new test, or one added since the snapshot
// was last refreshed) falls back to the median of every known weight, so
// one unmeasured file doesn't starve or balloon a shard by assumption.
// With no snapshot data at all (e.g. a fresh checkout before the file is
// ever generated), every file falls back to a uniform weight of 1, which
// degrades this to a plain count-based split -- the same behavior
// discover-e2e-files had before this file existed, so an empty/missing
// snapshot is never worse than the old behavior, just not yet improved on
// it.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// #2861/#2874: kept in its own always-isolated shard regardless of
// weight, same as discover-e2e-files' own prior jq logic -- this file
// drives two concurrent real browser sessions through real Stripe API
// round-trips rather than the simulated-purchase seam every other file
// uses, plausibly heavier than ordinary weight-based packing accounts
// for, so it keeps a dedicated shard of its own.
export const ISOLATED_FILE = 'purchase-checkout-real-stripe.test.mjs';

export function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Longest-Processing-Time-first greedy bin packing into `shardCount`
// shards. Returns an array of `shardCount` arrays of filenames (some may
// be empty if there are fewer files than shards).
export function binPack(files, weights, shardCount) {
  const fallback = median(Object.values(weights));
  const withWeights = files.map((file) => ({ file, weight: weights[file] ?? fallback }));
  // Stable descending sort by weight -- ties keep their original
  // (alphabetical, since callers pass a sorted file list) relative order,
  // so output stays deterministic run to run for an unchanged weights file.
  withWeights.sort((a, b) => b.weight - a.weight);
  const shards = Array.from({ length: shardCount }, () => ({ files: [], total: 0 }));
  for (const { file, weight } of withWeights) {
    const lightest = shards.reduce((min, shard) => (shard.total < min.total ? shard : min), shards[0]);
    lightest.files.push(file);
    lightest.total += weight;
  }
  return shards.map((shard) => shard.files);
}

// Exported so a test can pass in an explicit file list/weights without
// touching the real filesystem; main() below supplies the real ones.
export function computeShards({ files, weights, shardCount }) {
  const hasIsolated = files.includes(ISOLATED_FILE);
  const rest = files.filter((name) => name !== ISOLATED_FILE);
  const shards = binPack(rest, weights, shardCount).filter((shard) => shard.length > 0);
  if (hasIsolated) shards.push([ISOLATED_FILE]);
  return shards;
}

function main() {
  const shardCount = Number(process.env.SHARD_COUNT || '4');
  const allFiles = readdirSync(path.join(repoRoot, 'e2e'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();

  let weights = {};
  try {
    weights = JSON.parse(readFileSync(path.join(repoRoot, 'e2e', 'shard-weights.json'), 'utf8'));
  } catch {
    // Missing or unparseable -- fall back to the uniform-weight
    // (count-based) behavior documented in this file's header comment.
  }

  const shards = computeShards({ files: allFiles, weights, shardCount });
  console.log(JSON.stringify(shards));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
