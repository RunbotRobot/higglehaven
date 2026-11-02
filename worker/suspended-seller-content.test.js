// #2985 (1/5 of #2305): a suspended seller's existing catalog listings must
// be fully blocked from new purchases and hidden from browsing -- both
// shoppers and the builder-facing placement picker, which turn out to
// share the one GET /api/catalog list endpoint (see that endpoint's own
// #2985 comment in worker/lib/catalog.js). Does NOT cover removing
// already-placed instances from landlets or the snapshot/restoration
// mechanism -- that's sub-issue 2 (#2986).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupSeller,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('suspended-seller-admin');
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

async function createSellerTemplate(seller, templateId, priceCents = 500) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Suspended-seller fixture ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

async function suspend(email) {
  const suspended = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email, reason: 'test suspension (#2985)' }),
  }));
  expect(suspended.response.status).toBe(200);
}

async function unsuspend(email) {
  const lifted = await api('/auth/unsuspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email }),
  }));
  expect(lifted.response.status).toBe(200);
}

describe('Suspended seller content: purchase block + catalog hide (#2985)', () => {
  it('blocks purchasing a suspended seller\'s listing, and restores it on unsuspend', async () => {
    const seller = await signupSeller('suspended-purchase-seller');
    // #653: a seller who hasn't completed real Stripe Connect onboarding
    // (never the case in this test suite, which never configures Stripe)
    // routes through the simulated/dev purchase path, closed to non-admin
    // buyers -- same reason worker/purchases.test.js's own purchase tests
    // all buy as an admin session too.
    const buyer = await signupAdmin('suspended-purchase-buyer');
    await createGreenbeltLandlet('suspended-purchase-landlet');
    await claim('suspended-purchase-landlet', buyer);
    const templateId = await createSellerTemplate(seller, 'suspended-purchase-template');
    const placed = await api('/instances', buyer.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'suspended-purchase-instance', landletId: 'suspended-purchase-landlet', templateId, x: 0, y: 0,
      }),
    }));
    expect(placed.response.status).toBe(201);

    // Not yet suspended -- purchases normally (Stripe is never configured
    // in this suite, so this exercises the simulated path, which shares
    // the exact same pre-branch suspension check as the real-money path).
    const beforeSuspend = await api('/instances/suspended-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(beforeSuspend.response.status).toBe(201);

    await suspend(seller.email);
    const afterSuspend = await api('/instances/suspended-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(afterSuspend.response.status).toBe(400);
    expect(afterSuspend.body.error).toMatch(/suspended/i);

    await unsuspend(seller.email);
    const afterUnsuspend = await api('/instances/suspended-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(afterUnsuspend.response.status).toBe(201);
  });

  it('never blocks purchasing a template with no seller at all (a system/placeholder template)', async () => {
    const buyer = await signupAdmin('no-seller-purchase-buyer');
    await createGreenbeltLandlet('no-seller-purchase-landlet');
    await claim('no-seller-purchase-landlet', buyer);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'no-seller-purchase-template', name: 'No-seller fixture',
        color: '#654321', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 100,
      }),
    });
    expect(created.response.status).toBe(201);
    const placed = await api('/instances', buyer.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'no-seller-purchase-instance', landletId: 'no-seller-purchase-landlet',
        templateId: 'no-seller-purchase-template', x: 0, y: 0,
      }),
    }));
    expect(placed.response.status).toBe(201);
    const purchased = await api('/instances/no-seller-purchase-instance/purchase', buyer.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
  });

  it('excludes a suspended seller\'s listings from GET /api/catalog, and restores them on unsuspend', async () => {
    const seller = await signupSeller('suspended-catalog-seller');
    const templateId = await createSellerTemplate(seller, 'suspended-catalog-template');

    const before = await api('/catalog?limit=100');
    expect(before.body.templates.map((t) => t.templateId)).toContain(templateId);

    await suspend(seller.email);
    const during = await api('/catalog?limit=100');
    expect(during.body.templates.map((t) => t.templateId)).not.toContain(templateId);
    // The single-item detail route is deliberately untouched by this
    // sub-issue -- see worker/lib/catalog.js's own #2985 comment on the
    // list endpoint for why only that one needed the filter.
    const singleDuring = await api(`/catalog/${templateId}`);
    expect(singleDuring.response.status).toBe(200);

    await unsuspend(seller.email);
    const after = await api('/catalog?limit=100');
    expect(after.body.templates.map((t) => t.templateId)).toContain(templateId);
  });

  it('never excludes a template with no seller at all from GET /api/catalog', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'no-seller-catalog-template', name: 'No-seller catalog fixture',
        color: '#abcdef', dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    const listed = await api('/catalog?limit=100');
    expect(listed.body.templates.map((t) => t.templateId)).toContain('no-seller-catalog-template');
  });
});
