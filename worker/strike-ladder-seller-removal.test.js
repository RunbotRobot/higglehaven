// #3049: a strike-ladder suspension (an admin approving a severe/repeat
// product flag) must run the same placed-instance removal + snapshot as
// handleSuspendAccount -- AGENTS.md's "Suspension is a hard removal from the
// world, with a snapshot that restores on unsuspension" -- and an ordinary
// admin unsuspend must then restore it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, signupSeller } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('slsr-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId) {
  const created = await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
  }));
  expect(created.response.status).toBe(201);
}

async function setUpPlacedProduct(prefix) {
  const seller = await signupSeller(`${prefix}-seller`);
  const builder = await signupAdmin(`${prefix}-builder`);
  const landletId = `${prefix}-landlet`;
  const templateId = `${prefix}-template`;
  await createGreenbeltLandlet(landletId);
  const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Ladder fixture ${prefix}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId: `${prefix}-instance`, landletId, templateId, x: 2, y: 4, scale: 1 }),
  }));
  expect(placed.response.status).toBe(201);
  return { seller, builder, landletId, templateId, instanceId: `${prefix}-instance` };
}

async function approveSevereFlag(prefix, templateId) {
  const flagger = await signupBuilder(`${prefix}-flagger`);
  await api(`/catalog/${templateId}/flags`, flagger.session({ method: 'POST', body: JSON.stringify({}) }));
  const resolved = await api(`/catalog/${templateId}/flags/resolve`, adminSession({
    method: 'POST',
    body: JSON.stringify({ action: 'approve', severe: true }),
  }));
  expect(resolved.response.status).toBe(200);
}

describe('Strike-ladder suspension removes and snapshots a seller\'s placed products (#3049)', () => {
  it('removes the placed instance and snapshots it when a severe flag suspends the seller', async () => {
    const f = await setUpPlacedProduct('slsr-remove');
    await approveSevereFlag('slsr-remove', f.templateId);

    const instances = await api(`/instances?landletId=${f.landletId}`, f.builder.session());
    expect(instances.body.instances.map((i) => i.instanceId)).not.toContain(f.instanceId);

    const snapshots = await env.DB.prepare(
      'SELECT * FROM suspended_seller_instance_snapshots WHERE seller_id = ? AND template_id = ?',
    ).bind(f.seller.sellerId, f.templateId).all();
    expect(snapshots.results.length).toBe(1);
    expect(snapshots.results[0].builder_id).toBeTruthy();
  });

  it('an admin unsuspend then restores the instance exactly as it was', async () => {
    const f = await setUpPlacedProduct('slsr-restore');
    await approveSevereFlag('slsr-restore', f.templateId);

    const lifted = await api('/auth/unsuspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: f.seller.email }),
    }));
    expect(lifted.response.status).toBe(200);
    expect(lifted.body.instancesRestored).toBe(1);

    const instances = await api(`/instances?landletId=${f.landletId}`, f.builder.session());
    // Restoration mints a fresh instance id, so match on the template.
    const restored = instances.body.instances.find((i) => i.templateId === f.templateId);
    expect(restored).toBeTruthy();
    expect(restored.x).toBe(2);
    expect(restored.y).toBe(4);
  });
});
