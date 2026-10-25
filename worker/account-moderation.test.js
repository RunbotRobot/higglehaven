// #2757: admin "Find user" search/detail workflow feeding suspend-account
// (worker/lib/account-moderation.js's handleSuspendAccount) -- the owner's
// own framing: "The 'Suspend account' feature should be from a page
// displaying information about a given user, so that we're sure we're
// suspending the right one." These two read-only endpoints (GET
// /auth/admin-user-search, GET /auth/admin-user-detail) back that page.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, signup, signupBuilder, signupSeller, signupAdmin, withSession, extractSessionCookie,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('account-mod-shared-admin');
  adminSession = admin.session;
});

const TEST_PASSWORD = 'a fine long password here';

async function currentUserId(sessionToken) {
  const me = await api('/auth/me', withSession(sessionToken));
  return me.body.user.userId;
}

describe('Admin find-user search/detail (#2757)', () => {
  describe('GET /auth/admin-user-search', () => {
    it('requires a session', async () => {
      const anon = await api('/auth/admin-user-search?q=anything');
      expect(anon.response.status).toBe(401);
    });

    it('requires admin -- a real but non-admin session is forbidden', async () => {
      const builder = await signupBuilder('user-search-non-admin');
      const attempt = await api('/auth/admin-user-search?q=anything', builder.session());
      expect(attempt.response.status).toBe(403);
    });

    it('rejects an empty query', async () => {
      const result = await api('/auth/admin-user-search?q=', adminSession());
      expect(result.response.status).toBe(400);
    });

    it('finds a user by partial, case-insensitive username match', async () => {
      const builder = await signupBuilder('findme-bytesearch');
      const result = await api(
        '/auth/admin-user-search?q=' + encodeURIComponent('FINDME-BYTE'),
        adminSession(),
      );
      expect(result.response.status).toBe(200);
      const match = result.body.users.find((u) => u.email === builder.email);
      expect(match).toBeTruthy();
      expect(match.username).toBe('findme-bytesearch');
    });

    it('finds a user by partial, case-insensitive email match', async () => {
      const builder = await signupBuilder('emailsearch-target');
      const localPart = builder.email.split('@')[0];
      const result = await api(
        '/auth/admin-user-search?q=' + encodeURIComponent(localPart.toUpperCase()),
        adminSession(),
      );
      expect(result.response.status).toBe(200);
      expect(result.body.users.some((u) => u.email === builder.email)).toBe(true);
    });

    it('returns no results for a query matching nothing', async () => {
      const result = await api(
        '/auth/admin-user-search?q=definitely-no-such-account-xyz-123',
        adminSession(),
      );
      expect(result.response.status).toBe(200);
      expect(result.body.users).toEqual([]);
    });

    it('result shape is narrow -- no password hash or other sensitive fields leaked', async () => {
      const builder = await signupBuilder('narrowshape-search');
      const result = await api(
        '/auth/admin-user-search?q=narrowshape-search',
        adminSession(),
      );
      const match = result.body.users.find((u) => u.email === builder.email);
      expect(match).toBeTruthy();
      expect(match).toEqual({
        userId: expect.any(String),
        username: 'narrowshape-search',
        email: builder.email,
        trustTier: 'credit_card',
        createdAt: expect.any(String),
        hasBuilderProfile: true,
        hasSellerProfile: false,
        hasActiveSuspension: false,
      });
      expect(match.password_hash).toBeUndefined();
      expect(match.cardFunding).toBeUndefined();
    });

    it('flags an account that has both a builder and seller profile', async () => {
      const email = `bothprofiles-${crypto.randomUUID()}@example.com`;
      const signedUp = await signup(email, TEST_PASSWORD, { username: 'bothprofiles-user' });
      const sessionToken = extractSessionCookie(signedUp.response);
      await api('/builders/me', withSession(sessionToken));
      await api('/sellers/me', withSession(sessionToken));
      const result = await api('/auth/admin-user-search?q=bothprofiles-user', adminSession());
      const match = result.body.users.find((u) => u.email === email);
      expect(match.hasBuilderProfile).toBe(true);
      expect(match.hasSellerProfile).toBe(true);
    });

    it('flags an account with an active suspension', async () => {
      const builder = await signupBuilder('suspended-flag-search');
      await api('/auth/suspend-account', adminSession({
        method: 'POST',
        body: JSON.stringify({ email: builder.email, reason: 'test suspension for search flag' }),
      }));
      const result = await api('/auth/admin-user-search?q=suspended-flag-search', adminSession());
      const match = result.body.users.find((u) => u.email === builder.email);
      expect(match.hasActiveSuspension).toBe(true);
    });
  });

  describe('GET /auth/admin-user-detail', () => {
    it('requires a session', async () => {
      const anon = await api('/auth/admin-user-detail?userId=whatever');
      expect(anon.response.status).toBe(401);
    });

    it('requires admin -- a real but non-admin session is forbidden', async () => {
      const builder = await signupBuilder('user-detail-non-admin');
      const attempt = await api('/auth/admin-user-detail?userId=whatever', builder.session());
      expect(attempt.response.status).toBe(403);
    });

    it('rejects a missing userId', async () => {
      const result = await api('/auth/admin-user-detail?userId=', adminSession());
      expect(result.response.status).toBe(400);
    });

    it('404s for a userId that does not exist', async () => {
      const result = await api('/auth/admin-user-detail?userId=user-does-not-exist', adminSession());
      expect(result.response.status).toBe(404);
    });

    it('shows no seller profile for a plain signed-up account that never called /sellers/me (builder is always auto-provisioned at signup)', async () => {
      const email = `plain-account-${crypto.randomUUID()}@example.com`;
      const signedUp = await signup(email, TEST_PASSWORD, { username: 'plain-account-detail' });
      const sessionToken = extractSessionCookie(signedUp.response);
      const userId = await currentUserId(sessionToken);
      const result = await api('/auth/admin-user-detail?userId=' + encodeURIComponent(userId), adminSession());
      expect(result.response.status).toBe(200);
      expect(result.body.user).toMatchObject({
        userId, username: 'plain-account-detail', email, sellerId: null,
      });
      expect(result.body.user.builderId).toEqual(expect.any(String));
      expect(result.body.suspensions).toEqual([]);
    });

    it('shows linked builder and seller profile ids/labels when both exist', async () => {
      const email = `detail-both-${crypto.randomUUID()}@example.com`;
      const signedUp = await signup(email, TEST_PASSWORD, { username: 'detail-both-profiles' });
      const sessionToken = extractSessionCookie(signedUp.response);
      const builderMe = await api('/builders/me', withSession(sessionToken));
      const sellerMe = await api('/sellers/me', withSession(sessionToken));
      const userId = await currentUserId(sessionToken);
      const result = await api('/auth/admin-user-detail?userId=' + encodeURIComponent(userId), adminSession());
      expect(result.body.user.builderId).toBe(builderMe.body.builder.builderId);
      expect(result.body.user.builderLabel).toBe(builderMe.body.builder.label);
      expect(result.body.user.sellerId).toBe(sellerMe.body.seller.sellerId);
      expect(result.body.user.sellerLabel).toBe(sellerMe.body.seller.label);
    });

    it('returns suspension history newest-first, across a suspend/unsuspend/suspend cycle', async () => {
      const builder = await signupBuilder('detail-history-cycle');
      const userId = await currentUserId(builder.sessionToken);

      const firstSuspend = await api('/auth/suspend-account', adminSession({
        method: 'POST',
        body: JSON.stringify({ email: builder.email, reason: 'first suspension' }),
      }));
      expect(firstSuspend.response.status).toBe(200);

      await api('/auth/unsuspend-account', adminSession({
        method: 'POST',
        body: JSON.stringify({ email: builder.email }),
      }));

      const secondSuspend = await api('/auth/suspend-account', adminSession({
        method: 'POST',
        body: JSON.stringify({ email: builder.email, reason: 'second suspension' }),
      }));
      expect(secondSuspend.response.status).toBe(200);

      const result = await api('/auth/admin-user-detail?userId=' + encodeURIComponent(userId), adminSession());
      expect(result.response.status).toBe(200);
      expect(result.body.suspensions).toHaveLength(2);
      // Newest first: the still-active second suspension before the
      // already-lifted first one.
      expect(result.body.suspensions[0].reason).toBe('second suspension');
      expect(result.body.suspensions[0].liftedAt).toBeNull();
      expect(result.body.suspensions[1].reason).toBe('first suspension');
      expect(result.body.suspensions[1].liftedAt).not.toBeNull();
    });
  });
});
