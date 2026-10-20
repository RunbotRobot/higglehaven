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

  // #2467: reject's own UPDATE used to clear flagged_hidden_at unconditionally
  // -- including when an *earlier* flag batch on the same listing had already
  // been approved (a permanent hide, per the approve branch's own comment).
  // A second, unrelated flag reaching the queue and getting rejected would
  // silently un-hide a confirmed-counterfeit listing with no record it had
  // ever been incorrectly restored.
  it('reject on a fresh flag does not undo an earlier approve\'s permanent hide', async () => {
    const seller = await signupSeller('flag-reapprove-seller');
    const builder = await signupBuilder('flag-reapprove-owner');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId: 'flag-reapprove-landlet', name: 'Flag reapprove landlet', areaM2: 1000, status: 'greenbelt' }),
    }));
    await api('/landlets/flag-reapprove-landlet/claim', builder.session({ method: 'POST' }));
    await createTemplate('flag-reapprove-template', seller);
    await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'flag-reapprove-instance', landletId: 'flag-reapprove-landlet', templateId: 'flag-reapprove-template', x: 0, y: 0 }),
    }));

    const firstFlaggers = await Promise.all([1, 2].map((n) => signupBuilder(`flag-reapprove-flagger-${n}`)));
    for (const flagger of firstFlaggers) {
      await api('/catalog/flag-reapprove-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    }
    const approved = await api('/catalog/flag-reapprove-template/flags/resolve', adminSession({
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }));
    expect(approved.response.status).toBe(200);
    expect(approved.body.resolvedStatus).toBe('approved');

    const hiddenAfterApprove = await api('/instances/flag-reapprove-instance/purchase', builder.session({ method: 'POST' }));
    expect(hiddenAfterApprove.response.status).toBe(400);

    // A new, unrelated flag reaches the queue after the listing is already
    // permanently hidden -- the POST branch has no already-hidden guard, so
    // this succeeds and puts the listing back in the pending-review queue.
    const laterFlagger = await signupBuilder('flag-reapprove-later-flagger');
    const laterFlag = await api('/catalog/flag-reapprove-template/flags', laterFlagger.session({
      method: 'POST', body: JSON.stringify({ reason: 'unrelated, weak report' }),
    }));
    expect(laterFlag.response.status).toBe(201);

    const rejected = await api('/catalog/flag-reapprove-template/flags/resolve', adminSession({
      method: 'POST',
      body: JSON.stringify({ action: 'reject' }),
    }));
    expect(rejected.response.status).toBe(200);
    expect(rejected.body.resolvedStatus).toBe('rejected');
    expect(rejected.body.flagsResolved).toBe(1); // only the later, still-pending flag -- the approved pair is untouched

    const fetched = await api('/catalog/flag-reapprove-template');
    expect(fetched.body.template.flaggedHiddenAt).toBeTruthy();

    const stillBlockedPurchase = await api('/instances/flag-reapprove-instance/purchase', builder.session({ method: 'POST' }));
    expect(stillBlockedPurchase.response.status).toBe(400);
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
    // #2110: totalCount counts every pending-flagged template, not just the
    // capped page -- distinct from listings.length once the list is ever
    // actually truncated, but even here it must be at least 1 (this test's
    // own flagged template).
    expect(listed.body.totalCount).toBeGreaterThanOrEqual(1);
  });

  // #2018: the strike ladder consequence an approved flag triggers --
  // warning -> 7-day suspension -> permanent (365-day) suspension/
  // escalation, or straight to permanent on a single `severe` violation.
  describe('Strike ladder (#2018)', () => {
    // Once a seller's own account is suspended, their own session can no
    // longer create a new catalog template (every sellerId-owning create
    // requires an unsuspended session) -- so every template this ladder
    // will flag across a multi-violation test must exist *before* the
    // first resolve that could suspend its creator, not be created lazily
    // violation-by-violation.
    async function approveFlag(templateId, { severe } = {}) {
      // username caps at 40 chars (usernameValue) -- strip the common
      // "strike-ladder-" prefix so a flagger label built from a longer
      // templateId (e.g. the dangling-seller fixture's) doesn't exceed it.
      const flagger = await signupBuilder(`sl-flagger-${templateId.replace('strike-ladder-', '')}`);
      await api(`/catalog/${templateId}/flags`, flagger.session({ method: 'POST', body: JSON.stringify({}) }));
      const resolved = await api(`/catalog/${templateId}/flags/resolve`, adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'approve', ...(severe !== undefined ? { severe } : {}) }),
      }));
      expect(resolved.response.status).toBe(200);
    }

    async function sellerUserId(seller) {
      const row = await env.DB.prepare('SELECT user_id FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
      return row.user_id;
    }

    async function activeSuspension(userId) {
      return env.DB.prepare(
        'SELECT * FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL',
      ).bind(userId).first();
    }

    it('1st violation is a warning only -- no suspension', async () => {
      const seller = await signupSeller('strike-ladder-warn-seller');
      // Captured before any resolve, which (from this point on) could
      // suspend this account and make /builders/me start 403ing for it.
      const ownerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
      await createTemplate('strike-ladder-warn-1', seller);
      await approveFlag('strike-ladder-warn-1');

      const userId = await sellerUserId(seller);
      expect(await activeSuspension(userId)).toBeFalsy();

      const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
        .bind(ownerBuilderId).all();
      expect(notifications.some((n) => /warning/i.test(n.message))).toBe(true);
    });

    it('2nd violation suspends the account for 7 days', async () => {
      const seller = await signupSeller('strike-ladder-temp-seller');
      const ownerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
      await createTemplate('strike-ladder-temp-1', seller);
      await createTemplate('strike-ladder-temp-2', seller);
      await approveFlag('strike-ladder-temp-1');
      await approveFlag('strike-ladder-temp-2');

      const userId = await sellerUserId(seller);
      const suspension = await activeSuspension(userId);
      expect(suspension).toBeTruthy();
      const daysUntilGrace = (new Date(suspension.grace_period_ends_at) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilGrace).toBeGreaterThan(6.9);
      expect(daysUntilGrace).toBeLessThan(7.1);

      const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
        .bind(ownerBuilderId).all();
      expect(notifications.some((n) => /temporarily suspended/i.test(n.message))).toBe(true);
    });

    it('3rd violation escalates the existing suspension to permanent (365 days), logging escalate_suspension', async () => {
      const seller = await signupSeller('strike-ladder-perm-seller');
      const ownerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
      // All three templates created up front, before any resolve.
      await createTemplate('strike-ladder-perm-1', seller);
      await createTemplate('strike-ladder-perm-2', seller);
      await createTemplate('strike-ladder-perm-3', seller);
      await approveFlag('strike-ladder-perm-1');
      await approveFlag('strike-ladder-perm-2');
      const userId = await sellerUserId(seller);
      const sevenDaySuspension = await activeSuspension(userId);
      const sevenDaySuspensionId = sevenDaySuspension.suspension_id;

      await approveFlag('strike-ladder-perm-3');

      const escalated = await activeSuspension(userId);
      // Same row, escalated in place -- not a second, conflicting suspension.
      expect(escalated.suspension_id).toBe(sevenDaySuspensionId);
      const daysUntilGrace = (new Date(escalated.grace_period_ends_at) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilGrace).toBeGreaterThan(364.9);
      expect(daysUntilGrace).toBeLessThan(365.1);

      const { results: logEntries } = await env.DB.prepare(
        "SELECT * FROM admin_action_log WHERE target_id = ? AND action_type = 'escalate_suspension'",
      ).bind(userId).all();
      expect(logEntries.length).toBe(1);

      const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
        .bind(ownerBuilderId).all();
      expect(notifications.some((n) => /suspended indefinitely/i.test(n.message))).toBe(true);
    });

    it('a single severe violation skips straight to permanent, even as the seller\'s 1st strike', async () => {
      const seller = await signupSeller('strike-ladder-severe-seller');
      await createTemplate('strike-ladder-severe-1', seller);
      await approveFlag('strike-ladder-severe-1', { severe: true });

      const userId = await sellerUserId(seller);
      const suspension = await activeSuspension(userId);
      expect(suspension).toBeTruthy();
      const daysUntilGrace = (new Date(suspension.grace_period_ends_at) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilGrace).toBeGreaterThan(364.9);
      expect(daysUntilGrace).toBeLessThan(365.1);
    });

    it('a dangling seller (no linked user_id) gets no suspension attempt, and the resolve call still succeeds', async () => {
      // Direct inserts, not the API -- POST /catalog with a sellerId
      // requires an authenticated session owning that seller, which a
      // legacy/dangling (no user_id) seller row can never have.
      const danglingSellerId = 'strike-ladder-dangling-seller';
      await env.DB.prepare("INSERT INTO sellers (seller_id, label) VALUES (?, 'Dangling Seller')").bind(danglingSellerId).run();
      await env.DB.prepare(`
        INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, price_cents, seller_id)
        VALUES ('strike-ladder-dangling-template', 'Dangling seller product', 'furniture', '#123456', 1, 1, 1, 500, ?)
      `).bind(danglingSellerId).run();

      await approveFlag('strike-ladder-dangling-template');

      const sellerRow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?').bind(danglingSellerId).first();
      expect(sellerRow.strike_count).toBe(1);
    });
  });
});
