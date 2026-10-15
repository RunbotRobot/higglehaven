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
