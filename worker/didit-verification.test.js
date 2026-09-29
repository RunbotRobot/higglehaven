import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestDiditSession } from './index.js';
import { api, signupBuilder, signupSeller } from './test-helpers.js';

// Own file (own D1/worker isolate — see test-helpers.js's own comment on
// why the suite is split by file) specifically so setting
// env.DIDIT_WEBHOOK_SECRET here can't leak into worker/reviews-auth.test.js,
// which relies on it staying unset to exercise the 503-unconfigured path
// for the same endpoint. DIDIT_API_KEY is deliberately left unset even in
// this file — nothing here needs a real outbound call to Didit, only the
// webhook's own signature verification and DB reconciliation.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.DIDIT_WEBHOOK_SECRET = 'test-didit-webhook-secret';
});

afterAll(() => {
  env.DIDIT_WEBHOOK_SECRET = undefined;
});

async function signDiditPayload(payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.DIDIT_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return [...signatureBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function postDiditWebhook(payloadObject, { signature, body } = {}) {
  const rawBody = body !== undefined ? body : JSON.stringify(payloadObject);
  const headers = { 'content-type': 'application/json' };
  headers['x-signature'] = signature !== undefined ? signature : await signDiditPayload(rawBody);
  return SELF.fetch('https://higglehaven.test/api/auth/didit-webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

async function insertPendingSession(email) {
  const sessionId = `sess-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO didit_verification_sessions (session_id, user_id, status)
    VALUES (?, (SELECT user_id FROM users WHERE email = ?), 'pending')
  `).bind(sessionId, email).run();
  return sessionId;
}

describe('Didit verification webhook (#589)', () => {
  it('rejects a webhook with a missing or wrong signature', async () => {
    const builder = await signupBuilder('didit-webhook-badsig');
    const sessionId = await insertPendingSession(builder.email);

    const noSig = await postDiditWebhook({ session_id: sessionId, status: 'Approved' }, { signature: '' });
    expect(noSig.status).toBe(401);

    const wrongSig = await postDiditWebhook({ session_id: sessionId, status: 'Approved' }, { signature: 'a'.repeat(64) });
    expect(wrongSig.status).toBe(401);

    // Neither attempt actually changed anything from signupBuilder's own
    // starting trust_tier (test-helpers.js's signup() stamps 'credit_card'
    // on every test account by default now, see #556 — not literally
    // 'none', but the point here is unchanged either way).
    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('credit_card');
  });

  it('raises trust_tier to id_verified on an Approved decision with a valid signature', async () => {
    const builder = await signupBuilder('didit-webhook-approved');
    const sessionId = await insertPendingSession(builder.email);

    const response = await postDiditWebhook({ session_id: sessionId, status: 'Approved' });
    expect(response.status).toBe(200);

    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('id_verified');
    const session = await env.DB.prepare('SELECT status, processed_at FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('approved');
    expect(session.processed_at).not.toBeNull();

    const status = await api('/auth/didit-verification-status', builder.session());
    expect(status.body).toEqual({ status: 'approved' });
  });

  it('records a Declined decision without raising trust_tier', async () => {
    const builder = await signupBuilder('didit-webhook-declined');
    const sessionId = await insertPendingSession(builder.email);

    const response = await postDiditWebhook({ session_id: sessionId, status: 'Declined' });
    expect(response.status).toBe(200);

    // Not raised to 'id_verified' -- still whatever signupBuilder's own
    // trust_tier shortcut left it at (#556's test-helpers.js default is
    // 'credit_card' now, not literally 'none', but "unraised" is the point).
    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('credit_card');
    const session = await env.DB.prepare('SELECT status FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('declined');
  });

  it('leaves a session pending on a non-terminal status like "In Review"', async () => {
    const builder = await signupBuilder('didit-webhook-inreview');
    const sessionId = await insertPendingSession(builder.email);

    const response = await postDiditWebhook({ session_id: sessionId, status: 'In Review' });
    expect(response.status).toBe(200);

    const session = await env.DB.prepare('SELECT status, processed_at FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('pending');
    expect(session.processed_at).toBeNull();
  });

  it('is a safe no-op for an unknown session_id', async () => {
    const response = await postDiditWebhook({ session_id: 'sess-does-not-exist', status: 'Approved' });
    expect(response.status).toBe(200);
  });

  // Guards against a duplicate webhook delivery (Didit, like most
  // webhook senders, can redeliver) double-applying — e.g. re-raising an
  // already-processed 'declined' session to 'approved' on a stale retry.
  it('ignores a repeat delivery for an already-processed session', async () => {
    const builder = await signupBuilder('didit-webhook-duplicate');
    const sessionId = await insertPendingSession(builder.email);

    const first = await postDiditWebhook({ session_id: sessionId, status: 'Declined' });
    expect(first.status).toBe(200);

    const replay = await postDiditWebhook({ session_id: sessionId, status: 'Approved' });
    expect(replay.status).toBe(200);

    // Still whatever it was after the first (declined) resolution — the
    // replay's Approved status was ignored, not re-applied on top.
    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('credit_card');
    const session = await env.DB.prepare('SELECT status FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('declined');
  });

  // #607: idx_didit_verification_sessions_user_id's own migration comment
  // says this table is looked up by user_id "to reuse/report an already-
  // pending one" when starting a new session -- handleDiditVerificationSession
  // never actually did that lookup. Testing the extracted latestDiditSession
  // helper directly, the same way concept-image's reserveStorageBudget is
  // tested directly (#602/#605) rather than through the real HTTP endpoint
  // -- DIDIT_API_KEY is never configured in any test file (deliberately,
  // per this file's own top comment), so handleDiditVerificationSession
  // itself always 503s before ever reaching this lookup here.
  describe('latestDiditSession (#607)', () => {
    it('returns null for a user with no session ever started', async () => {
      const builder = await signupBuilder('didit-latest-none');
      const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(builder.email).first()).user_id;
      const latest = await latestDiditSession(env.DB, userId);
      expect(latest).toBeNull();
    });

    it('returns the most recent session, including its url, for reuse -- not an older processed one', async () => {
      const builder = await signupBuilder('didit-latest-reuse');
      const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(builder.email).first()).user_id;

      const olderSessionId = await insertPendingSession(builder.email);
      await env.DB.prepare(`
        UPDATE didit_verification_sessions SET status = 'declined', processed_at = '2026-01-01T00:00:00.000Z' WHERE session_id = ?
      `).bind(olderSessionId).run();

      const newerSessionId = `sess-${crypto.randomUUID()}`;
      await env.DB.prepare(`
        INSERT INTO didit_verification_sessions (session_id, user_id, status, url, created_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).bind(newerSessionId, userId, 'https://verify.didit.me/session/newer', new Date(Date.now() + 1000).toISOString()).run();

      const latest = await latestDiditSession(env.DB, userId);
      expect(latest.session_id).toBe(newerSessionId);
      expect(latest.processed_at).toBeNull();
      expect(latest.url).toBe('https://verify.didit.me/session/newer');
    });
  });

  // #1014/migrations/0090+0092: didit_verification_sessions.user_id,
  // sellers.user_id, and (as of 0092) builders.user_id used to have no ON
  // DELETE clause at all (SQLite/D1's default RESTRICT), unlike every other
  // REFERENCES users(user_id) FK in this schema -- a direct `DELETE FROM
  // users` would have been rejected outright rather than cascading/nulling
  // cleanly. No account-deletion endpoint exists yet, so this is exercised
  // at the raw-SQL level (the same "no endpoint to drive it through yet"
  // shape this file's own insertPendingSession helper already works around
  // for session creation).
  describe('ON DELETE behavior on users(user_id) (#1014/migrations/0090+0092)', () => {
    it('cascades a deleted user into their own didit_verification_sessions rows', async () => {
      const builder = await signupBuilder('didit-user-deleted');
      const sessionId = await insertPendingSession(builder.email);
      const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(builder.email).first()).user_id;

      await env.DB.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run();

      const row = await env.DB.prepare('SELECT * FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
      expect(row).toBeNull();
    });

    it('nulls out sellers.user_id (keeping the seller row) after the linked user is deleted', async () => {
      const seller = await signupSeller('didit-seller-user-deleted');
      const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(seller.email).first()).user_id;

      await env.DB.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run();

      const row = await env.DB.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(seller.sellerId).first();
      expect(row).not.toBeNull();
      expect(row.user_id).toBeNull();
    });

    // handleSignup links every new account to an auto-provisioned builder
    // via builders.user_id (docs/SPEC.md §3's "every user is automatically
    // a builder") -- migrations/0092 closed this same gap for
    // builders.user_id, the one column #1014/migrations/0090 deliberately
    // left out (builders is the parent side of several other ON DELETE
    // CASCADE/SET NULL foreign keys, so rebuilding it safely needed its own
    // migration -- see that migration's own comment for the technique).
    it('nulls out builders.user_id (keeping the builder row) after the linked user is deleted', async () => {
      const builder = await signupBuilder('didit-builder-user-deleted');
      const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(builder.email).first()).user_id;

      await env.DB.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run();

      const row = await env.DB.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builder.builderId).first();
      expect(row).not.toBeNull();
      expect(row.user_id).toBeNull();
    });
  });

  // migrations/0092 rebuilt `builders` (to add ON DELETE SET NULL on its own
  // user_id column) alongside every table that itself references builders
  // -- notifications, bundles, auctions, auction_bids, friendships,
  // higgles_earnings_events, purchases, saved_level_layouts, owned_avatars,
  // higgles_redemptions -- to avoid the cascade-on-DROP-TABLE data-loss
  // trap that migration's own comment documents. This guards against that
  // rebuild having silently dropped or altered any of THOSE tables' own,
  // unrelated ON DELETE behavior against builders (the thing every one of
  // them actually depends on in production, unlike builders.user_id itself,
  // which nothing depended on before this migration).
  describe('builders remains a correct CASCADE/SET NULL parent after migrations/0092', () => {
    it('still cascades a deleted builder into its own notifications', async () => {
      const builder = await signupBuilder('post-0092-notifications-cascade');
      await env.DB.prepare(
        "INSERT INTO notifications (notification_id, builder_id, message) VALUES (?, ?, 'test')",
      ).bind(`notif-${crypto.randomUUID()}`, builder.builderId).run();

      await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(builder.builderId).run();

      const { results } = await env.DB.prepare('SELECT * FROM notifications WHERE builder_id = ?').bind(builder.builderId).all();
      expect(results).toHaveLength(0);
    });

    it('still nulls out purchases.builder_id (keeping the purchase row) after the linked builder is deleted', async () => {
      const builder = await signupBuilder('post-0092-purchases-set-null');
      const purchaseId = `purchase-${crypto.randomUUID()}`;
      await env.DB.prepare(`
        INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, unit_price_cents, total_cents, commission_cents, builder_share_cents, platform_share_cents)
        VALUES (?, 'test-instance', 'test-template', ?, 100, 100, 0, 0, 100)
      `).bind(purchaseId, builder.builderId).run();

      await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(builder.builderId).run();

      const row = await env.DB.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
      expect(row).not.toBeNull();
      expect(row.builder_id).toBeNull();
    });
  });
});
