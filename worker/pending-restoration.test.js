// #2987 (sub-issue 3/5 of #2305): the builder-facing half of #2986's
// suspended-seller snapshots -- a pending-restoration list visible only to
// the builder the content was removed from, and a permanent-clear action
// that makes #2986's auto-restore skip that slot.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupSeller,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('pr-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId, areaM2 = 1000) {
  const created = await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
  }));
  expect(created.response.status).toBe(201);
}

async function claim(landletId, builder) {
  const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
}

async function createSellerTemplate(seller, templateId) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Pending fixture ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

async function place(instanceId, landletId, templateId, builder, { x = 0, y = 0 } = {}) {
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId, landletId, templateId, x, y }),
  }));
  expect(placed.response.status).toBe(201);
}

async function suspend(email) {
  const result = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email, reason: 'test suspension (#2987)' }),
  }));
  expect(result.response.status).toBe(200);
  return result.body;
}

async function unsuspend(email) {
  const result = await api('/auth/unsuspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email }),
  }));
  expect(result.response.status).toBe(200);
  return result.body;
}

async function listPending(builder) {
  const listed = await api('/instances/pending-restoration', builder.session());
  expect(listed.response.status).toBe(200);
  return listed.body.pendingRestorations;
}

describe('Builder-facing pending restoration (#2987)', () => {
  it('shows the owning builder what used to be on their land, and nobody else', async () => {
    const seller = await signupSeller('pr-list-seller');
    const builder = await signupAdmin('pr-list-builder');
    const stranger = await signupAdmin('pr-list-stranger');
    await createGreenbeltLandlet('pr-list-landlet');
    await claim('pr-list-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'pr-list-template');
    await place('pr-list-instance', 'pr-list-landlet', templateId, builder, { x: 3, y: 5 });

    expect(await listPending(builder)).toEqual([]);

    await suspend(seller.email);

    const pending = await listPending(builder);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      landletId: 'pr-list-landlet',
      templateId,
      templateName: `Pending fixture ${templateId}`,
      position: { x: 3, y: 5 },
      sellerSuspended: true,
      // #3095: the removed placement's original id, so an open Build tab can
      // drop exactly that mesh.
      removedInstanceId: 'pr-list-instance',
    });
    expect(pending[0].snapshotId).toBeTruthy();
    expect(pending[0].removedAt).toBeTruthy();

    // Another builder's view never includes it.
    expect(await listPending(stranger)).toEqual([]);

    // Unauthenticated callers get nothing at all.
    const anonymous = await api('/instances/pending-restoration');
    expect(anonymous.response.status).toBe(401);
  });

  it('drops the slot from the list once the suspension is lifted and it is restored', async () => {
    const seller = await signupSeller('pr-restore-seller');
    const builder = await signupAdmin('pr-restore-builder');
    await createGreenbeltLandlet('pr-restore-landlet');
    await claim('pr-restore-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'pr-restore-template');
    await place('pr-restore-instance', 'pr-restore-landlet', templateId, builder);

    await suspend(seller.email);
    expect(await listPending(builder)).toHaveLength(1);

    await unsuspend(seller.email);
    expect(await listPending(builder)).toEqual([]);
  });

  it('lets the builder permanently clear a slot, and a cleared slot is not restored on unsuspend', async () => {
    const seller = await signupSeller('pr-clear-seller');
    const builder = await signupAdmin('pr-clear-builder');
    await createGreenbeltLandlet('pr-clear-landlet');
    await claim('pr-clear-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'pr-clear-template');
    await place('pr-clear-instance', 'pr-clear-landlet', templateId, builder);

    await suspend(seller.email);
    const [slot] = await listPending(builder);

    const cleared = await api(`/instances/pending-restoration/${slot.snapshotId}`, builder.session({ method: 'DELETE' }));
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.clearedSnapshotId).toBe(slot.snapshotId);
    expect(await listPending(builder)).toEqual([]);

    // The row itself is retained (soft-cleared), not deleted.
    const row = await env.DB.prepare(
      'SELECT cleared_at FROM suspended_seller_instance_snapshots WHERE snapshot_id = ?',
    ).bind(slot.snapshotId).first();
    expect(row.cleared_at).toBeTruthy();

    // Cross-check with #2986: the cleared slot does not come back.
    const lifted = await unsuspend(seller.email);
    expect(lifted.instancesRestored).toBe(0);
    const instances = await api('/instances?landletId=pr-clear-landlet', builder.session());
    expect(instances.body.instances.map((i) => i.templateId)).not.toContain(templateId);

    // Clearing twice is a clean 404, not a second success.
    const again = await api(`/instances/pending-restoration/${slot.snapshotId}`, builder.session({ method: 'DELETE' }));
    expect(again.response.status).toBe(404);
  });

  it('refuses to let a different builder clear someone else\'s slot', async () => {
    const seller = await signupSeller('pr-foreign-seller');
    const builder = await signupAdmin('pr-foreign-builder');
    const stranger = await signupAdmin('pr-foreign-stranger');
    await createGreenbeltLandlet('pr-foreign-landlet');
    await claim('pr-foreign-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'pr-foreign-template');
    await place('pr-foreign-instance', 'pr-foreign-landlet', templateId, builder);

    await suspend(seller.email);
    const [slot] = await listPending(builder);

    const attempt = await api(`/instances/pending-restoration/${slot.snapshotId}`, stranger.session({ method: 'DELETE' }));
    expect(attempt.response.status).toBe(404);
    expect(await listPending(builder)).toHaveLength(1);

    // Still restorable -- the stranger's attempt changed nothing.
    const lifted = await unsuspend(seller.email);
    expect(lifted.instancesRestored).toBe(1);
  });

  it('does not list a slot on land the builder no longer owns', async () => {
    const seller = await signupSeller('pr-reassign-seller');
    const originalBuilder = await signupAdmin('pr-reassign-original');
    const newBuilder = await signupAdmin('pr-reassign-new');
    await createGreenbeltLandlet('pr-reassign-landlet');
    await claim('pr-reassign-landlet', originalBuilder);
    const templateId = await createSellerTemplate(seller, 'pr-reassign-template');
    await place('pr-reassign-instance', 'pr-reassign-landlet', templateId, originalBuilder);

    await suspend(seller.email);
    expect(await listPending(originalBuilder)).toHaveLength(1);

    const reassigned = await api('/landlets/pr-reassign-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: newBuilder.builder.builderId }),
    }));
    expect(reassigned.response.status).toBe(200);

    expect(await listPending(originalBuilder)).toEqual([]);
    expect(await listPending(newBuilder)).toEqual([]);
  });
});
