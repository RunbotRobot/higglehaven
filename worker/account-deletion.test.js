// #1146 (sub-issue of #1145, owner decision via Control Room 2026-10-01):
// POST /api/auth/delete-account, the users-row half of real full account
// deletion -- revoke login, free the email/username for a future signup,
// sign out every device. Does not touch builders/sellers/financial records
// (see worker/index.js's own handleDeleteAccount comment for the split).
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
});
