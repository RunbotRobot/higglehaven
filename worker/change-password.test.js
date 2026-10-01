// #1181 (sub-issue of #1126, owner decision via Control Room 2026-10-01):
// POST /api/auth/change-password, a real in-session change-password form
// separate from the forgot-password email-link flow (which stays as the
// logged-out path). See worker/index.js's own handleChangePassword comment
// for why this signs out every OTHER session but keeps the current one.
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

describe('Change password (#1181)', () => {
  describe('POST /auth/change-password', () => {
    it('requires a session', async () => {
      const anon = await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'whatever', newPassword: 'a new password here' }),
      });
      expect(anon.response.status).toBe(401);
    });

    it('rejects an incorrect current password and leaves the account untouched', async () => {
      const account = await signupBuilder('change-password-wrong-current');
      const attempt = await api('/auth/change-password', account.session({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'definitely not it', newPassword: 'a new password here' }),
      }));
      expect(attempt.response.status).toBe(401);

      const me = await api('/auth/me', account.session());
      expect(me.body.user).not.toBeNull();
    });

    it('rejects a new password shorter than 8 characters', async () => {
      // signupBuilder's own fixed password (see test-helpers.js) — not
      // exposed on the returned account object, so hardcoded here too.
      const account = await signupBuilder('change-password-too-short');
      const attempt = await api('/auth/change-password', account.session({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'a fine long password here', newPassword: 'short' }),
      }));
      expect(attempt.response.status).toBe(400);
    });

    it('changes the password, signs out other sessions, keeps the current one alive', async () => {
      const password = 'a fine long original password';
      const newPassword = 'a fine long replacement password';
      const email = `change-password-${crypto.randomUUID()}@example.com`;
      const username = `change-pw-${crypto.randomUUID().slice(0, 8)}`;
      const signedUp = await signup(email, password, { username });
      const sessionA = extractSessionCookie(signedUp.response);

      // A second device/tab, so the test can confirm the change signs out
      // every OTHER session, not the one making the change.
      const login = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const sessionB = extractSessionCookie(login.response);

      const changed = await api('/auth/change-password', withSession(sessionA, {
        method: 'POST',
        body: JSON.stringify({ currentPassword: password, newPassword }),
      }));
      expect(changed.response.status).toBe(200);
      expect(changed.body.changed).toBe(true);

      // The session that made the change is still alive.
      const meA = await api('/auth/me', withSession(sessionA));
      expect(meA.body.user).not.toBeNull();
      expect(meA.body.user.email).toBe(email);

      // The other session was signed out.
      const meB = await api('/auth/me', withSession(sessionB));
      expect(meB.body.user).toBeNull();

      // The old password no longer works; the new one does.
      const oldLogin = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      expect(oldLogin.response.status).toBe(401);
      const newLogin = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: newPassword }),
      });
      expect(newLogin.response.status).toBe(200);
    });

    it('rate-limits repeated change-password attempts', async () => {
      const account = await signupBuilder('change-password-rate-limit');
      for (let i = 0; i < 5; i++) {
        const attempt = await api('/auth/change-password', account.session({
          method: 'POST',
          body: JSON.stringify({ currentPassword: 'wrong on purpose', newPassword: 'a new password here' }),
        }));
        expect(attempt.response.status).not.toBe(429);
      }
      const limited = await api('/auth/change-password', account.session({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'wrong on purpose', newPassword: 'a new password here' }),
      }));
      expect(limited.response.status).toBe(429);
    });
  });
});
