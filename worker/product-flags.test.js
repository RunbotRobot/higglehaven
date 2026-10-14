import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller, signupAdmin } from './test-helpers.js';

// Shared across every test that needs an admin session (requireAdmin in
// worker/index.js) -- same per-file-shared-admin convention
// reviews-auth.test.js's own beforeAll already uses.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('flags-shared-admin');
  adminSession = admin.session;
});

describe('Counterfeit-flag endpoint and admin review queue (#2017)', () => {
  async function createTemplate(templateId, seller, overrides = {}) {
    const created = await api('/catalog', (seller ? seller.session : (options) => options)({
      method: 'POST',
      body: JSON.stringify({
        templateId,
        name: `Flaggable product ${templateId}`,
        color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 },
        priceCents: 500,
        sellerId: seller ? seller.sellerId : undefined,
        ...overrides,
      }),
    }));
    expect(created.response.status).toBe(201);
    return created.body.template;
  }

  it('requires a session to flag a listing', async () => {
    await createTemplate('flag-auth-template');
    const result = await api('/catalog/flag-auth-template/flags', { method: 'POST', body: JSON.stringify({}) });
    expect(result.response.status).toBe(401);
  });

  it('404s flagging a nonexistent template', async () => {
    const flagger = await signupBuilder('flag-404-builder');
    const result = await api('/catalog/does-not-exist/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(result.response.status).toBe(404);
  });

  it('records a flag and reports pendingCount, not yet auto-hidden', async () => {
    await createTemplate('flag-single-template');
    const flagger = await signupBuilder('flag-single-builder');
    const result = await api('/catalog/flag-single-template/flags', flagger.session({
      method: 'POST',
      body: JSON.stringify({ reason: 'Looks like a counterfeit' }),
    }));
    expect(result.response.status).toBe(201);
    expect(result.body.pendingCount).toBe(1);
    expect(result.body.autoHidden).toBe(false);
  });

  it('rejects a second flag from the same builder on the same listing', async () => {
    await createTemplate('flag-dup-template');
    const flagger = await signupBuilder('flag-dup-builder');
    await api('/catalog/flag-dup-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    const second = await api('/catalog/flag-dup-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(second.response.status).toBe(409);
  });

  // #1946 already established that hiding a flagged/test row from GET
  // /api/catalog breaks ordinary Build-mode placement for everyone -- this
  // feature deliberately never touches that endpoint, only purchase.
  it('auto-hides a listing (blocking new purchases, not browsing) once 3 distinct builders flag it, and notifies the seller (#2056)', async () => {
    const seller = await signupSeller('flag-threshold-seller');
    const builder = await signupBuilder('flag-threshold-owner');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId: 'flag-threshold-landlet', name: 'Flag threshold landlet', areaM2: 1000, status: 'greenbelt' }),
    }));
    await api('/landlets/flag-threshold-landlet/claim', builder.session({ method: 'POST' }));
    await createTemplate('flag-threshold-template', seller);
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'flag-threshold-instance', landletId: 'flag-threshold-landlet', templateId: 'flag-threshold-template', x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);

    const flaggers = await Promise.all([1, 2, 3].map((n) => signupBuilder(`flag-threshold-flagger-${n}`)));
    let lastResult;
    for (const flagger of flaggers) {
      lastResult = await api('/catalog/flag-threshold-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    }
    expect(lastResult.body.pendingCount).toBe(3);
    expect(lastResult.body.autoHidden).toBe(true);

    const purchase = await api('/instances/flag-threshold-instance/purchase', builder.session({ method: 'POST' }));
    expect(purchase.response.status).toBe(400);
    expect(purchase.body.error).toMatch(/temporarily unavailable pending review/);

    const fetched = await api('/catalog/flag-threshold-template');
    expect(fetched.response.status).toBe(200);
    expect(fetched.body.template.flaggedHiddenAt).toBeTruthy();

    const ownerBuilder = await api('/builders/me', seller.session());
    const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
      .bind(ownerBuilder.body.builder.builderId).all();
    expect(notifications.some((n) => /automatically hidden/i.test(n.message))).toBe(true);
  });

  it('does not notify the seller on a flag that does not cross the auto-hide threshold', async () => {
    const seller = await signupSeller('flag-no-notify-seller');
    await createTemplate('flag-no-notify-template', seller);
    const flagger = await signupBuilder('flag-no-notify-flagger');
    const result = await api('/catalog/flag-no-notify-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(result.body.autoHidden).toBe(false);

    const ownerBuilder = await api('/builders/me', seller.session());
    const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
      .bind(ownerBuilder.body.builder.builderId).all();
    expect(notifications.some((n) => /automatically hidden/i.test(n.message))).toBe(false);
  });

  it('rejects a non-admin resolving flags', async () => {
    await createTemplate('flag-resolve-auth-template');
    const flagger = await signupBuilder('flag-resolve-auth-flagger');
    await api('/catalog/flag-resolve-auth-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    const nonAdmin = await signupBuilder('flag-resolve-auth-nonadmin');
    const result = await api('/catalog/flag-resolve-auth-template/flags/resolve', nonAdmin.session({
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }));
    expect(result.response.status).toBe(403);
  });

  it('400s resolving a listing with no pending flags', async () => {
    await createTemplate('flag-resolve-empty-template');
    const result = await api('/catalog/flag-resolve-empty-template/flags/resolve', adminSession({
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }));
    expect(result.response.status).toBe(400);
  });

  it('approve: resolves all pending flags, keeps the listing hidden, strikes the seller, and notifies them', async () => {
    const seller = await signupSeller('flag-approve-seller');
    await createTemplate('flag-approve-template', seller);
    const flaggerA = await signupBuilder('flag-approve-flagger-a');
    const flaggerB = await signupBuilder('flag-approve-flagger-b');
    await api('/catalog/flag-approve-template/flags', flaggerA.session({ method: 'POST', body: JSON.stringify({}) }));
    await api('/catalog/flag-approve-template/flags', flaggerB.session({ method: 'POST', body: JSON.stringify({}) }));

    const resolved = await api('/catalog/flag-approve-template/flags/resolve', adminSession({
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }));
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.resolvedStatus).toBe('approved');
    expect(resolved.body.flagsResolved).toBe(2);

    const { results: flags } = await env.DB.prepare('SELECT status FROM product_flags WHERE template_id = ?')
      .bind('flag-approve-template').all();
    expect(flags.length).toBe(2);
    expect(flags.every((f) => f.status === 'approved')).toBe(true);

    const sellerRow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(sellerRow.strike_count).toBe(1);

    const fetched = await api('/catalog/flag-approve-template');
    expect(fetched.body.template.flaggedHiddenAt).toBeTruthy();

    const ownerBuilder = await api('/builders/me', seller.session());
    const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
      .bind(ownerBuilder.body.builder.builderId).all();
    expect(notifications.some((n) => /strike/i.test(n.message))).toBe(true);

    const { results: logEntries } = await env.DB.prepare(
      "SELECT * FROM admin_action_log WHERE target_id = ? AND action_type = 'approved_product_flags'",
    ).bind('flag-approve-template').all();
    expect(logEntries.length).toBe(1);
  });

  it('reject: resolves all pending flags, restores purchasability, does not strike the seller', async () => {
    const seller = await signupSeller('flag-reject-seller');
    const builder = await signupBuilder('flag-reject-owner');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId: 'flag-reject-landlet', name: 'Flag reject landlet', areaM2: 1000, status: 'greenbelt' }),
    }));
    await api('/landlets/flag-reject-landlet/claim', builder.session({ method: 'POST' }));
    await createTemplate('flag-reject-template', seller);
    await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'flag-reject-instance', landletId: 'flag-reject-landlet', templateId: 'flag-reject-template', x: 0, y: 0 }),
    }));
    const flaggers = await Promise.all([1, 2, 3].map((n) => signupBuilder(`flag-reject-flagger-${n}`)));
    for (const flagger of flaggers) {
      await api('/catalog/flag-reject-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    }
    // Confirm auto-hide actually fired before testing that reject reverses it.
    const hiddenPurchase = await api('/instances/flag-reject-instance/purchase', builder.session({ method: 'POST' }));
    expect(hiddenPurchase.response.status).toBe(400);

    const resolved = await api('/catalog/flag-reject-template/flags/resolve', adminSession({
      method: 'POST',
      body: JSON.stringify({ action: 'reject' }),
    }));
    expect(resolved.response.status).toBe(200);
    expect(resolved.body.resolvedStatus).toBe('rejected');

    const sellerRow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?')
      .bind(seller.sellerId).first();
    expect(sellerRow.strike_count).toBe(0);

    const allowedPurchase = await api('/instances/flag-reject-instance/purchase', builder.session({ method: 'POST' }));
    expect(allowedPurchase.response.status).toBe(201);
  });

  it('lists pending-flag listings for an admin, grouped per template, 403s a non-admin', async () => {
    await createTemplate('flag-list-template');
    const flagger = await signupBuilder('flag-list-flagger');
    await api('/catalog/flag-list-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({ reason: 'test' }) }));

    const nonAdmin = await signupBuilder('flag-list-nonadmin');
    const rejected = await api('/product-flags', nonAdmin.session());
    expect(rejected.response.status).toBe(403);

    const listed = await api('/product-flags', adminSession());
    expect(listed.response.status).toBe(200);
    const hit = listed.body.listings.find((l) => l.templateId === 'flag-list-template');
    expect(hit).toBeTruthy();
    expect(hit.pendingCount).toBe(1);
  });
});
