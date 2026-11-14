// Backfill of mid and far models for products that predate them (#3415, Model
// tiers 3/7, part of #3412). New uploads get their tiers at upload time
// (#3414); every product uploaded before that has model_mid_url and
// model_far_url NULL. This is the selection, validation and recording logic
// of the one-off script that gives them tiers; scripts/backfill-model-tiers.mjs
// is the command line around it (wrangler for D1 and R2, headless Chromium
// for the three.js work), and everything that touches the outside world is
// injected here so the logic can be tested without any of it.
//
// What "the same path as an upload" means here. An upload stores a tier as a
// content-addressed object (models/<sha256>.glb) in the MODELS bucket, after
// the same checks the server applies to any model (valid .glb, under the size
// limit) plus one of its own: a tier must be smaller than the full model. It
// then records the object's /uploads/ URL on the product. The backfill does
// exactly that, in that order, and never records a tier it did not store.
//
// Idempotent and resumable by construction. A model is a candidate only while
// BOTH tier columns are NULL, and the record step only updates rows where they
// still are, so a finished model is never selected again, a half-finished run
// loses nothing (a stored object nobody names yet is just re-put with
// identical bytes next time), and a second run, or a run racing a live upload
// or a seller replacing a model, cannot overwrite a newer value.
import { validateGlb, MAX_MODEL_BYTES } from '../worker/lib/storage.js';

// The shape of a stored tier (and of any model uploaded since models were
// content-addressed). Every tier URL interpolated into a statement has matched
// this first; a source model may also be a legacy name (below).
export const MODEL_URL_PATTERN = /^\/uploads\/models\/[0-9a-f]{64}\.glb$/;
export const MODEL_KEY_PATTERN = /^models\/[0-9a-f]{64}\.glb$/;
// #3522: models uploaded before models were content-addressed are stored under
// a random UUID (models/<uuid>.glb) and are still what some products point at
// (the owner's brick among them). They are valid SOURCES: the script may read
// them and key an UPDATE on them. A TIER the script stores is always
// content-addressed, so MODEL_URL_PATTERN above still guards every tier URL.
export const LEGACY_MODEL_URL_PATTERN = /^\/uploads\/models\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.glb$/;
export function isSourceModelUrl(value) {
  return typeof value === 'string' && (MODEL_URL_PATTERN.test(value) || LEGACY_MODEL_URL_PATTERN.test(value));
}
export const GLB_CONTENT_TYPE = 'model/gltf-binary';

export const DEFAULT_DATABASE = 'higglehaven-db';
export const DEFAULT_BUCKET = 'higglehaven-models';

// Products and catalog listings both carry model_url and the tier columns
// (migration 0220), and "Sell this too" and Duplicate read the products row,
// so both are candidates and both are recorded. Tiers depend only on the
// model file, so the unit of work is the distinct model_url, not the row.
export const CANDIDATES_SQL = `
SELECT model_url, category FROM (
  SELECT model_url, category FROM catalog_templates
  WHERE model_url IS NOT NULL AND model_mid_url IS NULL AND model_far_url IS NULL
  UNION ALL
  SELECT model_url, category FROM products
  WHERE model_url IS NOT NULL AND model_mid_url IS NULL AND model_far_url IS NULL
) ORDER BY model_url`.trim();

export function modelUrlToKey(modelUrl) {
  if (!isSourceModelUrl(modelUrl)) throw new Error(`Not a stored model URL: ${modelUrl}`);
  return modelUrl.slice('/uploads/'.length);
}

export function keyToModelUrl(key) {
  if (!MODEL_KEY_PATTERN.test(key)) throw new Error(`Not a stored model key: ${key}`);
  return `/uploads/${key}`;
}

// Same digest the server names an uploaded model by (worker/lib/models.js).
// Web Crypto, so it runs the same in node and in the test pool.
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// One entry per distinct model, in a stable order. A model whose every row is
// an avatar is a skinned character, not a placed item, and is skipped without
// being downloaded; a model shared with a non-avatar row is kept (the
// generator itself declines anything skinned). Rows whose URL is not a stored
// model (a hand-edited or legacy value) are reported, not guessed at.
// A built-in model is a static file shipped with the app (/models/brick.glb and
// the like), not an upload (#3522). It is not read from the bucket and the
// tier columns only hold /uploads/ URLs, so the script leaves it alone on
// purpose: the viewer builds its simpler versions in the browser from the full
// file, exactly as for any product without stored ones (src/world/models.js),
// so it is still drawn as itself at every distance.
export const BUILT_IN_MODEL_PATTERN = /^\/models\/[A-Za-z0-9_-]+\.glb$/;

export function groupCandidates(rows) {
  const byUrl = new Map();
  const unrecognised = [];
  const builtIn = [];
  for (const row of rows) {
    const modelUrl = row.model_url ?? row.modelUrl;
    const category = row.category ?? null;
    if (BUILT_IN_MODEL_PATTERN.test(modelUrl)) {
      if (!builtIn.includes(modelUrl)) builtIn.push(modelUrl);
      continue;
    }
    if (!isSourceModelUrl(modelUrl)) {
      if (!unrecognised.includes(modelUrl)) unrecognised.push(modelUrl);
      continue;
    }
    const entry = byUrl.get(modelUrl) ?? { modelUrl, avatarOnly: true };
    if (category !== 'avatar') entry.avatarOnly = false;
    byUrl.set(modelUrl, entry);
  }
  return {
    candidates: [...byUrl.values()].sort((a, b) => (a.modelUrl < b.modelUrl ? -1 : 1)),
    builtIn: builtIn.sort(),
    unrecognised,
  };
}

// Every value interpolated into a statement is checked here first: the model
// is a stored model URL (content-addressed or a legacy UUID name) and a tier is
// a content-addressed one, so none can carry SQL.
function assertSafeForSql(modelUrl, midUrl, farUrl) {
  if (!isSourceModelUrl(modelUrl)) throw new Error(`Refusing to build SQL from ${String(modelUrl)}`);
  for (const value of [midUrl, farUrl]) {
    if (value !== null && value !== undefined && !MODEL_URL_PATTERN.test(value)) {
      throw new Error(`Refusing to build SQL from ${String(value)}`);
    }
  }
}

// The UPDATE statements that record a model's tiers. Guarded on the model
// still being the same file and on both columns still being NULL, so a seller
// who replaced the model (which clears the tiers) or an upload that already
// brought its own tiers is never overwritten. Every interpolated value is a
// URL that matched MODEL_URL_PATTERN, so none can carry SQL.
export function buildRecordStatements(modelUrl, { midUrl, farUrl }) {
  assertSafeForSql(modelUrl, midUrl, farUrl);
  const quote = (value) => (value ? `'${value}'` : 'NULL');
  return ['catalog_templates', 'products'].map((table) => (
    `UPDATE ${table} SET model_mid_url = ${quote(midUrl)}, model_far_url = ${quote(farUrl)} `
    + `WHERE model_url = '${modelUrl}' AND model_mid_url IS NULL AND model_far_url IS NULL`
  ));
}

// How many rows of the model now carry exactly the tiers just recorded. The
// UPDATEs' own "rows changed" figure is not available from every wrangler
// target (the local one omits it), so the count is read back instead; zero
// means a newer value was already there and nothing was recorded.
export function buildRecordedCountStatement(modelUrl, { midUrl, farUrl }) {
  assertSafeForSql(modelUrl, midUrl, farUrl);
  const quote = (value) => (value ? `'${value}'` : 'NULL');
  const count = (table) => (
    `(SELECT COUNT(*) FROM ${table} WHERE model_url = '${modelUrl}' `
    + `AND model_mid_url IS ${quote(midUrl)} AND model_far_url IS ${quote(farUrl)})`
  );
  return `SELECT ${count('catalog_templates')} + ${count('products')} AS recorded`;
}

// Checks a generated tier the way the server checks an upload, plus the rule
// that a tier must be smaller than the model it stands in for. Returns the
// problem as a sentence, or null when the tier is fine to store.
export function tierProblem(tierBytes, fullSizeBytes) {
  if (!tierBytes || tierBytes.byteLength === 0) return 'is empty';
  if (tierBytes.byteLength > MAX_MODEL_BYTES) return 'is over the model size limit';
  if (tierBytes.byteLength >= fullSizeBytes) return 'is not smaller than the full model';
  try {
    const copy = tierBytes.buffer.slice(tierBytes.byteOffset, tierBytes.byteOffset + tierBytes.byteLength);
    validateGlb(copy);
  } catch (err) {
    return `is not a valid .glb (${err.message})`;
  }
  return null;
}

// io is:
//   readModel(key)            -> Uint8Array of the stored full model
//   generateTiers(bytes)      -> { skinned: boolean, mid: Uint8Array|null, far: Uint8Array|null }
//   storeTier(key, bytes)     -> stores the object (content type model/gltf-binary)
//   recordTiers(modelUrl, {midUrl, farUrl}) -> number of rows updated
// Each model is handled on its own: one that fails is reported and the run
// carries on, so a single bad file never blocks the rest.
export async function runBackfill({
  candidates, io, dryRun = false, limit = Infinity, maxTotalBytes = Infinity, log = () => {},
}) {
  const summary = {
    dryRun,
    candidates: candidates.length,
    skippedAvatar: 0,
    skippedSkinned: 0,
    nothingToStore: 0,
    modelsWithTiers: 0,
    tiersStored: 0,
    bytesAdded: 0,
    rowsRecorded: 0,
    failed: [],
    deferred: 0,
    wouldProcess: 0,
  };
  let attempted = 0;
  for (const candidate of candidates) {
    if (candidate.avatarOnly) {
      summary.skippedAvatar += 1;
      log(`skip   ${candidate.modelUrl} (avatar)`);
      continue;
    }
    if (attempted >= limit) {
      summary.deferred += 1;
      continue;
    }
    attempted += 1;
    if (dryRun) {
      summary.wouldProcess += 1;
      log(`would  ${candidate.modelUrl}`);
      continue;
    }
    try {
      const full = await io.readModel(modelUrlToKey(candidate.modelUrl));
      validateGlb(full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength));
      const generated = await io.generateTiers(full);
      if (generated.skinned) {
        summary.skippedSkinned += 1;
        log(`skip   ${candidate.modelUrl} (skinned)`);
        continue;
      }
      const urls = { midUrl: null, farUrl: null };
      for (const [name, field] of [['mid', 'midUrl'], ['far', 'farUrl']]) {
        const bytes = generated[name];
        if (!bytes) continue;
        const problem = tierProblem(bytes, full.byteLength);
        if (problem) {
          log(`drop   ${candidate.modelUrl} ${name} ${problem}`);
          continue;
        }
        if (summary.bytesAdded + bytes.byteLength > maxTotalBytes) {
          throw new Error(`storing the ${name} version would pass the ${maxTotalBytes} byte limit for this run`);
        }
        const key = `models/${await sha256Hex(bytes)}.glb`;
        await io.storeTier(key, bytes);
        urls[field] = keyToModelUrl(key);
        summary.tiersStored += 1;
        summary.bytesAdded += bytes.byteLength;
      }
      if (!urls.midUrl && !urls.farUrl) {
        summary.nothingToStore += 1;
        log(`none   ${candidate.modelUrl} (already small enough, or nothing to reduce)`);
        continue;
      }
      summary.rowsRecorded += await io.recordTiers(candidate.modelUrl, urls);
      summary.modelsWithTiers += 1;
      log(`done   ${candidate.modelUrl} mid=${urls.midUrl ?? '-'} far=${urls.farUrl ?? '-'}`);
    } catch (err) {
      summary.failed.push({ modelUrl: candidate.modelUrl, reason: err.message });
      log(`FAILED ${candidate.modelUrl}: ${err.message}`);
    }
  }
  return summary;
}

export function formatSummary(summary) {
  const lines = [
    summary.dryRun ? 'Dry run: nothing was downloaded, stored or recorded.' : 'Backfill finished.',
    `  models without tiers (distinct): ${summary.candidates}`,
    `  skipped, avatar (not placed items): ${summary.skippedAvatar}`,
  ];
  if (summary.dryRun) {
    lines.push(`  would process: ${summary.wouldProcess}`);
  } else {
    lines.push(
      `  skipped, skinned: ${summary.skippedSkinned}`,
      `  nothing worth storing: ${summary.nothingToStore}`,
      `  models given tiers: ${summary.modelsWithTiers} (${summary.tiersStored} tier files, ${summary.bytesAdded} bytes)`,
      `  database rows updated: ${summary.rowsRecorded}`,
      `  failed: ${summary.failed.length}`,
    );
    for (const failure of summary.failed) lines.push(`    ${failure.modelUrl}: ${failure.reason}`);
  }
  if (summary.deferred > 0) lines.push(`  left for the next run (--limit): ${summary.deferred}`);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    mode: null, dryRun: false, limit: Infinity, maxTotalBytes: 200 * 1024 * 1024,
    database: DEFAULT_DATABASE, bucket: DEFAULT_BUCKET, persistTo: null,
  };
  const need = (flag, value) => {
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--local' || arg === '--remote') {
      const mode = arg.slice(2);
      if (options.mode && options.mode !== mode) throw new Error('Choose one of --local or --remote, not both');
      options.mode = mode;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--limit' || arg === '--max-total-bytes') {
      const value = Number(need(arg, argv[i + 1]));
      i += 1;
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} must be a whole number of at least 1`);
      if (arg === '--limit') options.limit = value;
      else options.maxTotalBytes = value;
    } else if (arg === '--database' || arg === '--bucket' || arg === '--persist-to') {
      const key = arg === '--persist-to' ? 'persistTo' : arg.slice(2);
      options[key] = need(arg, argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  if (options.persistTo && options.mode !== 'local') throw new Error('--persist-to only applies to --local');
  if (!options.mode) throw new Error('Say which database to use: --local (the wrangler dev one) or --remote (production)');
  return options;
}
