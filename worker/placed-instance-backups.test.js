// #2050 (sub-issue of #1952, following up on #1948): a placed instance's
// own configured backup/replacement chain, consulted by
// sweepSoldOutTemplateInstances when its active product sells out. Split
// into its own file rather than folded into catalog-content-features.test.js's
// existing "Finite stock tracking (#1948)" describe block -- CRUD plus the
// sweep rework is substantial enough to warrant it, same reasoning
// geo-water-cells.test.js's own split gave for #2013/#2014.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupBuilder, signupAdmin,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('backups-admin');
  adminSession = admin.session;
});

async function createTemplate(templateId, overrides = {}) {
  return api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: `Backup-chain fixture ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
      ...overrides,
    }),
  });
}

async function createLandletAndClaim(landletId, builder) {
  await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
  }));
  await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
}

async function placeInstance(instanceId, landletId, templateId, builder) {
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
  }));
  expect(placed.response.status).toBe(201);
  return instanceId;
}

describe('Placed instance backup-chain CRUD (#2050)', () => {
  it('lists empty, then appends in order via POST, each at the next position', async () => {
    const builder = await signupBuilder('backups-crud-builder');
    await createLandletAndClaim('backups-crud-landlet', builder);
    await createTemplate('backups-crud-template');
    await createTemplate('backups-crud-backup-1');
    await createTemplate('backups-crud-backup-2');
    await placeInstance('backups-crud-instance', 'backups-crud-landlet', 'backups-crud-template', builder);

    const empty = await api('/instances/backups-crud-instance/backups', builder.session());
    expect(empty.response.status).toBe(200);
    expect(empty.body.backups).toEqual([]);

    const first = await api('/instances/backups-crud-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-crud-backup-1' }),
    }));
    expect(first.response.status).toBe(201);
    expect(first.body.backup).toMatchObject({ templateId: 'backups-crud-backup-1', position: 0 });

    const second = await api('/instances/backups-crud-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-crud-backup-2' }),
    }));
    expect(second.response.status).toBe(201);
    expect(second.body.backup).toMatchObject({ templateId: 'backups-crud-backup-2', position: 1 });

    const listed = await api('/instances/backups-crud-instance/backups', builder.session());
    expect(listed.body.backups.map((b) => b.templateId)).toEqual(['backups-crud-backup-1', 'backups-crud-backup-2']);
  });

  it('rejects a POST with a templateId that does not exist', async () => {
    const builder = await signupBuilder('backups-missing-template-builder');
    await createLandletAndClaim('backups-missing-template-landlet', builder);
    await createTemplate('backups-missing-template-template');
    await placeInstance('backups-missing-template-instance', 'backups-missing-template-landlet', 'backups-missing-template-template', builder);

    const added = await api('/instances/backups-missing-template-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'does-not-exist' }),
    }));
    expect(added.response.status).toBe(400);
  });

  it('rejects every op from a builder who does not own the instance\'s landlet', async () => {
    const owner = await signupBuilder('backups-owner-builder');
    const stranger = await signupBuilder('backups-stranger-builder');
    await createLandletAndClaim('backups-owner-landlet', owner);
    await createTemplate('backups-owner-template');
    await createTemplate('backups-owner-backup');
    await placeInstance('backups-owner-instance', 'backups-owner-landlet', 'backups-owner-template', owner);
    const added = await api('/instances/backups-owner-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-owner-backup' }),
    }));
    expect(added.response.status).toBe(201);
    const backupId = added.body.backup.backupId;

    const listStranger = await api('/instances/backups-owner-instance/backups', stranger.session());
    expect(listStranger.response.status).toBe(403);
    const addStranger = await api('/instances/backups-owner-instance/backups', stranger.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-owner-backup' }),
    }));
    expect(addStranger.response.status).toBe(403);
    const reorderStranger = await api('/instances/backups-owner-instance/backups', stranger.session({
      method: 'PUT', body: JSON.stringify({ order: [backupId] }),
    }));
    expect(reorderStranger.response.status).toBe(403);
    const deleteStranger = await api(`/instances/backups-owner-instance/backups/${backupId}`, stranger.session({ method: 'DELETE' }));
    expect(deleteStranger.response.status).toBe(403);
  });

  it('reorders via PUT, and rejects a PUT that omits or duplicates an existing id', async () => {
    const builder = await signupBuilder('backups-reorder-builder');
    await createLandletAndClaim('backups-reorder-landlet', builder);
    await createTemplate('backups-reorder-template');
    await createTemplate('backups-reorder-backup-1');
    await createTemplate('backups-reorder-backup-2');
    await placeInstance('backups-reorder-instance', 'backups-reorder-landlet', 'backups-reorder-template', builder);
    const first = await api('/instances/backups-reorder-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-reorder-backup-1' }),
    }));
    const second = await api('/instances/backups-reorder-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-reorder-backup-2' }),
    }));
    const id1 = first.body.backup.backupId;
    const id2 = second.body.backup.backupId;

    const badOrder = await api('/instances/backups-reorder-instance/backups', builder.session({
      method: 'PUT', body: JSON.stringify({ order: [id1, id1] }),
    }));
    expect(badOrder.response.status).toBe(400);
    const partialOrder = await api('/instances/backups-reorder-instance/backups', builder.session({
      method: 'PUT', body: JSON.stringify({ order: [id1] }),
    }));
    expect(partialOrder.response.status).toBe(400);

    const reordered = await api('/instances/backups-reorder-instance/backups', builder.session({
      method: 'PUT', body: JSON.stringify({ order: [id2, id1] }),
    }));
    expect(reordered.response.status).toBe(200);
    expect(reordered.body.backups.map((b) => b.backupId)).toEqual([id2, id1]);
    expect(reordered.body.backups.map((b) => b.position)).toEqual([0, 1]);
  });

  it('on DELETE, compacts positions so the chain stays contiguous for the next append', async () => {
    const builder = await signupBuilder('backups-delete-builder');
    await createLandletAndClaim('backups-delete-landlet', builder);
    await createTemplate('backups-delete-template');
    await createTemplate('backups-delete-backup-1');
    await createTemplate('backups-delete-backup-2');
    await createTemplate('backups-delete-backup-3');
    await placeInstance('backups-delete-instance', 'backups-delete-landlet', 'backups-delete-template', builder);
    const first = await api('/instances/backups-delete-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-backup-1' }),
    }));
    await api('/instances/backups-delete-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-backup-2' }),
    }));
    await api('/instances/backups-delete-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-backup-3' }),
    }));

    const deleted = await api(`/instances/backups-delete-instance/backups/${first.body.backup.backupId}`, builder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const listed = await api('/instances/backups-delete-instance/backups', builder.session());
    expect(listed.body.backups.map((b) => b.templateId)).toEqual(['backups-delete-backup-2', 'backups-delete-backup-3']);
    expect(listed.body.backups.map((b) => b.position)).toEqual([0, 1]);

    const appended = await api('/instances/backups-delete-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-backup-1' }),
    }));
    expect(appended.body.backup.position).toBe(2);
  });

  // #2171: unlike every other ordered/bulk-array endpoint in worker/index.js
  // (e.g. PUT /landlets/:id/instances at 250, POST /land-candidates/batch at
  // 100), this chain had no cap at all. Pre-seeds the chain directly via DB
  // insert rather than firing 20 real POSTs, same cheap-test idiom
  // tax-1099-filing-race.test.js's own rate-limit test uses.
  it('rejects a POST once the chain already holds the maximum of 20 entries', async () => {
    const builder = await signupBuilder('backups-cap-builder');
    await createLandletAndClaim('backups-cap-landlet', builder);
    await createTemplate('backups-cap-template');
    await createTemplate('backups-cap-backup');
    await placeInstance('backups-cap-instance', 'backups-cap-landlet', 'backups-cap-template', builder);

    await env.DB.batch(Array.from({ length: 20 }, (_, position) => env.DB.prepare(
      'INSERT INTO placed_instance_backups (backup_id, instance_id, position, template_id) VALUES (?, ?, ?, ?)',
    ).bind(`backups-cap-seed-${position}`, 'backups-cap-instance', position, 'backups-cap-backup')));

    const rejected = await api('/instances/backups-cap-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-cap-backup' }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/at most 20/);

    const stillTwenty = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM placed_instance_backups WHERE instance_id = ?',
    ).bind('backups-cap-instance').first();
    expect(stillTwenty.count).toBe(20);
  });

  // #2091: PUT (reorder) and DELETE each only checked requireOwnedLandlet
  // once at the top of the handler, then did further awaited work
  // (readJson/a SELECT/checkRateLimit) before their actual write, unlike
  // this handler's own POST above (and handleSignPosts' DELETE), which
  // already fold an ownership re-check into the write itself for exactly
  // this reason. Same test idiom as land.test.js's own
  // "rejects an event on a landlet that was transferred to a new owner
  // mid-request" -- hijack env.DB.prepare to transfer ownership away right
  // as checkRateLimit's own INSERT INTO rate_limit_events runs, simulating
  // an auction resolving in the exact awaited gap this guards.
  it('rejects a PUT reorder on a landlet that was transferred to a new owner mid-request', async () => {
    const owner = await signupBuilder('backups-put-race-owner');
    const newOwner = await signupBuilder('backups-put-race-new-owner');
    await createLandletAndClaim('backups-put-race-landlet', owner);
    await createTemplate('backups-put-race-template');
    await createTemplate('backups-put-race-backup-1');
    await createTemplate('backups-put-race-backup-2');
    await placeInstance('backups-put-race-instance', 'backups-put-race-landlet', 'backups-put-race-template', owner);
    const first = await api('/instances/backups-put-race-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-put-race-backup-1' }),
    }));
    const second = await api('/instances/backups-put-race-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-put-race-backup-2' }),
    }));
    const id1 = first.body.backup.backupId;
    const id2 = second.body.backup.backupId;

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(newOwner.builderId, 'backups-put-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api('/instances/backups-put-race-instance/backups', owner.session({
        method: 'PUT', body: JSON.stringify({ order: [id2, id1] }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/Landlet changed concurrently/);

    const stillOriginalOrder = await env.DB.prepare(
      'SELECT backup_id, position FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind('backups-put-race-instance').all();
    expect(stillOriginalOrder.results.map((r) => r.backup_id)).toEqual([id1, id2]);
  });

  it('rejects a DELETE on a landlet that was transferred to a new owner mid-request', async () => {
    const owner = await signupBuilder('backups-delete-race-owner');
    const newOwner = await signupBuilder('backups-delete-race-new-owner');
    await createLandletAndClaim('backups-delete-race-landlet', owner);
    await createTemplate('backups-delete-race-template');
    await createTemplate('backups-delete-race-backup');
    await placeInstance('backups-delete-race-instance', 'backups-delete-race-landlet', 'backups-delete-race-template', owner);
    const added = await api('/instances/backups-delete-race-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-race-backup' }),
    }));
    const backupId = added.body.backup.backupId;

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(newOwner.builderId, 'backups-delete-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api(`/instances/backups-delete-race-instance/backups/${backupId}`, owner.session({ method: 'DELETE' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/Landlet changed concurrently/);

    const stillThere = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM placed_instance_backups WHERE backup_id = ?',
    ).bind(backupId).first();
    expect(stillThere.count).toBe(1);
  });

  // #2183: position used to come from a COUNT(*) read in a statement
  // separate from the INSERT -- two concurrent appends could both read the
  // same count and both land on the same position. A plain Promise.all of
  // two real requests doesn't reliably force this interleaving in this
  // single-worker test harness (confirmed empirically: it still passed
  // against the un-fixed code), so this uses the same env.DB.prepare
  // hijack idiom as the ownership-transfer-mid-request races above --
  // intercepting the INSERT itself and, right before it runs, fires a full
  // competing append (its own fresh COUNT read + INSERT) via the
  // unhijacked originalPrepare. Against the old code, the real request's
  // own position was already bound from an earlier, now-stale COUNT read,
  // so it collides with the injected competitor's row. Against the fix,
  // the real INSERT's own COUNT lives in a subquery evaluated at this
  // exact execution -- after the injected competitor has already
  // committed -- so it correctly sees the incremented count instead.
  it('never lands two concurrent appends on the same position', async () => {
    const builder = await signupBuilder('backups-append-race-builder');
    await createLandletAndClaim('backups-append-race-landlet', builder);
    await createTemplate('backups-append-race-template');
    await createTemplate('backups-append-race-backup-1');
    await createTemplate('backups-append-race-backup-2');
    await placeInstance('backups-append-race-instance', 'backups-append-race-landlet', 'backups-append-race-template', builder);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO placed_instance_backups')) {
        armed = false;
        // A single direct write (no preceding read), issued to D1 before
        // the real statement this hijack intercepted is even dispatched by
        // its own caller -- a competitor needing a read-then-write round
        // trip here would lose the race to the real statement's own
        // single-statement INSERT and never actually land first (confirmed
        // empirically: an earlier read-then-write version of this
        // competitor passed even against the un-fixed code, for exactly
        // that reason). The chain is known-empty at this point in the
        // test, so position 0 is the correct literal to plant.
        originalPrepare(
          'INSERT INTO placed_instance_backups (backup_id, instance_id, position, template_id) VALUES (?, ?, ?, ?)',
        ).bind('backups-append-race-competitor', 'backups-append-race-instance', 0, 'backups-append-race-backup-2').run();
      }
      return originalPrepare(sql);
    };
    let added;
    try {
      added = await api('/instances/backups-append-race-instance/backups', builder.session({
        method: 'POST', body: JSON.stringify({ templateId: 'backups-append-race-backup-1' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(added.response.status).toBe(201);

    const { results } = await env.DB.prepare(
      'SELECT backup_id, position FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind('backups-append-race-instance').all();
    expect(results.map((r) => r.position)).toEqual([0, 1]);
  });

  // #2183: the gap-closing shift used to run as a statement separate from
  // both the DELETE it followed and the other deletion's own sequence,
  // keyed off a position read well before either write -- two concurrent
  // deletes of different backups on the same chain could each shift using
  // a stale idea of where the other one's removed row sat. #2174/PR #2179
  // (landed independently, mid-investigation of this issue) already wraps
  // the DELETE and its shift in one db.batch -- but still keys the shift's
  // threshold off that same early, separately-read `existing.position`,
  // just now atomically with the DELETE. That closes the single-request
  // crash-between-statements window #2174 was about, but not this still-
  // open cross-request race: two different concurrent deletes' *batches*
  // simply serialize as two separate transactions, each still trusting its
  // own now-possibly-stale threshold. Hand-tracing the bug shows the gap
  // appears under one specific ordering -- when the batch for the lower
  // position threshold commits before the batch for the higher one, the
  // second batch's stale threshold no longer matches rows the first batch
  // already pulled below it. (The reverse order is harmless: a higher-
  // threshold batch committing first doesn't touch what the lower-
  // threshold batch's own threshold next matches.) This fix instead folds
  // a live subquery (re-deriving the target row's current position by
  // backup_id, inside the same transaction) into the shift itself, so it's
  // correct regardless of ordering.
  //
  // Proving this needs two gates, since the straightforward one (a plain
  // Promise.all of two real requests) doesn't reliably force either
  // interleaving in this single-worker test harness: one synchronizes both
  // requests' leading `SELECT position ... WHERE backup_id` reads (so both
  // capture the pre-delete snapshot -- a read that happens after the other
  // side's write is simply accurate, not stale, and can never expose
  // this), and a second forces the specific batch-commit ordering (lower
  // threshold's batch resolves before the higher one's is even allowed to
  // start) that the trace above requires. The second gate hijacks
  // `env.DB.batch` itself, not an individual statement's `.run()` -- db.batch
  // takes an array of already-bound statements and dispatches them as one
  // transaction without calling `.run()` on any of them individually, so a
  // statement-level hijack (an earlier version of this test) silently never
  // engages for *any* batched implementation, #2179's included, and ends up
  // proving nothing either way. Tagging each DELETE statement with its own
  // bound backupId at `.bind()` time (via a WeakMap, since D1PreparedStatement
  // doesn't expose its bound params for inspection) lets the `env.DB.batch`
  // hijack tell the two requests' batches apart and order them deliberately.
  //
  // Confirmed empirically against both other candidate fixes: this test
  // passes against this file's own fix (the live subquery), and fails --
  // with the exact gap the hand-trace predicts -- against a version with
  // #2179's batching but still a stale literal threshold, proving the live
  // subquery closes a real gap #2179 alone leaves open rather than
  // duplicating it.
  it('keeps positions contiguous when two different backups on the same chain are deleted concurrently', async () => {
    const builder = await signupBuilder('backups-delete-race2-builder');
    await createLandletAndClaim('backups-delete-race2-landlet', builder);
    await createTemplate('backups-delete-race2-template');
    await createTemplate('backups-delete-race2-backup-1');
    await createTemplate('backups-delete-race2-backup-2');
    await createTemplate('backups-delete-race2-backup-3');
    await createTemplate('backups-delete-race2-backup-4');
    await placeInstance('backups-delete-race2-instance', 'backups-delete-race2-landlet', 'backups-delete-race2-template', builder);
    const ids = [];
    for (const templateId of ['backups-delete-race2-backup-1', 'backups-delete-race2-backup-2', 'backups-delete-race2-backup-3', 'backups-delete-race2-backup-4']) {
      const added = await api('/instances/backups-delete-race2-instance/backups', builder.session({
        method: 'POST', body: JSON.stringify({ templateId }),
      }));
      ids.push(added.body.backup.backupId);
    }

    const originalPrepare = env.DB.prepare.bind(env.DB);
    const originalBatch = env.DB.batch.bind(env.DB);
    let readArrivals = 0;
    let releaseReadGate;
    const readGate = new Promise((resolve) => { releaseReadGate = resolve; });
    const backupIdByStatement = new WeakMap();
    let lowerBatchDone;
    const lowerBatchDonePromise = new Promise((resolve) => { lowerBatchDone = resolve; });
    env.DB.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('SELECT position FROM placed_instance_backups WHERE backup_id')) {
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop !== 'bind') return Reflect.get(target, prop, receiver);
            return (...bindArgs) => {
              const bound = target.bind(...bindArgs);
              return new Proxy(bound, {
                get(boundTarget, boundProp, boundReceiver) {
                  if (boundProp !== 'first') return Reflect.get(boundTarget, boundProp, boundReceiver);
                  return async (...firstArgs) => {
                    readArrivals += 1;
                    if (readArrivals >= 2) releaseReadGate();
                    await readGate;
                    return boundTarget.first(...firstArgs);
                  };
                },
              });
            };
          },
        });
      }
      // Tags the DELETE half of the batch with its own bound backupId so
      // the env.DB.batch hijack below can tell the two requests' batches
      // apart -- D1PreparedStatement has no public way to read back bound
      // params, so this captures it at the one point it's available.
      if (sql.includes('DELETE FROM placed_instance_backups WHERE backup_id = ? AND instance_id = ? AND EXISTS')) {
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop !== 'bind') return Reflect.get(target, prop, receiver);
            return (...bindArgs) => {
              const bound = target.bind(...bindArgs);
              backupIdByStatement.set(bound, bindArgs[0]);
              return bound;
            };
          },
        });
      }
      return stmt;
    };
    env.DB.batch = (stmts) => {
      const taggedId = stmts.map((s) => backupIdByStatement.get(s)).find(Boolean);
      if (taggedId === ids[1]) {
        return originalBatch(stmts).then((result) => { lowerBatchDone(); return result; });
      }
      if (taggedId === ids[2]) {
        return lowerBatchDonePromise.then(() => originalBatch(stmts));
      }
      return originalBatch(stmts);
    };
    let results1;
    let results2;
    try {
      [results1, results2] = await Promise.all([
        api(`/instances/backups-delete-race2-instance/backups/${ids[1]}`, builder.session({ method: 'DELETE' })),
        api(`/instances/backups-delete-race2-instance/backups/${ids[2]}`, builder.session({ method: 'DELETE' })),
      ]);
    } finally {
      env.DB.prepare = originalPrepare;
      env.DB.batch = originalBatch;
    }
    expect(results1.response.status).toBe(200);
    expect(results2.response.status).toBe(200);

    const { results } = await env.DB.prepare(
      'SELECT backup_id, position FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind('backups-delete-race2-instance').all();
    expect(results.map((r) => r.backup_id)).toEqual([ids[0], ids[3]]);
    expect(results.map((r) => r.position)).toEqual([0, 1]);

    // The chain should still be usable for the next append, same
    // "stays contiguous for the next append" contract the sequential
    // delete test above already covers.
    const appended = await api('/instances/backups-delete-race2-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-race2-backup-1' }),
    }));
    expect(appended.body.backup.position).toBe(2);
  });

  // #2174: DELETE's position-compaction UPDATE used to be a second,
  // separate .run() after the DELETE -- an interruption between the two
  // awaits could leave the chain with a position gap forever (nothing ever
  // revisits it, and the next append picks its slot via COUNT(*), not
  // MAX(position), so it would then collide into the gap). Fixed by
  // batching both writes into one db.batch call, same shape as the PUT
  // (reorder) branch just above it. Confirms (a) the DELETE now goes out as
  // one db.batch call carrying both statements, not two sequential writes,
  // and (b) a lost ownership race still leaves every other position
  // untouched -- the position-shift UPDATE's own NOT EXISTS guard ties its
  // effect to the DELETE having actually landed earlier in the same batch.
  it('issues the DELETE and its position-shift as a single batched write, and leaves positions untouched on a lost ownership race', async () => {
    const owner = await signupBuilder('backups-delete-batch-owner');
    const newOwner = await signupBuilder('backups-delete-batch-new-owner');
    await createLandletAndClaim('backups-delete-batch-landlet', owner);
    await createTemplate('backups-delete-batch-template');
    await createTemplate('backups-delete-batch-backup-1');
    await createTemplate('backups-delete-batch-backup-2');
    await createTemplate('backups-delete-batch-backup-3');
    await placeInstance('backups-delete-batch-instance', 'backups-delete-batch-landlet', 'backups-delete-batch-template', owner);
    const first = await api('/instances/backups-delete-batch-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-batch-backup-1' }),
    }));
    const second = await api('/instances/backups-delete-batch-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-batch-backup-2' }),
    }));
    const third = await api('/instances/backups-delete-batch-instance/backups', owner.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-batch-backup-3' }),
    }));
    const id1 = first.body.backup.backupId;
    const id2 = second.body.backup.backupId;
    const id3 = third.body.backup.backupId;

    const originalBatch = env.DB.batch.bind(env.DB);
    let batchCallCount = 0;
    let lastBatchSize = 0;
    env.DB.batch = async (statements) => {
      batchCallCount += 1;
      lastBatchSize = statements.length;
      // Simulates the landlet's ownership changing in the exact window
      // between requireOwnedLandlet's top-of-handler check (already
      // passed, above) and this db.batch() write -- same idiom as the
      // "rejects a DELETE..." test above, but on env.DB.batch directly
      // rather than env.DB.prepare, since the write is now batched.
      await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
        .bind(newOwner.builderId, 'backups-delete-batch-landlet').run();
      return originalBatch(statements);
    };
    let rejected;
    try {
      rejected = await api(`/instances/backups-delete-batch-instance/backups/${id2}`, owner.session({ method: 'DELETE' }));
    } finally {
      env.DB.batch = originalBatch;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/Landlet changed concurrently/);
    // The DELETE went out as exactly one batched call carrying both
    // statements (the delete itself and the position-shift), not two
    // separate sequential writes.
    expect(batchCallCount).toBe(1);
    expect(lastBatchSize).toBe(2);

    // Restore ownership and confirm every backup -- not just the one that
    // was supposed to be deleted -- is still at its original position. The
    // position-shift UPDATE ran inside the same batch as the rejected
    // DELETE; without its NOT EXISTS guard it would have shifted backup-3
    // down to position 1 even though backup-2 was never actually removed.
    await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
      .bind(owner.builderId, 'backups-delete-batch-landlet').run();
    const stillOriginal = await env.DB.prepare(
      'SELECT backup_id, position FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind('backups-delete-batch-instance').all();
    expect(stillOriginal.results.map((r) => ({ id: r.backup_id, position: r.position }))).toEqual([
      { id: id1, position: 0 },
      { id: id2, position: 1 },
      { id: id3, position: 2 },
    ]);

    // A genuinely successful DELETE still compacts positions correctly,
    // same assertion as the "compacts positions" test above, just via the
    // now-batched path.
    const deleted = await api(`/instances/backups-delete-batch-instance/backups/${id2}`, owner.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    const afterDelete = await env.DB.prepare(
      'SELECT backup_id, position FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind('backups-delete-batch-instance').all();
    expect(afterDelete.results.map((r) => ({ id: r.backup_id, position: r.position }))).toEqual([
      { id: id1, position: 0 },
      { id: id3, position: 1 },
    ]);
  });

  it('blocks deleting a catalog template still configured as a backup', async () => {
    const builder = await signupBuilder('backups-delete-template-builder');
    await createLandletAndClaim('backups-delete-template-landlet', builder);
    await createTemplate('backups-delete-template-active');
    await createTemplate('backups-delete-template-backup');
    await placeInstance('backups-delete-template-instance', 'backups-delete-template-landlet', 'backups-delete-template-active', builder);
    await api('/instances/backups-delete-template-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-delete-template-backup' }),
    }));

    const deleted = await api('/catalog/backups-delete-template-backup', { method: 'DELETE' });
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toMatch(/backup/);
  });

  // #2111: assertCatalogTemplatesDeletable's blockedByBackup guard is shared
  // by both DELETE /catalog/:id (test above) and DELETE /catalog/batch --
  // this exercises the batch call site specifically, which had no coverage
  // of its own.
  it('blocks batch-deleting a catalog template still configured as a backup', async () => {
    const builder = await signupBuilder('backups-batch-delete-template-builder');
    await createLandletAndClaim('backups-batch-delete-template-landlet', builder);
    await createTemplate('backups-batch-delete-template-active');
    await createTemplate('backups-batch-delete-template-backup');
    await createTemplate('backups-batch-delete-template-unrelated');
    await placeInstance('backups-batch-delete-template-instance', 'backups-batch-delete-template-landlet', 'backups-batch-delete-template-active', builder);
    await api('/instances/backups-batch-delete-template-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'backups-batch-delete-template-backup' }),
    }));

    const deleted = await api('/catalog/batch', {
      method: 'DELETE',
      body: JSON.stringify({
        templateIds: ['backups-batch-delete-template-unrelated', 'backups-batch-delete-template-backup'],
      }),
    });
    expect(deleted.response.status).toBe(409);
    expect(deleted.body.error).toMatch(/backup/);
    expect((await api('/catalog/backups-batch-delete-template-unrelated')).response.status).toBe(200);
  });
});

describe('sweepSoldOutTemplateInstances consults the backup chain (#2050)', () => {
  it('activates backup #1 on sell-out, then backup #2 on a second sell-out, removing each consumed entry', async () => {
    const builder = await signupBuilder('sweep-chain-builder');
    await createLandletAndClaim('sweep-chain-landlet', builder);
    await createTemplate('sweep-chain-active', { stockQuantity: 1 });
    await createTemplate('sweep-chain-backup-1', { stockQuantity: 1 });
    await createTemplate('sweep-chain-backup-2');
    await placeInstance('sweep-chain-instance', 'sweep-chain-landlet', 'sweep-chain-active', builder);
    await api('/instances/sweep-chain-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-chain-backup-1' }),
    }));
    await api('/instances/sweep-chain-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-chain-backup-2' }),
    }));

    const firstSale = await api('/instances/sweep-chain-instance/purchase', builder.session({ method: 'POST' }));
    expect(firstSale.response.status).toBe(201);

    const afterFirst = await api('/instances/sweep-chain-instance');
    expect(afterFirst.response.status).toBe(200);
    expect(afterFirst.body.instance.templateId).toBe('sweep-chain-backup-1');
    const backupsAfterFirst = await api('/instances/sweep-chain-instance/backups', builder.session());
    expect(backupsAfterFirst.body.backups.map((b) => b.templateId)).toEqual(['sweep-chain-backup-2']);

    const secondSale = await api('/instances/sweep-chain-instance/purchase', builder.session({ method: 'POST' }));
    expect(secondSale.response.status).toBe(201);

    const afterSecond = await api('/instances/sweep-chain-instance');
    expect(afterSecond.body.instance.templateId).toBe('sweep-chain-backup-2');
    const backupsAfterSecond = await api('/instances/sweep-chain-instance/backups', builder.session());
    expect(backupsAfterSecond.body.backups).toEqual([]);

    const notices = await api('/notifications', builder.session());
    expect(notices.body.notifications.some((n) => n.message.includes('just sold out'))).toBe(false);

    // #2068: a successful backup-chain activation reuses the instance in
    // place -- nothing about it is "gone," so it must not also leave behind
    // a sold-out marker (that's reserved for the chain-exhausted path below).
    const markers = await api('/landlets/sweep-chain-landlet/sold-out-markers', builder.session());
    expect(markers.response.status).toBe(200);
    expect(markers.body.markers).toEqual([]);
  });

  it('skips past a chain entry whose own template is already out of stock, and compacts the surviving tail\'s positions', async () => {
    const builder = await signupBuilder('sweep-skip-builder');
    await createLandletAndClaim('sweep-skip-landlet', builder);
    await createTemplate('sweep-skip-active', { stockQuantity: 1 });
    await createTemplate('sweep-skip-backup-exhausted', { stockQuantity: 0 });
    await createTemplate('sweep-skip-backup-viable', { stockQuantity: 1 });
    // A third, untouched entry behind the viable one -- proves the sweep
    // doesn't just remove the consumed prefix, but also closes the gap it
    // leaves behind so this one's own position stays correct.
    await createTemplate('sweep-skip-backup-untouched');
    await placeInstance('sweep-skip-instance', 'sweep-skip-landlet', 'sweep-skip-active', builder);
    await api('/instances/sweep-skip-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-skip-backup-exhausted' }),
    }));
    await api('/instances/sweep-skip-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-skip-backup-viable' }),
    }));
    await api('/instances/sweep-skip-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-skip-backup-untouched' }),
    }));

    const sale = await api('/instances/sweep-skip-instance/purchase', builder.session({ method: 'POST' }));
    expect(sale.response.status).toBe(201);

    const afterSale = await api('/instances/sweep-skip-instance');
    expect(afterSale.body.instance.templateId).toBe('sweep-skip-backup-viable');
    const backupsAfterSale = await api('/instances/sweep-skip-instance/backups', builder.session());
    expect(backupsAfterSale.body.backups).toEqual([
      expect.objectContaining({ templateId: 'sweep-skip-backup-untouched', position: 0 }),
    ]);

    // If the sweep ever again leaves the surviving tail's positions
    // non-contiguous, this append (which picks its own position via a
    // plain COUNT(*) of the chain) would collide with the row above
    // instead of landing after it.
    await createTemplate('sweep-skip-backup-appended-after');
    const appended = await api('/instances/sweep-skip-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-skip-backup-appended-after' }),
    }));
    expect(appended.body.backup.position).toBe(1);
    const finalList = await api('/instances/sweep-skip-instance/backups', builder.session());
    expect(finalList.body.backups.map((b) => b.templateId)).toEqual([
      'sweep-skip-backup-untouched', 'sweep-skip-backup-appended-after',
    ]);
  });

  it('falls back to delete+notify exactly as before when the chain is empty', async () => {
    const builder = await signupBuilder('sweep-empty-chain-builder');
    await createLandletAndClaim('sweep-empty-chain-landlet', builder);
    await createTemplate('sweep-empty-chain-active', { stockQuantity: 1 });
    await placeInstance('sweep-empty-chain-instance', 'sweep-empty-chain-landlet', 'sweep-empty-chain-active', builder);

    const sale = await api('/instances/sweep-empty-chain-instance/purchase', builder.session({ method: 'POST' }));
    expect(sale.response.status).toBe(201);

    const afterSale = await api('/instances/sweep-empty-chain-instance');
    expect(afterSale.response.status).toBe(404);
    const notices = await api('/notifications', builder.session());
    expect(notices.body.notifications.some((n) => n.message.includes('just sold out'))).toBe(true);

    // #2068: an empty chain is the same as no chain at all -- the
    // chain-exhausted branch still runs and leaves a marker behind.
    const markers = await api('/landlets/sweep-empty-chain-landlet/sold-out-markers', builder.session());
    expect(markers.body.markers).toMatchObject([{ templateId: 'sweep-empty-chain-active' }]);
  });

  it('falls back to delete+notify when every chain entry is exhausted', async () => {
    const builder = await signupBuilder('sweep-all-exhausted-builder');
    await createLandletAndClaim('sweep-all-exhausted-landlet', builder);
    await createTemplate('sweep-all-exhausted-active', { stockQuantity: 1 });
    await createTemplate('sweep-all-exhausted-backup', { stockQuantity: 0 });
    await placeInstance('sweep-all-exhausted-instance', 'sweep-all-exhausted-landlet', 'sweep-all-exhausted-active', builder);
    await api('/instances/sweep-all-exhausted-instance/backups', builder.session({
      method: 'POST', body: JSON.stringify({ templateId: 'sweep-all-exhausted-backup' }),
    }));

    const sale = await api('/instances/sweep-all-exhausted-instance/purchase', builder.session({ method: 'POST' }));
    expect(sale.response.status).toBe(201);

    const afterSale = await api('/instances/sweep-all-exhausted-instance');
    expect(afterSale.response.status).toBe(404);
    const notices = await api('/notifications', builder.session());
    expect(notices.body.notifications.some((n) => n.message.includes('just sold out'))).toBe(true);
    // The exhausted backup entry is gone too, cascaded away with the
    // instance itself (migrations/0137's ON DELETE CASCADE) rather than
    // left dangling.
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM placed_instance_backups WHERE instance_id = ?')
      .bind('sweep-all-exhausted-instance').first();
    expect(row.count).toBe(0);

    // #2068: exhausted entries are skipped, not "viable" -- the chain still
    // counts as exhausted overall, so the chain-exhausted branch runs.
    const markers = await api('/landlets/sweep-all-exhausted-landlet/sold-out-markers', builder.session());
    expect(markers.body.markers).toMatchObject([{ templateId: 'sweep-all-exhausted-active' }]);
  });
});

// #2283: sweepSoldOutTemplateInstances binds every affected instance's own
// chain-lookup, and every affected builder's own notification-preference
// lookup, in a single unchunked IN (...) query -- D1 caps a single query at
// 100 bound parameters, so a template placed across more than 100 distinct
// instances/builders threw a raw D1 error from inside the purchase-finalize
// path instead of completing the sweep. Seeds the other 149 affected
// instances (each on its own landlet owned by its own builder, to also push
// the builderIds query past 100) directly via D1 -- same shape as #2233's
// own >100-id regression test -- rather than the real claim/place flows,
// since 149 real landlets would be far slower to create and the test only
// cares that the real purchase-triggered sweep completes cleanly either way.
describe('sweepSoldOutTemplateInstances chunks its IN(...) queries past 100 entries (#2283)', () => {
  it('sweeps 150 affected instances/builders without a raw D1 "too many SQL variables" error', async () => {
    await createTemplate('sweep-chunk-template', { stockQuantity: 1 });

    const seededBuilderIds = Array.from({ length: 149 }, (_, i) => `sweep-chunk-builder-${i}`);
    const seededLandletIds = Array.from({ length: 149 }, (_, i) => `sweep-chunk-landlet-${i}`);
    const seededInstanceIds = Array.from({ length: 149 }, (_, i) => `sweep-chunk-instance-${i}`);
    await env.DB.batch(seededBuilderIds.map((builderId) => env.DB.prepare(
      'INSERT INTO builders (builder_id, label) VALUES (?, ?)',
    ).bind(builderId, builderId)));
    await env.DB.batch(seededLandletIds.map((landletId, i) => env.DB.prepare(
      "INSERT INTO landlets (landlet_id, name, status, owner_builder_id) VALUES (?, ?, 'claimed', ?)",
    ).bind(landletId, `Test ${landletId}`, seededBuilderIds[i])));
    await env.DB.batch(seededInstanceIds.map((instanceId, i) => env.DB.prepare(
      'INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m) VALUES (?, ?, ?, 1, 1)',
    ).bind(instanceId, seededLandletIds[i], 'sweep-chunk-template')));

    // The 150th affected instance -- placed and purchased for real, since
    // this is the one that actually triggers the sweep (dropping the
    // template's stock_quantity to 0).
    const buyer = await signupBuilder('sweep-chunk-buyer');
    await createLandletAndClaim('sweep-chunk-buyer-landlet', buyer);
    await placeInstance('sweep-chunk-buyer-instance', 'sweep-chunk-buyer-landlet', 'sweep-chunk-template', buyer);

    const sale = await api('/instances/sweep-chunk-buyer-instance/purchase', buyer.session({ method: 'POST' }));
    // The real bug was a raw 500 (D1_ERROR: too many SQL variables) from
    // inside this exact call, past the point the purchase itself commits.
    expect(sale.response.status).toBe(201);

    const remaining = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM placed_instances WHERE template_id = ?',
    ).bind('sweep-chunk-template').first();
    expect(remaining.count).toBe(0);

    const markerCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sold_out_markers WHERE template_id = ?',
    ).bind('sweep-chunk-template').first();
    expect(markerCount.count).toBe(150);

    // Matches on the message text alone (it embeds the template's own name,
    // which embeds its unique templateId) rather than an IN (...) over all
    // 150 builder ids -- that would just reintroduce this same test's own
    // bug inside its own assertion.
    const notificationCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE message LIKE '%sweep-chunk-template%just sold out%'",
    ).first();
    expect(notificationCount.count).toBe(150);
  });
});
