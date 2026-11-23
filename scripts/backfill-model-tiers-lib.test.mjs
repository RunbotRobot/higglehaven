import { describe, expect, it } from 'vitest';
import {
  CANDIDATES_SQL, CRACKED_CANDIDATES_SQL, CRACK_TOLERANCE_EDGES, LEGACY_MODEL_URL_PATTERN, MODEL_URL_PATTERN, buildRecordStatements,
  buildRecordedCountStatement, buildReplaceStatements, formatRedoSummary, formatSummary, groupCandidates, groupCrackCandidates,
  keyToModelUrl, modelUrlToKey, parseArgs, runBackfill, runRedoCracked, sha256Hex, tierProblem,
} from './backfill-model-tiers-lib.mjs';

// A minimal valid binary glTF: header, one JSON chunk carrying asset.version,
// padded with spaces to the requested size (JSON allows trailing whitespace).
function makeGlb(totalBytes = 64, tag = '') {
  const json = JSON.stringify({ asset: { version: '2.0' }, extras: tag });
  const padded = json.padEnd(Math.max(json.length, totalBytes - 20), ' ');
  const jsonBytes = new TextEncoder().encode(padded);
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const out = new Uint8Array(20 + jsonLength);
  out.fill(0x20);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  return out;
}

const urlFor = async (bytes) => `/uploads/models/${await sha256Hex(bytes)}.glb`;

// An in-memory stand-in for D1 and R2 holding the rows the script selects
// and updates, with the same guard the real UPDATE has.
function makeWorld(models) {
  const objects = new Map();
  const rows = { catalog_templates: [], products: [] };
  return {
    objects,
    rows,
    async addModel({ bytes, category = 'furniture', tables = ['catalog_templates', 'products'] }) {
      const modelUrl = await urlFor(bytes);
      objects.set(modelUrl.slice('/uploads/'.length), bytes);
      for (const table of tables) rows[table].push({ model_url: modelUrl, category, model_mid_url: null, model_far_url: null });
      return modelUrl;
    },
    candidateRows() {
      return Object.values(rows).flat().filter((row) => !row.model_mid_url && !row.model_far_url).map((row) => ({ model_url: row.model_url, category: row.category }));
    },
    io(generate) {
      const world = this;
      return {
        async readModel(key) { return world.objects.get(key); },
        generateTiers: generate,
        async storeTier(key, bytes) { world.objects.set(key, bytes); },
        async recordTiers(modelUrl, { midUrl, farUrl }) {
          let changed = 0;
          for (const table of Object.values(world.rows)) {
            for (const row of table) {
              if (row.model_url === modelUrl && !row.model_mid_url && !row.model_far_url) {
                row.model_mid_url = midUrl;
                row.model_far_url = farUrl;
                changed += 1;
              }
            }
          }
          return changed;
        },
      };
    },
    models,
  };
}

const halve = (bytes) => ({ skinned: false, mid: makeGlb(Math.floor(bytes.byteLength * 0.6), 'mid'), far: makeGlb(Math.floor(bytes.byteLength * 0.3), 'far') });

describe('selecting the models to backfill (#3415)', () => {
  it('groups rows by distinct model, in a stable order, and flags avatar-only models', () => {
    const a = `/uploads/models/${'a'.repeat(64)}.glb`;
    const b = `/uploads/models/${'b'.repeat(64)}.glb`;
    const c = `/uploads/models/${'c'.repeat(64)}.glb`;
    const { candidates, unrecognised, builtIn } = groupCandidates([
      { model_url: b, category: 'furniture' },
      { model_url: a, category: 'avatar' },
      { model_url: a, category: 'avatar' },
      { model_url: c, category: 'avatar' },
      { model_url: c, category: 'decor' },
      { model_url: '/models/brick.glb', category: 'furniture' },
    ]);
    expect(candidates).toEqual([
      { modelUrl: a, avatarOnly: true },
      { modelUrl: b, avatarOnly: false },
      { modelUrl: c, avatarOnly: false },
    ]);
    // A built-in static model is reported on its own, not as an unrecognised value (#3522).
    expect(builtIn).toEqual(['/models/brick.glb']);
    expect(unrecognised).toEqual([]);
  });

  it('keeps an upload stored under an older UUID name, and still reports a value that is neither', () => {
    const legacy = '/uploads/models/121033e5-790f-4a22-9353-ecf9735b158a.glb';
    const { candidates, unrecognised, builtIn } = groupCandidates([
      { model_url: legacy, category: 'building-material' },
      { model_url: legacy, category: 'building-material' },
      { model_url: '/uploads/models/not-a-uuid.glb', category: 'decor' },
      { model_url: '/models/chair.glb', category: 'furniture' },
      { model_url: '/models/tree.glb', category: 'furniture' },
    ]);
    expect(candidates).toEqual([{ modelUrl: legacy, avatarOnly: false }]);
    expect(unrecognised).toEqual(['/uploads/models/not-a-uuid.glb']);
    expect(builtIn).toEqual(['/models/chair.glb', '/models/tree.glb']);
  });

  it('selects only rows with a model and no tiers, from both tables', () => {
    expect(CANDIDATES_SQL).toMatch(/FROM catalog_templates/);
    expect(CANDIDATES_SQL).toMatch(/FROM products/);
    expect(CANDIDATES_SQL.match(/model_mid_url IS NULL AND model_far_url IS NULL/g)).toHaveLength(2);
    expect(CANDIDATES_SQL.match(/model_url IS NOT NULL/g)).toHaveLength(2);
  });

  it('turns a model URL into its bucket key and back, and refuses anything else', () => {
    const url = `/uploads/models/${'1'.repeat(64)}.glb`;
    expect(modelUrlToKey(url)).toBe(`models/${'1'.repeat(64)}.glb`);
    expect(keyToModelUrl(modelUrlToKey(url))).toBe(url);
    expect(() => modelUrlToKey('/uploads/models/../etc.glb')).toThrow();
    expect(() => keyToModelUrl('models/short.glb')).toThrow();
    expect(MODEL_URL_PATTERN.test(`${url}'; DROP TABLE products; --`)).toBe(false);
  });

  it('reads a legacy-named upload by its key, but never accepts one as a tier or with SQL attached', () => {
    const legacy = '/uploads/models/121033e5-790f-4a22-9353-ecf9735b158a.glb';
    expect(modelUrlToKey(legacy)).toBe('models/121033e5-790f-4a22-9353-ecf9735b158a.glb');
    expect(MODEL_URL_PATTERN.test(legacy)).toBe(false);
    expect(LEGACY_MODEL_URL_PATTERN.test(`${legacy}'; DROP TABLE products; --`)).toBe(false);
    expect(() => modelUrlToKey('/uploads/models/121033e5-790f-4a22-9353-ecf9735b158.glb')).toThrow();
    const tier = `/uploads/models/${'b'.repeat(64)}.glb`;
    const [statement] = buildRecordStatements(legacy, { midUrl: tier, farUrl: null });
    expect(statement).toContain(`WHERE model_url = '${legacy}'`);
    expect(() => buildRecordStatements(tier, { midUrl: legacy, farUrl: null })).toThrow(/Refusing/);
    expect(() => buildRecordStatements(`${legacy}'; --`, { midUrl: tier, farUrl: null })).toThrow(/Refusing/);
  });
});

describe('recording tiers (#3415)', () => {
  const full = `/uploads/models/${'a'.repeat(64)}.glb`;
  const mid = `/uploads/models/${'b'.repeat(64)}.glb`;
  const far = `/uploads/models/${'c'.repeat(64)}.glb`;

  it('updates both tables, only where the same model still has no tiers', () => {
    const statements = buildRecordStatements(full, { midUrl: mid, farUrl: far });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(`UPDATE catalog_templates SET model_mid_url = '${mid}', model_far_url = '${far}' WHERE model_url = '${full}' AND model_mid_url IS NULL AND model_far_url IS NULL`);
    expect(statements[1]).toMatch(/^UPDATE products SET/);
  });

  it('writes NULL for a tier that was not made', () => {
    const [statement] = buildRecordStatements(full, { midUrl: mid, farUrl: null });
    expect(statement).toContain("model_far_url = NULL");
  });

  it('reads back how many rows carry the recorded tiers, comparing NULL safely', () => {
    const statement = buildRecordedCountStatement(full, { midUrl: mid, farUrl: null });
    expect(statement).toContain(`model_mid_url IS '${mid}' AND model_far_url IS NULL`);
    expect(statement).toMatch(/FROM catalog_templates/);
    expect(statement).toMatch(/FROM products/);
    expect(() => buildRecordedCountStatement(full, { midUrl: "'; --", farUrl: null })).toThrow(/Refusing/);
  });

  it('refuses to build SQL from anything that is not a stored model URL', () => {
    expect(() => buildRecordStatements(full, { midUrl: "x'; DROP TABLE products; --", farUrl: null })).toThrow(/Refusing/);
    expect(() => buildRecordStatements("/uploads/models/x.glb", { midUrl: mid, farUrl: far })).toThrow(/Refusing/);
  });
});

describe('checking a generated tier (#3415)', () => {
  it('accepts a smaller valid .glb and names each way a tier can be wrong', () => {
    const fullSize = 4000;
    expect(tierProblem(makeGlb(1000), fullSize)).toBeNull();
    expect(tierProblem(null, fullSize)).toBe('is empty');
    expect(tierProblem(new Uint8Array(0), fullSize)).toBe('is empty');
    expect(tierProblem(makeGlb(4000), fullSize)).toBe('is not smaller than the full model');
    expect(tierProblem(makeGlb(5000), fullSize)).toBe('is not smaller than the full model');
    expect(tierProblem(new Uint8Array(200).fill(7), fullSize)).toMatch(/^is not a valid \.glb/);
  });
});

describe('running the backfill (#3415)', () => {
  it('gives every placeable model its tiers, records both tables, and counts what it skipped', async () => {
    const world = makeWorld();
    const chair = await world.addModel({ bytes: makeGlb(4000, 'chair') });
    const lamp = await world.addModel({ bytes: makeGlb(3000, 'lamp'), tables: ['products'] });
    const avatar = await world.addModel({ bytes: makeGlb(5000, 'avatar'), category: 'avatar' });
    const { candidates } = groupCandidates(world.candidateRows());
    expect(candidates).toHaveLength(3);

    const summary = await runBackfill({ candidates, io: world.io(async (bytes) => halve(bytes)) });
    expect(summary).toMatchObject({
      candidates: 3, skippedAvatar: 1, skippedSkinned: 0, nothingToStore: 0,
      modelsWithTiers: 2, tiersStored: 4, rowsRecorded: 3, failed: [], dryRun: false,
    });
    expect(summary.bytesAdded).toBeGreaterThan(0);

    const chairRows = [...world.rows.catalog_templates, ...world.rows.products].filter((row) => row.model_url === chair);
    expect(chairRows).toHaveLength(2);
    for (const row of chairRows) {
      expect(row.model_mid_url).toMatch(MODEL_URL_PATTERN);
      expect(row.model_far_url).toMatch(MODEL_URL_PATTERN);
      // The stored object exists and is the content its name says it is.
      const stored = world.objects.get(modelUrlToKey(row.model_mid_url));
      expect(row.model_mid_url).toBe(await urlFor(stored));
    }
    expect(world.rows.products.find((row) => row.model_url === lamp).model_far_url).toMatch(MODEL_URL_PATTERN);
    expect(world.rows.products.some((row) => row.model_url === avatar && row.model_mid_url)).toBe(false);
  });

  it('gives an upload stored under an older UUID name its tiers, content-addressed (#3522)', async () => {
    const world = makeWorld();
    const legacy = '/uploads/models/121033e5-790f-4a22-9353-ecf9735b158a.glb';
    const bytes = makeGlb(4000, 'brick');
    world.objects.set(legacy.slice('/uploads/'.length), bytes);
    for (const table of ['catalog_templates', 'products']) world.rows[table].push({ model_url: legacy, category: 'building-material', model_mid_url: null, model_far_url: null });
    const { candidates } = groupCandidates(world.candidateRows());
    expect(candidates).toHaveLength(1);
    const summary = await runBackfill({ candidates, io: world.io(async (b) => halve(b)) });
    expect(summary).toMatchObject({ modelsWithTiers: 1, tiersStored: 2, rowsRecorded: 2, failed: [] });
    for (const row of [...world.rows.catalog_templates, ...world.rows.products]) {
      expect(row.model_url).toBe(legacy);
      expect(row.model_mid_url).toMatch(MODEL_URL_PATTERN);
      expect(row.model_far_url).toMatch(MODEL_URL_PATTERN);
    }
  });

  it('is idempotent: a second run finds nothing left to do and changes nothing', async () => {
    const world = makeWorld();
    await world.addModel({ bytes: makeGlb(4000, 'chair') });
    await world.addModel({ bytes: makeGlb(3000, 'lamp') });
    const first = await runBackfill({ candidates: groupCandidates(world.candidateRows()).candidates, io: world.io(async (bytes) => halve(bytes)) });
    expect(first.modelsWithTiers).toBe(2);
    const objectsAfterFirst = world.objects.size;
    const snapshot = JSON.stringify(world.rows);

    const remaining = groupCandidates(world.candidateRows()).candidates;
    expect(remaining).toEqual([]);
    const second = await runBackfill({ candidates: remaining, io: world.io(async () => { throw new Error('must not generate'); }) });
    expect(second).toMatchObject({ candidates: 0, modelsWithTiers: 0, tiersStored: 0, rowsRecorded: 0 });
    expect(world.objects.size).toBe(objectsAfterFirst);
    expect(JSON.stringify(world.rows)).toBe(snapshot);
  });

  it('is resumable: models that failed or were not reached are picked up by the next run', async () => {
    const world = makeWorld();
    await world.addModel({ bytes: makeGlb(4000, 'one') });
    await world.addModel({ bytes: makeGlb(4100, 'two') });
    await world.addModel({ bytes: makeGlb(4200, 'three') });
    let calls = 0;
    const flaky = async (bytes) => {
      calls += 1;
      if (calls === 1) throw new Error('browser crashed');
      return halve(bytes);
    };
    const first = await runBackfill({ candidates: groupCandidates(world.candidateRows()).candidates, io: world.io(flaky), limit: 2 });
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].reason).toBe('browser crashed');
    expect(first.modelsWithTiers).toBe(1);
    expect(first.deferred).toBe(1);

    const rest = groupCandidates(world.candidateRows()).candidates;
    expect(rest).toHaveLength(2);
    const second = await runBackfill({ candidates: rest, io: world.io(async (bytes) => halve(bytes)) });
    expect(second.modelsWithTiers).toBe(2);
    expect(groupCandidates(world.candidateRows()).candidates).toEqual([]);
  });

  it('skips a skinned model without storing or recording anything', async () => {
    const world = makeWorld();
    await world.addModel({ bytes: makeGlb(4000, 'rig') });
    const summary = await runBackfill({
      candidates: groupCandidates(world.candidateRows()).candidates,
      io: world.io(async () => ({ skinned: true, mid: null, far: null })),
    });
    expect(summary).toMatchObject({ skippedSkinned: 1, modelsWithTiers: 0, tiersStored: 0, rowsRecorded: 0 });
    expect(world.objects.size).toBe(1);
  });

  it('stores nothing for a model the builder declined, and drops a tier that is not smaller', async () => {
    const world = makeWorld();
    await world.addModel({ bytes: makeGlb(4000, 'tiny') });
    await world.addModel({ bytes: makeGlb(4100, 'bloated') });
    const generate = async (bytes) => (
      new TextDecoder().decode(bytes).includes('tiny')
        ? { skinned: false, mid: null, far: null }
        : { skinned: false, mid: makeGlb(bytes.byteLength + 8, 'bigger'), far: makeGlb(900, 'far') }
    );
    const summary = await runBackfill({ candidates: groupCandidates(world.candidateRows()).candidates, io: world.io(generate) });
    expect(summary.nothingToStore).toBe(1);
    expect(summary.modelsWithTiers).toBe(1);
    expect(summary.tiersStored).toBe(1);
    const bloated = world.rows.catalog_templates.find((row) => row.model_far_url);
    expect(bloated.model_mid_url).toBeNull();
  });

  it('does not overwrite tiers a live upload recorded while the script was working', async () => {
    const world = makeWorld();
    const modelUrl = await world.addModel({ bytes: makeGlb(4000, 'raced') });
    const io = world.io(async (bytes) => {
      // The seller's own upload lands first.
      for (const table of Object.values(world.rows)) for (const row of table) { row.model_mid_url = '/uploads/models/' + 'f'.repeat(64) + '.glb'; }
      return halve(bytes);
    });
    const summary = await runBackfill({ candidates: groupCandidates(world.candidateRows()).candidates, io });
    expect(summary.rowsRecorded).toBe(0);
    expect(world.rows.catalog_templates.find((row) => row.model_url === modelUrl).model_mid_url).toBe('/uploads/models/' + 'f'.repeat(64) + '.glb');
    expect(world.rows.catalog_templates[0].model_far_url).toBeNull();
  });

  it('refuses to store past the byte limit for the run, and reports the model as failed', async () => {
    const world = makeWorld();
    await world.addModel({ bytes: makeGlb(4000, 'big') });
    const summary = await runBackfill({
      candidates: groupCandidates(world.candidateRows()).candidates,
      io: world.io(async (bytes) => halve(bytes)),
      maxTotalBytes: 10,
    });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].reason).toMatch(/byte limit/);
    expect(summary.modelsWithTiers).toBe(0);
  });

  it('a dry run reads nothing and writes nothing, and says how many it would do', async () => {
    const world = makeWorld();
    await world.addModel({ bytes: makeGlb(4000, 'a') });
    await world.addModel({ bytes: makeGlb(3000, 'b'), category: 'avatar' });
    const io = {
      readModel() { throw new Error('dry run must not read'); },
      generateTiers() { throw new Error('dry run must not generate'); },
      storeTier() { throw new Error('dry run must not store'); },
      recordTiers() { throw new Error('dry run must not record'); },
    };
    const summary = await runBackfill({ candidates: groupCandidates(world.candidateRows()).candidates, io, dryRun: true });
    expect(summary).toMatchObject({ dryRun: true, candidates: 2, skippedAvatar: 1, wouldProcess: 1, modelsWithTiers: 0, failed: [] });
    expect(formatSummary(summary)).toMatch(/Dry run: nothing was downloaded, stored or recorded/);
    expect(world.objects.size).toBe(2);
  });
});

describe('command line arguments (#3415)', () => {
  it('requires an explicit choice of database, so a run never defaults to production', () => {
    expect(() => parseArgs([])).toThrow(/--local .* or --remote/);
    expect(parseArgs(['--local']).mode).toBe('local');
    expect(parseArgs(['--remote', '--dry-run']).dryRun).toBe(true);
    expect(() => parseArgs(['--local', '--remote'])).toThrow(/not both/);
  });

  it('reads the limits and rejects anything unknown or malformed', () => {
    expect(parseArgs(['--local', '--limit', '5', '--max-total-bytes', '1000']).limit).toBe(5);
    expect(parseArgs(['--local', '--database', 'x', '--bucket', 'y'])).toMatchObject({ database: 'x', bucket: 'y' });
    expect(() => parseArgs(['--local', '--limit', '0'])).toThrow(/at least 1/);
    expect(() => parseArgs(['--local', '--limit'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--local', '--yolo'])).toThrow(/Unknown argument/);
  });
});

// ---- Redoing tiers that were made with cracks (#3527) ----

// The "hole edges" of a fake .glb are written into its extras as `holes:<n>`,
// so a test can say which stored tiers are cracked without any geometry.
const holesIn = (bytes) => {
  const match = /holes:(\d+)/.exec(new TextDecoder().decode(bytes));
  return match ? Number(match[1]) : 0;
};

async function makeTierWorld(specs) {
  const objects = new Map();
  const rows = [];
  const put = async (bytes) => {
    const url = await urlFor(bytes);
    objects.set(url.slice('/uploads/'.length), bytes);
    return url;
  };
  const models = {};
  for (const spec of specs) {
    const full = await put(makeGlb(6000, `full-${spec.name} holes:${spec.fullHoles ?? 0}`));
    const mid = spec.midHoles === undefined ? null : await put(makeGlb(3000, `mid-${spec.name} holes:${spec.midHoles}`));
    const far = spec.farHoles === undefined ? null : await put(makeGlb(1000, `far-${spec.name} holes:${spec.farHoles}`));
    models[spec.name] = { full, mid, far };
    for (const table of ['catalog_templates', 'products']) rows.push({ table, model_url: full, category: spec.category ?? 'furniture', model_mid_url: mid, model_far_url: far });
  }
  return {
    objects,
    rows,
    models,
    candidateRows: () => rows.filter((row) => row.model_mid_url || row.model_far_url).map(({ model_url, model_mid_url, model_far_url, category }) => ({ model_url, model_mid_url, model_far_url, category })),
    io(generate) {
      const reads = [];
      return {
        reads,
        async readModel(key) { reads.push(key); return objects.get(key); },
        generateTiers: generate,
        async holeEdges(bytes) { return holesIn(bytes); },
        async storeTier(key, bytes) { objects.set(key, bytes); },
        async replaceTiers(modelUrl, old, { midUrl, farUrl }) {
          let changed = 0;
          for (const row of rows) {
            if (row.model_url === modelUrl && row.model_mid_url === old.midUrl && row.model_far_url === old.farUrl) {
              row.model_mid_url = midUrl;
              row.model_far_url = farUrl;
              changed += 1;
            }
          }
          return changed;
        },
      };
    },
  };
}

const cleanTiers = async () => ({ skinned: false, mid: makeGlb(2500, 'mid-new holes:0'), far: makeGlb(800, 'far-new holes:0') });

describe('selecting products whose tiers may be cracked (#3527)', () => {
  it('selects products that carry a stored tier, from both tables', () => {
    expect(CRACKED_CANDIDATES_SQL).toMatch(/FROM catalog_templates[\s\S]*UNION ALL[\s\S]*FROM products/);
    expect(CRACKED_CANDIDATES_SQL).toContain('model_mid_url IS NOT NULL OR model_far_url IS NOT NULL');
  });

  it('groups by model with every distinct pair of tiers, and ignores a pair that is not made of stored tier URLs', () => {
    const a = `/uploads/models/${'a'.repeat(64)}.glb`;
    const b = `/uploads/models/${'b'.repeat(64)}.glb`;
    const c = `/uploads/models/${'c'.repeat(64)}.glb`;
    const { candidates } = groupCrackCandidates([
      { model_url: a, model_mid_url: b, model_far_url: c, category: 'furniture' },
      { model_url: a, model_mid_url: b, model_far_url: c, category: 'furniture' },
      { model_url: a, model_mid_url: b, model_far_url: null, category: 'furniture' },
      { model_url: a, model_mid_url: "x'; DROP TABLE products; --", model_far_url: null, category: 'furniture' },
      { model_url: c, model_mid_url: null, model_far_url: null, category: 'furniture' },
      { model_url: b, model_mid_url: a, model_far_url: null, category: 'avatar' },
    ]);
    expect(candidates.map((entry) => entry.modelUrl)).toEqual([a, b]);
    expect(candidates[0].tiers).toEqual([{ midUrl: b, farUrl: c }, { midUrl: b, farUrl: null }]);
    expect(candidates[1]).toMatchObject({ avatarOnly: true, tiers: [{ midUrl: a, farUrl: null }] });
  });

  it('builds a swap that only touches rows still carrying the old pair, NULL-safely, and refuses anything unsafe', () => {
    const a = `/uploads/models/${'a'.repeat(64)}.glb`;
    const b = `/uploads/models/${'b'.repeat(64)}.glb`;
    const c = `/uploads/models/${'c'.repeat(64)}.glb`;
    const statements = buildReplaceStatements(a, { midUrl: b, farUrl: null }, { midUrl: c, farUrl: null });
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(`UPDATE catalog_templates SET model_mid_url = '${c}', model_far_url = NULL WHERE model_url = '${a}' AND model_mid_url IS '${b}' AND model_far_url IS NULL`);
    expect(statements[1]).toContain('UPDATE products');
    expect(() => buildReplaceStatements(a, { midUrl: "b'; --", farUrl: null }, { midUrl: c, farUrl: null })).toThrow(/Refusing/);
    expect(() => buildReplaceStatements(a, { midUrl: b, farUrl: null }, { midUrl: "c'; --", farUrl: null })).toThrow(/Refusing/);
  });
});

describe('redoing cracked tiers (#3527)', () => {
  it('regenerates a model whose stored tier has more hole edges than the model, and swaps both tables', async () => {
    const world = await makeTierWorld([{ name: 'toilet', midHoles: 1255, farHoles: 0 }]);
    const { candidates } = groupCrackCandidates(world.candidateRows());
    const summary = await runRedoCracked({ candidates, io: world.io(cleanTiers) });
    expect(summary).toMatchObject({ candidates: 1, sound: 0, redone: 1, rowsRecorded: 2, failed: [], tiersStored: 2 });
    for (const row of world.rows) {
      expect(row.model_mid_url).not.toBe(world.models.toilet.mid);
      expect(row.model_mid_url).toMatch(MODEL_URL_PATTERN);
      expect(row.model_far_url).toMatch(MODEL_URL_PATTERN);
      expect(row.model_mid_url).toBe(await urlFor(world.objects.get(modelUrlToKey(row.model_mid_url))));
    }
    // Nothing is deleted: the old tiers stay in the bucket.
    expect(world.objects.has(modelUrlToKey(world.models.toilet.mid))).toBe(true);
  });

  it('leaves a model alone whose tiers are no more cracked than the model itself, even if the model has holes of its own', async () => {
    const world = await makeTierWorld([
      { name: 'closed', fullHoles: 0, midHoles: 0, farHoles: 0 },
      { name: 'open', fullHoles: 84, midHoles: 84 + CRACK_TOLERANCE_EDGES, farHoles: 10 },
    ]);
    const before = JSON.stringify(world.rows);
    const { candidates } = groupCrackCandidates(world.candidateRows());
    const io = world.io(cleanTiers);
    const summary = await runRedoCracked({ candidates, io });
    expect(summary).toMatchObject({ sound: 2, redone: 0, tiersStored: 0, rowsRecorded: 0 });
    expect(JSON.stringify(world.rows)).toBe(before);
  });

  it('checks the far version too, and drops a regenerated tier that is still cracked rather than swap one crack for another', async () => {
    const world = await makeTierWorld([{ name: 'dirty', fullHoles: 84, midHoles: 85, farHoles: 129 }]);
    const { candidates } = groupCrackCandidates(world.candidateRows());
    const logs = [];
    const summary = await runRedoCracked({
      candidates,
      log: (line) => logs.push(line),
      io: world.io(async () => ({ skinned: false, mid: makeGlb(2500, 'mid-new holes:400'), far: makeGlb(800, 'far-new holes:0') })),
    });
    expect(summary).toMatchObject({ redone: 1, tiersStored: 1, failed: [] });
    expect(logs.some((line) => /drop .* mid still has 400 hole edges/.test(line))).toBe(true);
    for (const row of world.rows) {
      expect(row.model_mid_url).toBeNull();
      expect(row.model_far_url).toMatch(MODEL_URL_PATTERN);
    }
  });

  it('redoes a tier that has no holes but no longer reads as the model (#4062), and leaves it alone when it does', async () => {
    const world = await makeTierWorld([{ name: 'net', fullHoles: 0, midHoles: 0, farHoles: 0 }]);
    const { candidates } = groupCrackCandidates(world.candidateRows());
    const base = world.io(cleanTiers);
    const calls = [];
    const faithful = await runRedoCracked({ candidates, io: { ...base, fidelity: async (full, tier, name) => { calls.push(name); return true; } } });
    expect(faithful).toMatchObject({ sound: 1, redone: 0 });
    expect(calls.sort()).toEqual(['far', 'mid']);
    const unfaithful = await runRedoCracked({ candidates, io: { ...base, fidelity: async (full, tier, name) => name !== 'far' } });
    expect(unfaithful).toMatchObject({ sound: 0, redone: 1, failed: [] });
    expect(world.rows[0].model_far_url).not.toBe(world.models.net.far);
  });

  it('only swaps rows that still point at the old tiers, so a model replaced meanwhile is never overwritten', async () => {
    const world = await makeTierWorld([{ name: 'toilet', midHoles: 500 }]);
    const { candidates } = groupCrackCandidates(world.candidateRows());
    const io = world.io(async (bytes) => {
      // The seller replaces the model while the script is working.
      for (const row of world.rows) row.model_mid_url = `/uploads/models/${'f'.repeat(64)}.glb`;
      return cleanTiers(bytes);
    });
    const summary = await runRedoCracked({ candidates, io });
    expect(summary.rowsRecorded).toBe(0);
    for (const row of world.rows) expect(row.model_mid_url).toBe(`/uploads/models/${'f'.repeat(64)}.glb`);
  });

  it('skips avatars, reports a failing model and carries on, and counts a dry run without reading anything', async () => {
    const world = await makeTierWorld([
      { name: 'avatar', category: 'avatar', midHoles: 900 },
      { name: 'broken', midHoles: 900 },
      { name: 'toilet', midHoles: 900 },
    ]);
    const { candidates } = groupCrackCandidates(world.candidateRows());
    let calls = 0;
    const summary = await runRedoCracked({
      candidates,
      io: world.io(async (bytes) => {
        calls += 1;
        if (calls === 1) throw new Error('browser crashed');
        return cleanTiers(bytes);
      }),
    });
    expect(summary).toMatchObject({ skippedAvatar: 1, redone: 1 });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].reason).toBe('browser crashed');

    const fresh = await makeTierWorld([{ name: 'toilet', midHoles: 900 }]);
    const io = fresh.io(cleanTiers);
    const dry = await runRedoCracked({ candidates: groupCrackCandidates(fresh.candidateRows()).candidates, io, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, wouldProcess: 1, redone: 0 });
    expect(io.reads).toEqual([]);
    expect(formatRedoSummary(dry)).toMatch(/would check: 1/);
  });

  it('reports what it did in plain words', async () => {
    const world = await makeTierWorld([{ name: 'toilet', midHoles: 900 }, { name: 'fine', midHoles: 0 }]);
    const summary = await runRedoCracked({ candidates: groupCrackCandidates(world.candidateRows()).candidates, io: world.io(cleanTiers) });
    const text = formatRedoSummary(summary);
    expect(text).toMatch(/sound, left alone: 1/);
    expect(text).toMatch(/redone: 1 \(2 tier files/);
    expect(text).toMatch(/failed: 0/);
  });
});

describe('--redo-cracked (#3527)', () => {
  it('is an opt-in flag that still needs an explicit database', () => {
    expect(parseArgs(['--local']).redoCracked).toBe(false);
    expect(parseArgs(['--remote', '--redo-cracked', '--dry-run'])).toMatchObject({ redoCracked: true, dryRun: true, mode: 'remote' });
    expect(() => parseArgs(['--redo-cracked'])).toThrow(/--local .* or --remote/);
  });
});
