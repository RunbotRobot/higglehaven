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

  // #2215 (owner decision, 2026-10-31, option 2): migrations/0131's own
  // UNIQUE(template_id, flagger_builder_id) stops one builder re-flagging
  // its own target, but does nothing against several distinct, cheaply-
  // created accounts flagging from the same device/network. Three distinct
  // builders still reach pendingCount 3 here, but two of them share an IP
  // (the real-world brigading shape -- one person, several throwaway
  // accounts, one device), so the signal-weighted sum stays at 2 and
  // auto-hide correctly never fires, unlike the threshold test just above
  // (3 genuinely distinct IPs) where it does.
  it('does not auto-hide when 3 distinct builders flag a listing but two of them share an IP (#2215)', async () => {
    const seller = await signupSeller('flag-weight-seller');
    await createTemplate('flag-weight-template', seller);
    const flaggers = await Promise.all([1, 2, 3].map((n) => signupBuilder(`flag-weight-flagger-${n}`)));
    const sharedIp = `test-shared-ip-${crypto.randomUUID()}`;

    const first = await api('/catalog/flag-weight-template/flags', flaggers[0].session({
      method: 'POST', body: JSON.stringify({}), headers: { 'cf-connecting-ip': sharedIp },
    }));
    expect(first.body.pendingCount).toBe(1);
    expect(first.body.pendingWeight).toBe(1);

    // Same IP as the first flagger -- a real distinct account, but counts
    // for nothing toward the weighted sum.
    const second = await api('/catalog/flag-weight-template/flags', flaggers[1].session({
      method: 'POST', body: JSON.stringify({}), headers: { 'cf-connecting-ip': sharedIp },
    }));
    expect(second.body.pendingCount).toBe(2);
    expect(second.body.pendingWeight).toBe(1);
    expect(second.body.autoHidden).toBe(false);

    // A genuinely different IP -- counts fully.
    const third = await api('/catalog/flag-weight-template/flags', flaggers[2].session({ method: 'POST', body: JSON.stringify({}) }));
    expect(third.body.pendingCount).toBe(3);
    expect(third.body.pendingWeight).toBe(2);
    expect(third.body.autoHidden).toBe(false);

    const fetched = await api('/catalog/flag-weight-template');
    expect(fetched.body.template.flaggedHiddenAt).toBeFalsy();
  });

  // The 'unknown' fallback clientIp() returns with no cf-connecting-ip
  // header is never a real device/network signal -- every caller with no
  // header would otherwise collide on that one literal string and get
  // zeroed out together. Two flags with no header must each weight 1, not
  // trip the same-IP zeroing the test above exercises.
  it('never zeroes out flags whose clientIp is the shared "unknown" fallback (#2215)', async () => {
    const seller = await signupSeller('flag-weight-unknown-seller');
    await createTemplate('flag-weight-unknown-template', seller);
    const flaggers = await Promise.all([1, 2].map((n) => signupBuilder(`flag-weight-unknown-flagger-${n}`)));

    const first = await api('/catalog/flag-weight-unknown-template/flags', flaggers[0].session({
      method: 'POST', body: JSON.stringify({}), headers: { 'cf-connecting-ip': '' },
    }));
    expect(first.body.pendingWeight).toBe(1);

    const second = await api('/catalog/flag-weight-unknown-template/flags', flaggers[1].session({
      method: 'POST', body: JSON.stringify({}), headers: { 'cf-connecting-ip': '' },
    }));
    expect(second.body.pendingCount).toBe(2);
    expect(second.body.pendingWeight).toBe(2);
  });

  // #2980: the weight decision used to be a separate pre-read SELECT
  // (computeProductFlagWeight) run before the INSERT, with no atomicity
  // tying the two together -- two flags from the same IP landing
  // concurrently could both see "no existing pending flag from this IP"
  // and both get weight 1, defeating the cap the test above already
  // covers for the *sequential* case. Deterministic version of that race,
  // same db.prepare monkey-patch idiom this codebase already uses for
  // this class of bug: intercepts right as the first flag's own INSERT is
  // about to run and drives a second, same-IP flag's entire create call
  // to completion first. Verified via git stash that this fails against
  // the pre-fix code (both flags land with weight 1) and passes against
  // the fix (the live EXISTS subquery inside the INSERT itself sees the
  // other flag's row no matter which one's statement actually runs last).
  it('never lets two same-IP flags race into both weighting 1', async () => {
    const seller = await signupSeller('flag-weight-race-seller');
    await createTemplate('flag-weight-race-template', seller);
    const flaggers = await Promise.all([1, 2].map((n) => signupBuilder(`flag-weight-race-flagger-${n}`)));
    const sharedIp = `test-race-ip-${crypto.randomUUID()}`;

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (armed && sql.includes('INSERT INTO product_flags')) {
        armed = false;
        const originalBind = stmt.bind.bind(stmt);
        stmt.bind = (...bindArgs) => {
          const bound = originalBind(...bindArgs);
          const originalRun = bound.run.bind(bound);
          bound.run = async () => {
            // The second flag's own full create call -- SELECT/EXISTS
            // check and INSERT alike -- commits here, in the gap between
            // the first flag's own (old code: already-stale) weight
            // decision and its INSERT actually running.
            await api('/catalog/flag-weight-race-template/flags', flaggers[1].session({
              method: 'POST', body: JSON.stringify({}), headers: { 'cf-connecting-ip': sharedIp },
            }));
            return originalRun();
          };
          return bound;
        };
      }
      return stmt;
    };
    let first;
    try {
      first = await api('/catalog/flag-weight-race-template/flags', flaggers[0].session({
        method: 'POST', body: JSON.stringify({}), headers: { 'cf-connecting-ip': sharedIp },
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(first.response.status).toBe(201);

    // Exactly one of the two same-IP flags may weight 1, regardless of
    // which one's own INSERT statement actually executed last.
    const rows = await env.DB.prepare(
      'SELECT weight FROM product_flags WHERE template_id = ? AND flagger_ip = ? ORDER BY weight DESC',
    ).bind('flag-weight-race-template', sharedIp).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map((r) => r.weight)).toEqual([1, 0]);
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

  // #2793: #2748/#2776 made every ordinary POST /catalog create back its
  // template with its own 1:1 products row, so template.product_id is now
  // set on practically every listing -- including this one, with no other
  // listing sharing it. The sibling-cascade's own DELETE FROM
  // placed_instances used to fire only for a genuinely shared product
  // (product_id used to be a reliable "has a sibling" proxy); approving a
  // flag on an ordinary, unshared listing must still only block future
  // purchases and leave an already-placed instance alone, exactly like
  // before #2749 ever existed.
  it('approve on an ordinary (unshared) listing blocks future purchases but does not delete its already-placed instance', async () => {
    const seller = await signupSeller('flag-approve-solo-seller');
    const builder = await signupBuilder('flag-approve-solo-owner');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId: 'flag-approve-solo-landlet', name: 'Flag approve solo landlet', areaM2: 1000, status: 'greenbelt' }),
    }));
    await api('/landlets/flag-approve-solo-landlet/claim', builder.session({ method: 'POST' }));
    await createTemplate('flag-approve-solo-template', seller);
    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'flag-approve-solo-instance', landletId: 'flag-approve-solo-landlet', templateId: 'flag-approve-solo-template', x: 0, y: 0 }),
    }));
    expect(placed.response.status).toBe(201);

    const flagger = await signupBuilder('flag-approve-solo-flagger');
    await api('/catalog/flag-approve-solo-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
    const resolved = await api('/catalog/flag-approve-solo-template/flags/resolve', adminSession({
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }));
    expect(resolved.response.status).toBe(200);

    const blockedPurchase = await api('/instances/flag-approve-solo-instance/purchase', builder.session({ method: 'POST' }));
    expect(blockedPurchase.response.status).toBe(400);
    expect(blockedPurchase.body.error).toMatch(/temporarily unavailable pending review/);

    const { results: stillPlaced } = await env.DB.prepare('SELECT instance_id FROM placed_instances WHERE instance_id = ?')
      .bind('flag-approve-solo-instance').all();
    expect(stillPlaced.length).toBe(1);
  });

  it('reject: resolves all pending flags, restores purchasability, does not strike the seller', async () => {
    const seller = await signupSeller('flag-reject-seller');
    const builder = await signupAdmin('flag-reject-owner');
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

    // #2793: the approve cascade's sibling-deletion branch is now gated on
    // an actual sibling existing (more than one catalog_templates row
    // sharing product_id), not just `template.product_id` being set --
    // this template has no sibling, so placed_instances is left alone and
    // the purchase is blocked by flaggedHiddenAt (400), not a deleted
    // instance (404). (A brief window after #2748/#2776 landed and before
    // #2793's fix, product_id alone was enough to trigger the DELETE here
    // too -- that was the bug #2793 fixed, not the behavior to test for.)
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

    // Same reasoning as hiddenAfterApprove above -- still just flaggedHiddenAt-
    // blocked, and the later reject doesn't clear that either.
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

    // #2468: nothing blocks a brand-new flag batch from landing on a listing
    // that's already been approve-removed -- resolving that later batch must
    // not strike the seller again for what's really the same violation
    // resurfacing, or three repeat approvals of one original violation could
    // walk the seller all the way to permanent removal.
    it('a second flag batch approved against an already-approved listing does not strike the seller again', async () => {
      // A dedicated admin, not the file-shared `adminSession` -- this test's
      // own 2 resolve calls would otherwise eat into the shared admin's
      // product-flag-resolve rate-limit budget that later tests in this
      // file depend on.
      const admin = await signupAdmin('strike-ladder-repeat-admin');
      const seller = await signupSeller('strike-ladder-repeat-seller');
      const ownerBuilderId = (await api('/builders/me', seller.session())).body.builder.builderId;
      await createTemplate('strike-ladder-repeat-1', seller);

      const flagger1 = await signupBuilder('sl-repeat-flagger-1');
      await api('/catalog/strike-ladder-repeat-1/flags', flagger1.session({ method: 'POST', body: JSON.stringify({}) }));
      const firstResolve = await api('/catalog/strike-ladder-repeat-1/flags/resolve', admin.session({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }));
      expect(firstResolve.response.status).toBe(200);

      const userId = await sellerUserId(seller);
      expect((await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first()).strike_count).toBe(1);
      expect(await activeSuspension(userId)).toBeFalsy();

      // Nothing blocks a fresh flag against a listing that's already hidden
      // -- a second, independent builder files a new one.
      const flagger2 = await signupBuilder('sl-repeat-flagger-2');
      const secondFlag = await api('/catalog/strike-ladder-repeat-1/flags', flagger2.session({ method: 'POST', body: JSON.stringify({}) }));
      expect(secondFlag.response.status).toBe(201);
      const secondResolve = await api('/catalog/strike-ladder-repeat-1/flags/resolve', admin.session({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }));
      expect(secondResolve.response.status).toBe(200);

      // Still 1 -- the repeat approval didn't add a second strike.
      const sellerRow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
      expect(sellerRow.strike_count).toBe(1);
      // A real 2nd strike would suspend for 7 days -- confirming none fired.
      expect(await activeSuspension(userId)).toBeFalsy();

      const { results: notifications } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
        .bind(ownerBuilderId).all();
      expect(notifications.filter((n) => /strike was added/i.test(n.message)).length).toBe(1);
    });
  });

  // #2749 (leaf of #2745): migrations/0153 lets more than one seller's own
  // listing share one `products` row, but #2747 (the listing-creation
  // endpoint that would actually write product_id) hasn't shipped yet --
  // same direct-D1-linking approach worker/shared-products-schema.test.js's
  // own fixtures already use to test #2746 in isolation.
  describe('Shared-product moderation cascade (#2749)', () => {
    async function createProduct(productId, overrides = {}) {
      await env.DB.prepare(`
        INSERT INTO products (product_id, name, category, color, width_m, depth_m, height_m)
        VALUES (?, ?, ?, ?, 1, 1, 1)
      `).bind(
        productId,
        overrides.name ?? `Shared product ${productId}`,
        overrides.category ?? 'furniture',
        overrides.color ?? '#123456',
      ).run();
    }

    async function linkToProduct(templateId, productId) {
      await env.DB.prepare('UPDATE catalog_templates SET product_id = ? WHERE template_id = ?')
        .bind(productId, templateId).run();
    }

    it('approving a flag on one listing of a shared product hides every sibling listing and the product, and removes every placed instance across every landlet -- without striking sibling sellers', async () => {
      const sellerA = await signupSeller('cascade-seller-a');
      const sellerB = await signupSeller('cascade-seller-b');
      // Two different builders -- #799/#952's one-claimed-landlet-per-
      // builder invariant means a single builder can't claim both landlets
      // this test needs to prove the cascade deletes placed instances
      // across different landlets, not just within one.
      const builderA = await signupBuilder('cascade-builder-a');
      const builderB = await signupBuilder('cascade-builder-b');

      await createTemplate('cascade-listing-a', sellerA);
      await createTemplate('cascade-listing-b', sellerB);
      await createProduct('cascade-product-1');
      await linkToProduct('cascade-listing-a', 'cascade-product-1');
      await linkToProduct('cascade-listing-b', 'cascade-product-1');

      await api('/landlets', adminSession({
        method: 'POST',
        body: JSON.stringify({ landletId: 'cascade-landlet-a', name: 'Cascade landlet A', areaM2: 1000, status: 'greenbelt' }),
      }));
      await api('/landlets', adminSession({
        method: 'POST',
        body: JSON.stringify({ landletId: 'cascade-landlet-b', name: 'Cascade landlet B', areaM2: 1000, status: 'greenbelt' }),
      }));
      await api('/landlets/cascade-landlet-a/claim', builderA.session({ method: 'POST' }));
      await api('/landlets/cascade-landlet-b/claim', builderB.session({ method: 'POST' }));
      const placedA = await api('/instances', builderA.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: 'cascade-instance-a', landletId: 'cascade-landlet-a', templateId: 'cascade-listing-a', x: 0, y: 0 }),
      }));
      const placedB = await api('/instances', builderB.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: 'cascade-instance-b', landletId: 'cascade-landlet-b', templateId: 'cascade-listing-b', x: 0, y: 0 }),
      }));
      expect(placedA.response.status).toBe(201);
      expect(placedB.response.status).toBe(201);

      const flagger = await signupBuilder('cascade-flagger');
      await api('/catalog/cascade-listing-a/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));

      const resolved = await api('/catalog/cascade-listing-a/flags/resolve', adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }));
      expect(resolved.response.status).toBe(200);

      const listingA = await api('/catalog/cascade-listing-a');
      const listingB = await api('/catalog/cascade-listing-b');
      expect(listingA.body.template.flaggedHiddenAt).toBeTruthy();
      expect(listingB.body.template.flaggedHiddenAt).toBeTruthy();

      const product = await env.DB.prepare('SELECT flagged_hidden_at FROM products WHERE product_id = ?')
        .bind('cascade-product-1').first();
      expect(product.flagged_hidden_at).toBeTruthy();

      const { results: instances } = await env.DB.prepare(
        'SELECT instance_id FROM placed_instances WHERE instance_id IN (?, ?)',
      ).bind('cascade-instance-a', 'cascade-instance-b').all();
      expect(instances.length).toBe(0);

      // Only the listing the flags actually landed on strikes its own
      // seller -- the sibling seller's listing is cascade-hidden, but that
      // seller did nothing wrong, so no strike for them.
      const sellerARow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?').bind(sellerA.sellerId).first();
      expect(sellerARow.strike_count).toBe(1);
      const sellerBRow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?').bind(sellerB.sellerId).first();
      expect(sellerBRow.strike_count).toBe(0);

      const ownerBuilderB = await api('/builders/me', sellerB.session());
      const { results: notificationsB } = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?')
        .bind(ownerBuilderB.body.builder.builderId).all();
      expect(notificationsB.some((n) => /removed from the catalog/i.test(n.message))).toBe(true);
      expect(notificationsB.some((n) => /strike/i.test(n.message))).toBe(false);
    });

    it('does not cascade anything when the flagged listing has no product_id (not a shared product) -- same behavior as before #2749', async () => {
      const seller = await signupSeller('cascade-none-seller');
      await createTemplate('cascade-none-template', seller);
      const flagger = await signupBuilder('cascade-none-flagger');
      await api('/catalog/cascade-none-template/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
      const resolved = await api('/catalog/cascade-none-template/flags/resolve', adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }));
      expect(resolved.response.status).toBe(200);
      const sellerRow = await env.DB.prepare('SELECT strike_count FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
      expect(sellerRow.strike_count).toBe(1);
    });

    // #2783: auto-hide (unlike approve, just above) used to never cascade to
    // products.flagged_hidden_at, so POST /api/catalog/listings -- which
    // only checks that column -- let a seller attach a brand-new listing to
    // a product that was already auto-hidden pending review, bypassing it
    // entirely with no admin involvement.
    it('auto-hiding one listing of a shared product also blocks a brand-new listing attach via POST /catalog/listings', async () => {
      const sellerA = await signupSeller('auto-hide-cascade-seller-a');
      const sellerB = await signupSeller('auto-hide-cascade-seller-b');
      await createTemplate('auto-hide-cascade-listing-a', sellerA);
      await createProduct('auto-hide-cascade-product-1');
      await linkToProduct('auto-hide-cascade-listing-a', 'auto-hide-cascade-product-1');

      const flaggers = await Promise.all([1, 2, 3].map((n) => signupBuilder(`auto-hide-cascade-flagger-${n}`)));
      let lastResult;
      for (const flagger of flaggers) {
        lastResult = await api('/catalog/auto-hide-cascade-listing-a/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
      }
      expect(lastResult.body.autoHidden).toBe(true);

      const product = await env.DB.prepare('SELECT flagged_hidden_at FROM products WHERE product_id = ?')
        .bind('auto-hide-cascade-product-1').first();
      expect(product.flagged_hidden_at).toBeTruthy();

      const attach = await api('/catalog/listings', sellerB.session({
        method: 'POST',
        body: JSON.stringify({ productId: 'auto-hide-cascade-product-1', priceCents: 500 }),
      }));
      expect(attach.response.status).toBe(400);
      expect(attach.body.error).toMatch(/temporarily unavailable pending review/);
    });

    // #2914: the reject branch above only ever cleared the one template's
    // own flagged_hidden_at -- #2783's auto-hide-sets-products.flagged_hidden_at
    // cascade (just above) had no corresponding clear anywhere, so rejecting
    // the flags that triggered it left the product permanently unattachable.
    it('rejecting the flags that triggered auto-hide also clears products.flagged_hidden_at, unblocking a new listing attach', async () => {
      const sellerA = await signupSeller('reject-clears-product-seller-a');
      const sellerB = await signupSeller('reject-clears-product-seller-b');
      await createTemplate('reject-clears-product-listing-a', sellerA);
      await createProduct('reject-clears-product-1');
      await linkToProduct('reject-clears-product-listing-a', 'reject-clears-product-1');

      const flaggers = await Promise.all([1, 2, 3].map((n) => signupBuilder(`reject-clears-product-flagger-${n}`)));
      let lastResult;
      for (const flagger of flaggers) {
        lastResult = await api('/catalog/reject-clears-product-listing-a/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
      }
      expect(lastResult.body.autoHidden).toBe(true);
      const hiddenProduct = await env.DB.prepare('SELECT flagged_hidden_at FROM products WHERE product_id = ?')
        .bind('reject-clears-product-1').first();
      expect(hiddenProduct.flagged_hidden_at).toBeTruthy();

      const resolved = await api('/catalog/reject-clears-product-listing-a/flags/resolve', adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'reject' }),
      }));
      expect(resolved.response.status).toBe(200);

      const product = await env.DB.prepare('SELECT flagged_hidden_at FROM products WHERE product_id = ?')
        .bind('reject-clears-product-1').first();
      expect(product.flagged_hidden_at).toBeNull();

      const attach = await api('/catalog/listings', sellerB.session({
        method: 'POST',
        body: JSON.stringify({ productId: 'reject-clears-product-1', priceCents: 500 }),
      }));
      expect(attach.response.status).toBe(201);
    });

    // The flip side of the test above: a reject on one listing must never
    // clear products.flagged_hidden_at if a SIBLING listing of the same
    // product already had its own flags approved -- that's a confirmed
    // removal of the whole product (the approve branch's own cascade,
    // tested above), and nothing about rejecting a different, unrelated
    // listing's flags should be able to undo it. Same "never undo an
    // approved removal" shape #2467 already established per-template.
    it('rejecting one listing\'s flags never undoes a sibling listing\'s own approved removal of the shared product', async () => {
      const sellerA = await signupSeller('reject-keeps-product-seller-a');
      const sellerB = await signupSeller('reject-keeps-product-seller-b');
      await createTemplate('reject-keeps-product-listing-a', sellerA);
      await createTemplate('reject-keeps-product-listing-b', sellerB);
      await createProduct('reject-keeps-product-1');
      await linkToProduct('reject-keeps-product-listing-a', 'reject-keeps-product-1');
      await linkToProduct('reject-keeps-product-listing-b', 'reject-keeps-product-1');

      // Auto-hide listing-a (its own flags stay pending -- never resolved
      // yet) without ever approving them.
      const flaggersA = await Promise.all([1, 2, 3].map((n) => signupBuilder(`reject-keeps-product-flagger-a-${n}`)));
      for (const flagger of flaggersA) {
        await api('/catalog/reject-keeps-product-listing-a/flags', flagger.session({ method: 'POST', body: JSON.stringify({}) }));
      }

      // Approve listing-b's own flags -- a confirmed removal that cascades
      // to the shared product (siblingCount > 1 here, listing-a and -b).
      const flaggerB = await signupBuilder('reject-keeps-product-flagger-b');
      await api('/catalog/reject-keeps-product-listing-b/flags', flaggerB.session({ method: 'POST', body: JSON.stringify({}) }));
      const approved = await api('/catalog/reject-keeps-product-listing-b/flags/resolve', adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }));
      expect(approved.response.status).toBe(200);
      const confirmedHidden = await env.DB.prepare('SELECT flagged_hidden_at FROM products WHERE product_id = ?')
        .bind('reject-keeps-product-1').first();
      expect(confirmedHidden.flagged_hidden_at).toBeTruthy();

      // Now reject listing-a's own (still-pending, never approved) flags.
      const rejected = await api('/catalog/reject-keeps-product-listing-a/flags/resolve', adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'reject' }),
      }));
      expect(rejected.response.status).toBe(200);

      // The product-level hide from listing-b's own confirmed removal must
      // survive -- it is never this unrelated rejection's call to undo.
      const product = await env.DB.prepare('SELECT flagged_hidden_at FROM products WHERE product_id = ?')
        .bind('reject-keeps-product-1').first();
      expect(product.flagged_hidden_at).toBeTruthy();
    });
  });

  // #2218 (owner decision, 2026-10-25): the seller's own Duplicate button
  // used to have no server-side check at all against the source listing
  // it copies from -- an admin's "approve" above only ever sets
  // flagged_hidden_at on the one listing being moderated, never anything
  // that stops a brand-new, unflagged copy from being created immediately
  // after. POST /catalog's own sourceTemplateId check (worker/lib/catalog.js)
  // is what closes it.
  describe('Blocking duplicate re-creation of a moderator-removed listing (#2218)', () => {
    async function approveAndHide(templateId) {
      const flaggerA = await signupBuilder(`${templateId}-flagger-a`);
      const flaggerB = await signupBuilder(`${templateId}-flagger-b`);
      await api(`/catalog/${templateId}/flags`, flaggerA.session({ method: 'POST', body: JSON.stringify({}) }));
      await api(`/catalog/${templateId}/flags`, flaggerB.session({ method: 'POST', body: JSON.stringify({}) }));
      const resolved = await api(`/catalog/${templateId}/flags/resolve`, adminSession({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }));
      expect(resolved.response.status).toBe(200);
      expect(resolved.body.resolvedStatus).toBe('approved');
    }

    it('rejects creating a new template with sourceTemplateId pointing at a moderator-removed listing', async () => {
      const seller = await signupSeller('dup-block-seller');
      await createTemplate('dup-block-source', seller);
      await approveAndHide('dup-block-source');

      const duplicate = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          name: 'Dup block source (copy)', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 500, sellerId: seller.sellerId, sourceTemplateId: 'dup-block-source',
        }),
      }));
      expect(duplicate.response.status).toBe(403);
      expect(duplicate.body.error).toMatch(/removed for a policy violation/);
    });

    it('allows creating a new template with sourceTemplateId pointing at a listing with no pending/approved flags', async () => {
      const seller = await signupSeller('dup-allow-seller');
      await createTemplate('dup-allow-source', seller);

      const duplicate = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          name: 'Dup allow source (copy)', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 500, sellerId: seller.sellerId, sourceTemplateId: 'dup-allow-source',
        }),
      }));
      expect(duplicate.response.status).toBe(201);
    });

    it('ignores a sourceTemplateId that does not reference any existing template', async () => {
      const seller = await signupSeller('dup-missing-source-seller');
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          name: 'No real source', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 500, sellerId: seller.sellerId, sourceTemplateId: 'template-does-not-exist',
        }),
      }));
      expect(created.response.status).toBe(201);
    });
  });
});
