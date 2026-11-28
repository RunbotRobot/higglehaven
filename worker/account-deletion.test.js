// #1146 (sub-issue of #1145, owner decision via Control Room 2026-10-01):
// POST /api/auth/delete-account, the users-row half of real full account
// deletion -- revoke login, free the email/username for a future signup,
// sign out every device. #1148 (owner decision via Control Room,
// 2026-10-16) settled the rest: this now also cascades into deleting the
// user's own builder/seller row(s), inheriting their existing real-money
// guards, and BLOCKS the whole deletion (not a partial one) if either
// guard trips -- see worker/index.js's own cascadeDeleteAccount comment.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, signup, signupBuilder, signupSeller, signupAdmin, withSession,
  createGreenbeltLandletAs,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}

// Same technique as profiles.test.js's own fundHiggles -- a fresh
// signupBuilder() starts at 0 higgles, so a test placing a real bid funds
// its bidder first.
function fundHiggles(builder, amountCents = 100_000_000) {
  return env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
    .bind(amountCents, builder.builderId).run();
}

// Every signup*() helper in test-helpers.js uses this same fixed password.
const TEST_PASSWORD = 'a fine long password here';

describe('Account deletion (#1146)', () => {
  describe('POST /auth/delete-account', () => {
    it('requires a session', async () => {
      const anon = await api('/auth/delete-account', {
        method: 'POST',
        body: JSON.stringify({ password: 'whatever' }),
      });
      expect(anon.response.status).toBe(401);
    });

    it('rejects an incorrect password and leaves the account untouched', async () => {
      const account = await signupBuilder('delete-wrong-password');
      const attempt = await api('/auth/delete-account', account.session({
        method: 'POST',
        body: JSON.stringify({ password: 'definitely not it' }),
      }));
      expect(attempt.response.status).toBe(401);

      const me = await api('/auth/me', account.session());
      expect(me.body.user).not.toBeNull();
      expect(me.body.user.email).toBe(account.email);
    });

    it('revokes login, frees the email/username, and signs out every device', async () => {
      const password = 'a fine long password here';
      const email = `delete-me-${crypto.randomUUID()}@example.com`;
      const username = `delete-me-${crypto.randomUUID().slice(0, 8)}`;
      const signedUp = await signup(email, password, { username });
      const sessionA = extractSessionCookie(signedUp.response);

      // A second device/tab, so the test can confirm deletion signs out
      // every session for the account, not just the one that called it.
      const login = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const sessionB = extractSessionCookie(login.response);

      const deletion = await api('/auth/delete-account', withSession(sessionA, {
        method: 'POST',
        body: JSON.stringify({ password }),
      }));
      expect(deletion.response.status).toBe(200);
      expect(deletion.body.accountDeleted).toBe(true);

      // Both sessions are gone, not just the one used to delete.
      const meA = await api('/auth/me', withSession(sessionA));
      expect(meA.body.user).toBeNull();
      const meB = await api('/auth/me', withSession(sessionB));
      expect(meB.body.user).toBeNull();

      // The original email/password can no longer log in at all -- the
      // row backing them is gone (rewritten), not just password-rejected.
      const reLogin = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      expect(reLogin.response.status).toBe(401);

      // The freed email/username can be used for a brand-new signup.
      const resignup = await signup(email, 'a totally different password', { username });
      expect(resignup.response.status).toBe(201);
    });
  });

  // #4636: the address copies on a deleted buyer's orders go once they have no job left; an order still to be shipped
  // keeps its copy so the seller can send it.
  it('clears the address on a deleted buyer\'s shipped and refunded orders, and keeps it on one still to be shipped', async () => {
    const host = await signupBuilder('del-address-host');
    const password = 'a fine long password here';
    const email = `del-address-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, password, { username: `deladdr${crypto.randomUUID().slice(0, 8)}` });
    const session = extractSessionCookie(signedUp.response);
    const userId = (await api('/auth/me', withSession(session))).body.user.userId;
    const address = JSON.stringify({ name: 'A', line1: '1 St', city: 'X', region: 'OR', postalCode: '97201', country: 'US' });
    const stamp = new Date().toISOString();
    const insert = (id, shipped, refunded) => env.DB.prepare(`
      INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, buyer_user_id, unit_price_cents, quantity,
        total_cents, commission_cents, builder_share_cents, platform_share_cents, shipping_address_json, shipped_at, refunded_at)
      VALUES (?, 'i', 't', ?, ?, 500, 1, 500, 10, 5, 5, ?, ?, ?)
    `).bind(id, host.builderId, userId, address, shipped, refunded).run();
    await insert('del-addr-shipped', stamp, null);
    await insert('del-addr-refunded', null, stamp);
    await insert('del-addr-open', null, null);

    const deletion = await api('/auth/delete-account', withSession(session, { method: 'POST', body: JSON.stringify({ password }) }));
    expect(deletion.response.status).toBe(200);

    const addressOf = async (id) => (await env.DB.prepare('SELECT shipping_address_json AS a FROM purchases WHERE purchase_id = ?').bind(id).first()).a;
    expect(await addressOf('del-addr-shipped')).toBeNull();
    expect(await addressOf('del-addr-refunded')).toBeNull();
    expect(await addressOf('del-addr-open')).toBe(address);
  });

  // #4266: bug reports outlive the account only as a description, with no
  // account link, device details or screenshot.
  it('detaches the person from their bug reports and deletes the screenshots', async () => {
    const account = await signup(`bug-${crypto.randomUUID()}@example.com`, TEST_PASSWORD, { username: `bug-${crypto.randomUUID().slice(0, 8)}` });
    const sessionA = extractSessionCookie(account.response);
    const userId = account.body.user.userId;
    const other = await signup(`bug-${crypto.randomUUID()}@example.com`, TEST_PASSWORD, { username: `bug-${crypto.randomUUID().slice(0, 8)}` });
    const otherId = other.body.user.userId;
    const mine = `r-${crypto.randomUUID()}`;
    const theirs = `r-${crypto.randomUUID()}`;
    for (const [id, owner] of [[mine, userId], [theirs, otherId]]) {
      await env.DB.prepare(`
        INSERT INTO bug_reports (report_id, user_id, screenshot_url, description, user_agent, platform, render_state_buffer_json)
        VALUES (?, ?, ?, 'it flickers', 'UA', 'Linux', '[]')
      `).bind(id, owner, `/api/feedback/bug-reports/${id}/screenshot`).run();
      await env.FEEDBACK.put(`bug-reports/${id}.png`, new Uint8Array([1, 2, 3]));
    }

    const deletion = await api('/auth/delete-account', withSession(sessionA, {
      method: 'POST',
      body: JSON.stringify({ password: TEST_PASSWORD }),
    }));
    expect(deletion.response.status).toBe(200);

    const gone = await env.DB.prepare('SELECT * FROM bug_reports WHERE report_id = ?').bind(mine).first();
    expect(gone.description).toBe('it flickers');
    expect([gone.user_id, gone.user_agent, gone.platform, gone.render_state_buffer_json, gone.screenshot_url]).toEqual([null, null, null, null, null]);
    expect(await env.FEEDBACK.get(`bug-reports/${mine}.png`)).toBeNull();

    const kept = await env.DB.prepare('SELECT * FROM bug_reports WHERE report_id = ?').bind(theirs).first();
    expect([kept.user_id, kept.user_agent, kept.screenshot_url !== null]).toEqual([otherId, 'UA', true]);
    expect(await env.FEEDBACK.get(`bug-reports/${theirs}.png`)).not.toBeNull();
  });

  // #1148 (owner decision via Control Room, 2026-10-16): real account
  // deletion also deletes the user's own builder/seller row(s), reusing
  // the exact same real-money guards DELETE /api/builders/:id and
  // DELETE /api/sellers/:id already have.
  describe('Cascades into builder/seller deletion (#1148)', () => {
    it('deletes the account\'s own builder row and releases any landlet it owned', async () => {
      const account = await signupBuilder('delete-account-cascade-builder');
      await createGreenbeltLandlet('delete-account-cascade-landlet');
      await api('/landlets/delete-account-cascade-landlet/claim', account.session({ method: 'POST' }));

      const deletion = await api('/auth/delete-account', account.session({
        method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }),
      }));
      expect(deletion.response.status).toBe(200);

      const builderRow = await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?')
        .bind(account.builderId).first();
      expect(builderRow).toBeFalsy();

      const landlet = await api('/landlets/delete-account-cascade-landlet');
      expect(landlet.body.landlet.status).toBe('greenbelt');
      expect(landlet.body.landlet.ownerBuilderId).toBeNull();
    });

    it('deletes the account\'s own seller row', async () => {
      const account = await signupSeller('delete-account-cascade-seller');

      const deletion = await api('/auth/delete-account', account.session({
        method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }),
      }));
      expect(deletion.response.status).toBe(200);

      const sellerRow = await env.DB.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?')
        .bind(account.sellerId).first();
      expect(sellerRow).toBeFalsy();
    });

    // Same #263 shape as DELETE /api/builders/:id's own test -- the whole
    // point of this guard is that nothing here is left any less protected
    // just because it's reached through full account deletion instead.
    it('blocks the whole account deletion when the builder holds the leading bid on an active auction, leaving everything untouched', async () => {
      const seller = await signupBuilder('delete-account-leading-bid-seller');
      const bidder = await signupBuilder('delete-account-leading-bid-bidder');
      await fundHiggles(bidder);
      await createGreenbeltLandlet('delete-account-leading-bid-landlet');
      await api('/landlets/delete-account-leading-bid-landlet/claim', seller.session({ method: 'POST' }));
      const started = await api('/landlets/delete-account-leading-bid-landlet/auction', seller.session({
        method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
      }));
      const auctionId = started.body.auction.auctionId;
      await api(`/auctions/${auctionId}/bids`, bidder.session({
        method: 'POST', body: JSON.stringify({ amountCents: 500 }),
      }));

      const deletion = await api('/auth/delete-account', bidder.session({
        method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }),
      }));
      expect(deletion.response.status).toBe(409);
      expect(deletion.body).toEqual({
        error: 'Cannot delete your account while holding the leading bid on an active auction',
      });

      // Nothing was touched -- the bid, the builder row, and the login
      // session all still exist, exactly as if the request never happened.
      const bids = await api(`/auctions/${auctionId}/bids`);
      expect(bids.body.bids).toHaveLength(1);
      const builderRow = await env.DB.prepare('SELECT builder_id FROM builders WHERE builder_id = ?')
        .bind(bidder.builderId).first();
      expect(builderRow).toBeTruthy();
      const me = await api('/auth/me', bidder.session());
      expect(me.body.user).not.toBeNull();
      expect(me.body.user.email).toBe(bidder.email);
    });

    // Same #732 shape as DELETE /api/sellers/:id's own test.
    it('blocks the whole account deletion when the seller has an unpaid real-money purchase, leaving everything untouched', async () => {
      const seller = await signupSeller('delete-account-unpaid-payout-seller');
      const builder = await signupAdmin('delete-account-unpaid-payout-builder');
      await createGreenbeltLandlet('delete-account-unpaid-payout-landlet');
      await api('/landlets/delete-account-unpaid-payout-landlet/claim', builder.session({ method: 'POST' }));
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'delete-account-unpaid-payout-template',
          name: 'Product with an unpaid real-money sale',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 3000,
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      const placed = await api('/instances', builder.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'delete-account-unpaid-payout-instance',
          landletId: 'delete-account-unpaid-payout-landlet',
          templateId: 'delete-account-unpaid-payout-template',
          x: 0, y: 0,
        }),
      }));
      expect(placed.response.status).toBe(201);
      const purchased = await api('/instances/delete-account-unpaid-payout-instance/purchase', builder.session({ method: 'POST' }));
      const { purchaseId } = purchased.body.purchase;

      // Stands in for a real-money purchase handlePurchaseFinalize would
      // have written (same technique as worker/purchases.test.js's own
      // #732 test) -- the deletion guard only cares that payment_intent_id
      // is set and paid_out_at/refunded_at are not.
      await env.DB.prepare('UPDATE purchases SET payment_intent_id = ? WHERE purchase_id = ?')
        .bind('pi_delete_account_unpaid_payout_test', purchaseId).run();

      const deletion = await api('/auth/delete-account', seller.session({
        method: 'POST', body: JSON.stringify({ password: TEST_PASSWORD }),
      }));
      expect(deletion.response.status).toBe(409);
      expect(deletion.body).toEqual({
        error: "Cannot delete your account while a real-money purchase's proceeds are still unpaid — request a payout first",
      });

      const sellerRow = await env.DB.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?')
        .bind(seller.sellerId).first();
      expect(sellerRow).toBeTruthy();
      const me = await api('/auth/me', seller.session());
      expect(me.body.user).not.toBeNull();
      expect(me.body.user.email).toBe(seller.email);
    });
  });
});
