// #2986 (sub-issue 2/5 of #2305): when a seller is suspended, every
// already-placed instance of their listed products -- across every
// builder's own landlet -- is removed from the world and snapshotted
// (suspended_seller_instance_snapshots), then restored exactly on
// unsuspend for every builder who hasn't permanently cleared their own
// slot in the meantime (sub-issue 3, #2987, not built yet -- simulated
// here via a direct cleared_at write, since that's the only interface
// this sub-issue's own scope defines for it).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupSeller,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('sss-admin');
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
      name: `SSS fixture ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

async function placeInstance(instanceId, landletId, templateId, builder, { x = 0, y = 0, scale = 1 } = {}) {
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId, landletId, templateId, x, y, scale }),
  }));
  expect(placed.response.status).toBe(201);
  return placed.body.instance;
}

async function suspend(email) {
  const suspended = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email, reason: 'test suspension (#2986)' }),
  }));
  expect(suspended.response.status).toBe(200);
  return suspended.body;
}

async function unsuspend(email) {
  const lifted = await api('/auth/unsuspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email }),
  }));
  expect(lifted.response.status).toBe(200);
  return lifted.body;
}

describe('Suspended seller content: remove + snapshot + auto-restore placed instances (#2986)', () => {
  it('removes a suspended seller\'s placed instance, snapshots it, and restores it exactly on unsuspend', async () => {
    const seller = await signupSeller('sss-remove-restore-seller');
    const builder = await signupAdmin('sss-remove-restore-builder');
    await createGreenbeltLandlet('sss-remove-restore-landlet');
    await claim('sss-remove-restore-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'sss-remove-restore-template');
    const original = await placeInstance('sss-remove-restore-instance', 'sss-remove-restore-landlet', templateId, builder, { x: 3, y: 5, scale: 2 });

    const suspendResult = await suspend(seller.email);
    expect(suspendResult.instancesRemoved).toBe(1);

    const afterRemoval = await api('/instances?landletId=sss-remove-restore-landlet', builder.session());
    expect(afterRemoval.body.instances.map((i) => i.instanceId)).not.toContain('sss-remove-restore-instance');

    const snapshotRow = await env.DB.prepare(
      'SELECT * FROM suspended_seller_instance_snapshots WHERE landlet_id = ? AND template_id = ?',
    ).bind('sss-remove-restore-landlet', templateId).first();
    expect(snapshotRow).toBeTruthy();
    expect(snapshotRow.builder_id).toBe(builder.builder.builderId);
    expect(snapshotRow.restored_at).toBeNull();
    expect(snapshotRow.cleared_at).toBeNull();

    const unsuspendResult = await unsuspend(seller.email);
    expect(unsuspendResult.instancesRestored).toBe(1);

    const afterRestore = await api('/instances?landletId=sss-remove-restore-landlet', builder.session());
    const restored = afterRestore.body.instances.find((i) => i.templateId === templateId);
    expect(restored).toBeTruthy();
    expect(restored.instanceId).not.toBe(original.instanceId); // a fresh id, not the removed one
    expect(restored.x).toBe(3);
    expect(restored.y).toBe(5);
    expect(restored.scale).toBe(2);

    const snapshotAfterRestore = await env.DB.prepare(
      'SELECT restored_at FROM suspended_seller_instance_snapshots WHERE snapshot_id = ?',
    ).bind(snapshotRow.snapshot_id).first();
    expect(snapshotAfterRestore.restored_at).toBeTruthy();
  });

  it('preserves group membership across removal and restoration (#2764)', async () => {
    const seller = await signupSeller('sss-group-seller');
    const builder = await signupAdmin('sss-group-builder');
    await createGreenbeltLandlet('sss-group-landlet');
    await claim('sss-group-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'sss-group-template');
    const suspendedMember = await placeInstance('sss-group-instance-suspended', 'sss-group-landlet', templateId, builder, { x: 1, y: 1 });
    // The surviving member belongs to a system/placeholder template (no
    // sellerId at all, so it's never affected by this seller's own
    // suspension) -- grouping it with the suspended seller's own instance
    // proves removal doesn't touch a group sibling it has no business
    // touching.
    const otherTemplateCreated = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sss-group-other-template', name: 'SSS group other fixture',
        color: '#654321', dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(otherTemplateCreated.response.status).toBe(201);
    const survivingInstance = await placeInstance('sss-group-instance-surviving', 'sss-group-landlet', 'sss-group-other-template', builder, { x: 2, y: 2 });

    const grouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: [suspendedMember.instanceId, survivingInstance.instanceId] }),
    }));
    expect(grouped.response.status).toBe(201);
    const groupId = grouped.body.groupId;

    await suspend(seller.email);

    const survivingAfterRemoval = await env.DB.prepare(
      'SELECT group_id FROM placed_instances WHERE instance_id = ?',
    ).bind(survivingInstance.instanceId).first();
    expect(survivingAfterRemoval.group_id).toBe(groupId);

    await unsuspend(seller.email);

    // Exactly one row for this template+landlet by now -- the original
    // suspended instance was deleted outright, replaced by exactly one
    // freshly-restored row.
    const restoredRow = await env.DB.prepare(
      'SELECT group_id FROM placed_instances WHERE template_id = ? AND landlet_id = ?',
    ).bind(templateId, 'sss-group-landlet').first();
    expect(restoredRow.group_id).toBe(groupId);
  });

  it('does not restore a snapshot the affected builder has permanently cleared', async () => {
    const seller = await signupSeller('sss-cleared-seller');
    const builder = await signupAdmin('sss-cleared-builder');
    await createGreenbeltLandlet('sss-cleared-landlet');
    await claim('sss-cleared-landlet', builder);
    const templateId = await createSellerTemplate(seller, 'sss-cleared-template');
    await placeInstance('sss-cleared-instance', 'sss-cleared-landlet', templateId, builder);

    await suspend(seller.email);
    const snapshotRow = await env.DB.prepare(
      'SELECT snapshot_id FROM suspended_seller_instance_snapshots WHERE landlet_id = ?',
    ).bind('sss-cleared-landlet').first();
    // Stands in for sub-issue 3's own "permanently clear" action, not yet
    // built -- cleared_at is the only interface this sub-issue defines for
    // it.
    await env.DB.prepare(
      'UPDATE suspended_seller_instance_snapshots SET cleared_at = ? WHERE snapshot_id = ?',
    ).bind(new Date().toISOString(), snapshotRow.snapshot_id).run();

    const unsuspendResult = await unsuspend(seller.email);
    expect(unsuspendResult.instancesRestored).toBe(0);

    const afterRestore = await api('/instances?landletId=sss-cleared-landlet', builder.session());
    expect(afterRestore.body.instances.map((i) => i.templateId)).not.toContain(templateId);
  });

  it('does not restore onto a landlet reassigned to a different owner in the meantime (#1280/#2508)', async () => {
    const seller = await signupSeller('sss-reassign-seller');
    const originalBuilder = await signupAdmin('sss-reassign-original-builder');
    const newBuilder = await signupAdmin('sss-reassign-new-builder');
    await createGreenbeltLandlet('sss-reassign-landlet');
    await claim('sss-reassign-landlet', originalBuilder);
    const templateId = await createSellerTemplate(seller, 'sss-reassign-template');
    await placeInstance('sss-reassign-instance', 'sss-reassign-landlet', templateId, originalBuilder);

    await suspend(seller.email);
    const reassigned = await api('/landlets/sss-reassign-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: newBuilder.builder.builderId }),
    }));
    expect(reassigned.response.status).toBe(200);

    const unsuspendResult = await unsuspend(seller.email);
    expect(unsuspendResult.instancesRestored).toBe(0);

    const afterRestore = await api('/instances?landletId=sss-reassign-landlet', newBuilder.session());
    expect(afterRestore.body.instances.map((i) => i.templateId)).not.toContain(templateId);

    const snapshotRow = await env.DB.prepare(
      'SELECT restored_at FROM suspended_seller_instance_snapshots WHERE landlet_id = ?',
    ).bind('sss-reassign-landlet').first();
    expect(snapshotRow.restored_at).toBeNull();
  });

  it('never touches a template with no seller at all (a system/placeholder template)', async () => {
    const builder = await signupAdmin('sss-no-seller-builder');
    await createGreenbeltLandlet('sss-no-seller-landlet');
    await claim('sss-no-seller-landlet', builder);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'sss-no-seller-template', name: 'SSS no-seller fixture',
        color: '#abcdef', dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance('sss-no-seller-instance', 'sss-no-seller-landlet', 'sss-no-seller-template', builder);

    // Suspending an account with no seller profile at all (a plain
    // builder) must be a complete no-op for this mechanism.
    const plainBuilder = await signupAdmin('sss-no-seller-suspendee');
    const suspendResult = await suspend(plainBuilder.email);
    expect(suspendResult.instancesRemoved).toBe(0);

    const stillThere = await api('/instances?landletId=sss-no-seller-landlet', builder.session());
    expect(stillThere.body.instances.map((i) => i.templateId)).toContain('sss-no-seller-template');
  });
});
