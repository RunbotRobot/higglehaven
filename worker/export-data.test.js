// #1984 (sub-issue of #1983, owner-greenlit on #1480): GET /api/auth/export-data,
// the foundational endpoint + identity/profile section of the GDPR/CCPA
// "right to access" companion to #1145's own "right to erasure". Later
// sub-issues (#1985 commerce/economy, #1986 social/content) add their own
// top-level keys to this same response shape -- this file covers the
// `profile` section #1984 itself ships, plus the `commerce` section #1985
// adds below.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, signup, signupBuilder, withSession,
} from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('GET /auth/export-data (#1984)', () => {
  it('requires a session', async () => {
    const anon = await api('/auth/export-data');
    expect(anon.response.status).toBe(401);
  });

  it('returns the account and builder profile, with no seller profile yet', async () => {
    const account = await signupBuilder('export-data-builder');
    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.exportedAt).toBeTruthy();
    expect(result.body.profile.account.email).toBe(account.email);
    expect(result.body.profile.account.password_hash).toBeUndefined();
    expect(result.body.profile.builder.builderId).toBe(account.builderId);
    expect(result.body.profile.seller).toBeNull();
    expect(result.body.profile.diditVerificationSessions).toEqual([]);
  });

  it('includes the seller profile once one exists', async () => {
    const email = `export-data-seller-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here', { username: 'export-data-seller' });
    const sessionToken = extractSessionCookie(signedUp.response);
    await api('/sellers/me', withSession(sessionToken));
    const result = await api('/auth/export-data', withSession(sessionToken));
    expect(result.response.status).toBe(200);
    expect(result.body.profile.seller).not.toBeNull();
    expect(result.body.profile.seller.label).toBe('export-data-seller');
  });

  it('includes didit verification sessions by status/timestamp only, never a raw payload', async () => {
    const account = await signupBuilder('export-data-didit');
    const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(account.email).first()).user_id;
    await env.DB.prepare(
      'INSERT INTO didit_verification_sessions (session_id, user_id, status, processed_at) VALUES (?, ?, ?, ?)',
    ).bind('didit-export-test-session', userId, 'approved', '2026-10-01T00:00:00.000Z').run();

    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.profile.diditVerificationSessions).toEqual([{
      sessionId: 'didit-export-test-session',
      status: 'approved',
      createdAt: expect.any(String),
      processedAt: '2026-10-01T00:00:00.000Z',
    }]);
  });

  it('rate-limits repeated calls from the same account', async () => {
    const account = await signupBuilder('export-data-rate-limit');
    for (let i = 0; i < 10; i += 1) {
      const attempt = await api('/auth/export-data', account.session());
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api('/auth/export-data', account.session());
    expect(limited.response.status).toBe(429);
  });
});

// #1985 (sub-issue of #1983): the commerce/economy section -- purchases
// (as buyer), owned avatars/animations, video-generation jobs, higgles
// redemptions/earnings, and authored bundles. Deliberately excludes
// tax_1099_forms (the owner call on raw taxIdNumber/foreignTaxId inclusion,
// flagged on #1983, is still open) and owned_avatar_purchases/
// owned_animation_purchases (internal grant-bookkeeping tables with no
// field not already present on the corresponding owned_avatars/
// owned_animations row itself).
describe('GET /auth/export-data commerce section (#1985)', () => {
  it('returns every commerce list empty for a fresh account with no builder profile at all', async () => {
    const email = `export-data-commerce-no-builder-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here', { username: 'export-data-no-builder' });
    const sessionToken = extractSessionCookie(signedUp.response);
    const result = await api('/auth/export-data', withSession(sessionToken));
    expect(result.response.status).toBe(200);
    expect(result.body.commerce).toEqual({
      purchasesAsBuyer: [],
      ownedAvatars: [],
      ownedAnimations: [],
      videoGenerationJobs: [],
      higglesRedemptions: [],
      higglesEarningsEvents: [],
      bundles: [],
    });
  });

  it('returns every commerce list empty for a fresh builder with no commerce history', async () => {
    const account = await signupBuilder('export-data-commerce-empty');
    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.commerce).toEqual({
      purchasesAsBuyer: [],
      ownedAvatars: [],
      ownedAnimations: [],
      videoGenerationJobs: [],
      higglesRedemptions: [],
      higglesEarningsEvents: [],
      bundles: [],
    });
  });

  it('includes a purchase made as buyer, scoped by buyer_builder_id not builder_id (the host)', async () => {
    const host = await signupBuilder('export-data-commerce-host');
    const buyer = await signupBuilder('export-data-commerce-buyer');
    const purchaseId = `purchase-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO purchases (
        purchase_id, instance_id, template_id, builder_id, buyer_builder_id, unit_price_cents, quantity,
        total_cents, commission_cents, builder_share_cents, platform_share_cents
      ) VALUES (?, 'export-data-instance', 'export-data-template', ?, ?, 500, 1, 500, 10, 490, 10)
    `).bind(purchaseId, host.builderId, buyer.builderId).run();

    const buyerResult = await api('/auth/export-data', buyer.session());
    expect(buyerResult.body.commerce.purchasesAsBuyer).toHaveLength(1);
    expect(buyerResult.body.commerce.purchasesAsBuyer[0]).toMatchObject({
      purchaseId, builderId: host.builderId, buyerBuilderId: buyer.builderId, totalCents: 500,
    });

    // The host earned commission on this purchase but didn't buy anything —
    // buyer_builder_id, not builder_id, is what scopes "as buyer".
    const hostResult = await api('/auth/export-data', host.session());
    expect(hostResult.body.commerce.purchasesAsBuyer).toEqual([]);
  });

  it('includes owned avatars and animations with their purchasedAt timestamp', async () => {
    const builder = await signupBuilder('export-data-commerce-owned');
    await env.DB.prepare(`
      INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, price_cents)
      VALUES ('export-data-avatar-template', 'Export Data Avatar', 'avatar', '#123456', 1, 1, 2, 500)
    `).run();
    await env.DB.prepare(`
      INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, price_cents)
      VALUES ('export-data-animation-template', 'Export Data Animation', 'animation', '#654321', 1, 1, 2, 500)
    `).run();
    await env.DB.prepare(`
      INSERT INTO owned_avatars (builder_id, template_id, purchased_at) VALUES (?, 'export-data-avatar-template', '2026-10-01T00:00:00.000Z')
    `).bind(builder.builderId).run();
    await env.DB.prepare(`
      INSERT INTO owned_animations (builder_id, template_id, purchased_at) VALUES (?, 'export-data-animation-template', '2026-10-02T00:00:00.000Z')
    `).bind(builder.builderId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.commerce.ownedAvatars).toEqual([expect.objectContaining({
      templateId: 'export-data-avatar-template', purchasedAt: '2026-10-01T00:00:00.000Z',
    })]);
    expect(result.body.commerce.ownedAnimations).toEqual([expect.objectContaining({
      templateId: 'export-data-animation-template', purchasedAt: '2026-10-02T00:00:00.000Z',
    })]);
  });

  it('includes video generation jobs, higgles redemptions, and higgles earnings events', async () => {
    const builder = await signupBuilder('export-data-commerce-economy');
    await env.DB.prepare(`
      INSERT INTO video_generation_jobs (job_id, builder_id, provider_task_id, status, model_url)
      VALUES ('export-data-job', ?, 'export-data-task', 'complete', '/uploads/export-data.glb')
    `).bind(builder.builderId).run();
    const redemptionId = `redemption-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO higgles_redemptions (redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id)
      VALUES (?, ?, 10000, 'tr_export_data', 'po_export_data')
    `).bind(redemptionId, builder.builderId).run();
    const eventId = `earnings-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, 250)
    `).bind(eventId, builder.builderId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.commerce.videoGenerationJobs).toEqual([{
      jobId: 'export-data-job', providerTaskId: 'export-data-task', status: 'complete',
      modelUrl: '/uploads/export-data.glb', error: null, createdAt: expect.any(String), processedAt: null,
    }]);
    expect(result.body.commerce.higglesRedemptions).toEqual([{
      redemptionId, amountCents: 10000, stripeTransferId: 'tr_export_data', stripePayoutId: 'po_export_data',
      createdAt: expect.any(String),
    }]);
    expect(result.body.commerce.higglesEarningsEvents).toEqual([{
      eventId, amountCents: 250, createdAt: expect.any(String),
    }]);
  });

  it('includes authored bundles', async () => {
    const builder = await signupBuilder('export-data-commerce-bundles');
    const bundleId = `bundle-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO bundles (bundle_id, builder_id, name, items_json) VALUES (?, ?, 'Export Data Bundle', '[]')",
    ).bind(bundleId, builder.builderId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.commerce.bundles).toEqual([expect.objectContaining({ bundleId, name: 'Export Data Bundle' })]);
  });

  it('scopes every commerce list to the requesting builder only, never another builder\'s own', async () => {
    const builderA = await signupBuilder('export-data-commerce-scope-a');
    const builderB = await signupBuilder('export-data-commerce-scope-b');
    const bundleId = `bundle-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO bundles (bundle_id, builder_id, name, items_json) VALUES (?, ?, 'Builder B Bundle', '[]')",
    ).bind(bundleId, builderB.builderId).run();

    const resultA = await api('/auth/export-data', builderA.session());
    expect(resultA.body.commerce.bundles).toEqual([]);
  });
});
