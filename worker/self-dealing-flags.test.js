// #2019 (sub-issue of #1212, owner-settled shape 2026-10-13): the one
// signal from this sub-issue's original three-signal scope this codebase
// can actually compare -- a purchase where the buyer's and the listing's
// seller's own on-file email match. See migrations/0132's own comment,
// and this PR's own docs/API.md entry, for why shipping-address and
// Stripe-customer-ID matching aren't built here.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupBuilder, signupSeller,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('self-dealing-shared-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId) {
  return api('/landlets', adminSession({
    method: 'POST', body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
  }));
}

async function createTemplate(templateId, seller) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId, name: `Self-dealing test product ${templateId}`, color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, sellerId: seller.sellerId,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

describe('Self-dealing flags (#2019)', () => {
  it('flags a purchase where the buyer and the listing\'s own seller are the same account', async () => {
    const seller = await signupSeller('self-dealing-same-account');
    await createGreenbeltLandlet('self-dealing-same-landlet');
    await api('/landlets/self-dealing-same-landlet/claim', seller.session({ method: 'POST' }));
    await createTemplate('self-dealing-same-template', seller);
    await api('/instances', seller.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'self-dealing-same-instance', landletId: 'self-dealing-same-landlet', templateId: 'self-dealing-same-template', x: 0, y: 0 }),
    }));

    const purchased = await api('/instances/self-dealing-same-instance/purchase', seller.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;

    const { results } = await env.DB.prepare('SELECT * FROM self_dealing_flags WHERE purchase_id = ?').bind(purchaseId).all();
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].matched_signals)).toEqual(['email']);
    expect(results[0].status).toBe('pending');
  });

  it('does not flag an ordinary purchase between two different accounts', async () => {
    const seller = await signupSeller('self-dealing-different-seller');
    const buyer = await signupBuilder('self-dealing-different-buyer');
    await createGreenbeltLandlet('self-dealing-different-landlet');
    await api('/landlets/self-dealing-different-landlet/claim', seller.session({ method: 'POST' }));
    await createTemplate('self-dealing-different-template', seller);
    await api('/instances', seller.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'self-dealing-different-instance', landletId: 'self-dealing-different-landlet', templateId: 'self-dealing-different-template', x: 0, y: 0 }),
    }));

    const purchased = await api('/instances/self-dealing-different-instance/purchase', buyer.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;

    const { results } = await env.DB.prepare('SELECT * FROM self_dealing_flags WHERE purchase_id = ?').bind(purchaseId).all();
    expect(results).toHaveLength(0);
  });

  it('never flags a listing with no linked seller account (seller_id null)', async () => {
    const buyer = await signupBuilder('self-dealing-no-seller-buyer');
    await createGreenbeltLandlet('self-dealing-no-seller-landlet');
    await api('/landlets/self-dealing-no-seller-landlet/claim', buyer.session({ method: 'POST' }));
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'self-dealing-no-seller-template', name: 'No seller product', color: '#222222',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    await api('/instances', buyer.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'self-dealing-no-seller-instance', landletId: 'self-dealing-no-seller-landlet', templateId: 'self-dealing-no-seller-template', x: 0, y: 0 }),
    }));

    const purchased = await api('/instances/self-dealing-no-seller-instance/purchase', buyer.session({ method: 'POST' }));
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;

    const { results } = await env.DB.prepare('SELECT * FROM self_dealing_flags WHERE purchase_id = ?').bind(purchaseId).all();
    expect(results).toHaveLength(0);
  });

  describe('GET /api/self-dealing-flags', () => {
    it('requires an admin session', async () => {
      const anon = await api('/self-dealing-flags');
      expect(anon.response.status).toBe(401);
      const nonAdmin = await signupBuilder('self-dealing-list-nonadmin');
      const rejected = await api('/self-dealing-flags', nonAdmin.session());
      expect(rejected.response.status).toBe(403);
    });

    it('lists pending flags, newest first, joined against their own purchase', async () => {
      const seller = await signupSeller('self-dealing-list-seller');
      await createGreenbeltLandlet('self-dealing-list-landlet');
      await api('/landlets/self-dealing-list-landlet/claim', seller.session({ method: 'POST' }));
      await createTemplate('self-dealing-list-template', seller);
      await api('/instances', seller.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: 'self-dealing-list-instance', landletId: 'self-dealing-list-landlet', templateId: 'self-dealing-list-template', x: 0, y: 0 }),
      }));
      const purchased = await api('/instances/self-dealing-list-instance/purchase', seller.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;

      const listed = await api('/self-dealing-flags', adminSession());
      expect(listed.response.status).toBe(200);
      const hit = listed.body.flags.find((f) => f.purchaseId === purchaseId);
      expect(hit).toBeTruthy();
      expect(hit.matchedSignals).toEqual(['email']);
      expect(hit.templateId).toBe('self-dealing-list-template');
      // #2110: totalCount counts every pending flag, not just the capped
      // page -- must be at least 1 (this test's own flag).
      expect(listed.body.totalCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /api/self-dealing-flags/:flagId/review', () => {
    async function createFlaggedPurchase(prefix) {
      const seller = await signupSeller(`${prefix}-seller`);
      await createGreenbeltLandlet(`${prefix}-landlet`);
      await api(`/landlets/${prefix}-landlet/claim`, seller.session({ method: 'POST' }));
      await createTemplate(`${prefix}-template`, seller);
      await api('/instances', seller.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: `${prefix}-instance`, landletId: `${prefix}-landlet`, templateId: `${prefix}-template`, x: 0, y: 0 }),
      }));
      const purchased = await api(`/instances/${prefix}-instance/purchase`, seller.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;
      const flagRow = await env.DB.prepare('SELECT flag_id FROM self_dealing_flags WHERE purchase_id = ?').bind(purchaseId).first();
      return flagRow.flag_id;
    }

    it('requires an admin session', async () => {
      const flagId = await createFlaggedPurchase('self-dealing-review-auth');
      const anon = await api(`/self-dealing-flags/${flagId}/review`, { method: 'POST', body: JSON.stringify({}) });
      expect(anon.response.status).toBe(401);
      const nonAdmin = await signupBuilder('self-dealing-review-nonadmin');
      const rejected = await api(`/self-dealing-flags/${flagId}/review`, nonAdmin.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      expect(rejected.response.status).toBe(403);
    });

    it('marks a flag reviewed with an optional note, removing it from the pending list', async () => {
      const flagId = await createFlaggedPurchase('self-dealing-review-ok');
      const reviewed = await api(`/self-dealing-flags/${flagId}/review`, adminSession({
        method: 'POST', body: JSON.stringify({ notes: 'Confirmed roommates, no action needed' }),
      }));
      expect(reviewed.response.status).toBe(200);
      expect(reviewed.body.reviewed).toBe(true);

      const row = await env.DB.prepare('SELECT * FROM self_dealing_flags WHERE flag_id = ?').bind(flagId).first();
      expect(row.status).toBe('reviewed');
      expect(row.review_notes).toBe('Confirmed roommates, no action needed');
      expect(row.reviewed_at).toBeTruthy();
      expect(row.reviewed_by_admin_user_id).toBeTruthy();

      const listed = await api('/self-dealing-flags', adminSession());
      expect(listed.body.flags.some((f) => f.flagId === flagId)).toBe(false);
    });

    it('400s a note over 280 characters', async () => {
      const flagId = await createFlaggedPurchase('self-dealing-review-toolong');
      const rejected = await api(`/self-dealing-flags/${flagId}/review`, adminSession({
        method: 'POST', body: JSON.stringify({ notes: 'x'.repeat(281) }),
      }));
      expect(rejected.response.status).toBe(400);
    });

    it('404s reviewing an already-reviewed (or nonexistent) flag', async () => {
      const flagId = await createFlaggedPurchase('self-dealing-review-twice');
      await api(`/self-dealing-flags/${flagId}/review`, adminSession({ method: 'POST', body: JSON.stringify({}) }));
      const second = await api(`/self-dealing-flags/${flagId}/review`, adminSession({ method: 'POST', body: JSON.stringify({}) }));
      expect(second.response.status).toBe(404);

      const nonexistent = await api('/self-dealing-flags/does-not-exist/review', adminSession({
        method: 'POST', body: JSON.stringify({}),
      }));
      expect(nonexistent.response.status).toBe(404);
    });

    it('rate-limits repeated review calls from the same admin', async () => {
      // #1057-class gotcha: signupSeller's username caps at 40 chars
      // (worker/index.js's own username length check) -- keep this prefix
      // short so `${prefix}-seller` never brushes that limit across 21
      // iterations the way a longer, more descriptive prefix did.
      const admin = await signupAdmin('self-dealing-rl-admin');
      for (let i = 0; i < 20; i += 1) {
        const flagId = await createFlaggedPurchase(`sd-rl-${i}`);
        const attempt = await api(`/self-dealing-flags/${flagId}/review`, admin.session({
          method: 'POST', body: JSON.stringify({}),
        }));
        expect(attempt.response.status).toBe(200);
      }
      const flagId = await createFlaggedPurchase('sd-rl-final');
      const limited = await api(`/self-dealing-flags/${flagId}/review`, admin.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      expect(limited.response.status).toBe(429);
    });
  });
});
