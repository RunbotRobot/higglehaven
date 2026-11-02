// #2989 (sub-issue of #2305, "suspended-seller content" tracking issue):
// a suspended builder's own placed content should stop being interactable
// for everyone else, the same "hide from interaction" principle #2985
// already enforces for a suspended SELLER's listed products -- but mirrored
// at the landlet-owner level instead of the template-seller level, and
// without touching the builder's own ability to see/manage their own land.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupBuilder, signupAdmin,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('suspended-content-shared-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandletWithArea(landletId, areaM2) {
  return api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
  }));
}

async function claim(landletId, builder) {
  return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
}

async function createTemplate(templateId, { priceCents } = {}) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: `Purchasable product ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents,
    }),
  });
  expect(created.response.status).toBe(201);
  return templateId;
}

async function placeInstance(instanceId, landletId, templateId, builder) {
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
  }));
  expect(placed.response.status).toBe(201);
  return instanceId;
}

async function suspend(email) {
  const result = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email, reason: 'test suspension' }),
  }));
  expect(result.response.status).toBe(200);
}

async function unsuspend(email) {
  const result = await api('/auth/unsuspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email }),
  }));
  expect(result.response.status).toBe(200);
}

describe('Suspended builder content (#2989)', () => {
  it('hides a suspended builder\'s placed instances from a third-party visitor, but not from the builder\'s own session', async () => {
    const owner = await signupBuilder('suspended-content-landlet-owner');
    const visitor = await signupBuilder('suspended-content-visitor');
    await createGreenbeltLandletWithArea('suspended-content-landlet', 1000);
    await claim('suspended-content-landlet', owner);
    await createTemplate('suspended-content-template');
    await placeInstance('suspended-content-instance', 'suspended-content-landlet', 'suspended-content-template', owner);

    // Before suspension: a third party sees the instance normally, same as
    // today — this is the regression baseline the fix must not break.
    const before = await api('/instances?landletId=suspended-content-landlet', visitor.session());
    expect(before.response.status).toBe(200);
    expect(before.body.instances.map((i) => i.instanceId)).toContain('suspended-content-instance');

    await suspend(owner.email);

    // After suspension: the visitor's own listing comes back empty, not an
    // error — same "quietly hidden, not a broken page" posture #2985 chose
    // for a suspended seller's own catalog visibility.
    const afterAsVisitor = await api('/instances?landletId=suspended-content-landlet', visitor.session());
    expect(afterAsVisitor.response.status).toBe(200);
    expect(afterAsVisitor.body.instances).toEqual([]);

    // An entirely unauthenticated request (this endpoint has never required
    // a session) is hidden the same way, not just a known builder's own.
    const afterAnonymous = await api('/instances?landletId=suspended-content-landlet');
    expect(afterAnonymous.response.status).toBe(200);
    expect(afterAnonymous.body.instances).toEqual([]);

    // The suspended owner's OWN session still sees their own land in full —
    // suspension gates what OTHERS can do with their content, not their own
    // standing access to manage it (requireCurrentUser's own suspension
    // check is what blocks the owner's own authenticated actions elsewhere).
    const afterAsOwner = await api('/instances?landletId=suspended-content-landlet', owner.session());
    expect(afterAsOwner.response.status).toBe(200);
    expect(afterAsOwner.body.instances.map((i) => i.instanceId)).toContain('suspended-content-instance');

    await unsuspend(owner.email);

    // Lifting the suspension restores normal visibility for everyone.
    const afterUnsuspend = await api('/instances?landletId=suspended-content-landlet', visitor.session());
    expect(afterUnsuspend.response.status).toBe(200);
    expect(afterUnsuspend.body.instances.map((i) => i.instanceId)).toContain('suspended-content-instance');
  });

  it('blocks purchasing an instance placed on a suspended builder\'s landlet, and un-blocks it once unsuspended', async () => {
    const owner = await signupBuilder('suspended-content-purchase-owner');
    const buyer = await signupAdmin('suspended-content-purchase-buyer');
    await createGreenbeltLandletWithArea('suspended-content-purchase-landlet', 1000);
    await claim('suspended-content-purchase-landlet', owner);
    await createTemplate('suspended-content-purchase-template', { priceCents: 500 });
    await placeInstance(
      'suspended-content-purchase-instance', 'suspended-content-purchase-landlet', 'suspended-content-purchase-template', owner,
    );

    await suspend(owner.email);

    const blocked = await api('/instances/suspended-content-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(blocked.response.status).toBe(400);
    expect(blocked.body.error).toMatch(/suspended/i);

    // No purchase row was written for the rejected attempt.
    const purchaseRows = await env.DB.prepare('SELECT COUNT(*) AS count FROM purchases WHERE instance_id = ?')
      .bind('suspended-content-purchase-instance').first();
    expect(purchaseRows.count).toBe(0);

    await unsuspend(owner.email);

    const allowed = await api('/instances/suspended-content-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(allowed.response.status).toBe(201);
  });
});
