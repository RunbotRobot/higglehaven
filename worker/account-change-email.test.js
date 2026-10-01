// #1182 (sub-issue of #1126, owner direction via Control Room 2026-10-01):
// POST /api/auth/change-email, the in-session change-email form. Same
// current-password bar and atomic uniqueness idiom as handleDeleteAccount/
// handleSignup -- see worker/index.js's own handleChangeEmail comment for
// the re-verification reasoning (email_verified_at is purely informational,
// so resetting it + re-sending the verification email is the existing
// signup mechanism applied consistently, not a new policy).
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, signup, signupBuilder, withSession,
} from './test-helpers.js';

// signupBuilder (test-helpers.js) always uses this fixed password.
const BUILDER_PASSWORD = 'a fine long password here';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('Account change-email (#1182)', () => {
  describe('POST /auth/change-email', () => {
    it('requires a session', async () => {
      const anon = await api('/auth/change-email', {
        method: 'POST',
        body: JSON.stringify({ password: 'whatever', email: 'new@example.com' }),
      });
      expect(anon.response.status).toBe(401);
    });

    it('rejects an incorrect password and leaves the account untouched', async () => {
      const account = await signupBuilder('change-email-wrong-password');
      const newEmail = `change-email-attempt-${crypto.randomUUID()}@example.com`;
      const attempt = await api('/auth/change-email', account.session({
        method: 'POST',
        body: JSON.stringify({ password: 'definitely not it', email: newEmail }),
      }));
      expect(attempt.response.status).toBe(401);

      const me = await api('/auth/me', account.session());
      expect(me.body.user.email).toBe(account.email);
    });

    it('changes the email, resets verification, and sends a fresh verification email', async () => {
      const password = 'a fine long password here';
      const email = `change-email-from-${crypto.randomUUID()}@example.com`;
      const username = `change-email-${crypto.randomUUID().slice(0, 8)}`;
      const signedUp = await signup(email, password, { username });
      expect(signedUp.response.status).toBe(201);

      const sessionToken = extractSessionCookie(signedUp.response);
      const newEmail = `change-email-to-${crypto.randomUUID()}@example.com`;
      const changed = await api('/auth/change-email', withSession(sessionToken, {
        method: 'POST',
        body: JSON.stringify({ password, email: newEmail }),
      }));
      expect(changed.response.status).toBe(200);
      expect(changed.body.user.email).toBe(newEmail);
      expect(changed.body.user.emailVerified).toBe(false);
      // RESEND_API_KEY isn't configured in this test env (see sendEmail's
      // own comment), so the real send is a no-op and devVerifyUrl stands
      // in for it instead — verificationEmailSent reflects that honestly.
      expect(changed.body.verificationEmailSent).toBe(false);
      expect(changed.body.devVerifyUrl).toContain('verifyEmail=');

      const me = await api('/auth/me', withSession(sessionToken));
      expect(me.body.user.email).toBe(newEmail);
      expect(me.body.user.emailVerified).toBe(false);

      // The old address is freed and can be used for a brand-new signup.
      const resignup = await signup(email, 'a totally different password');
      expect(resignup.response.status).toBe(201);
    });

    it('rejects changing to the current email', async () => {
      const account = await signupBuilder('change-email-same');
      const attempt = await api('/auth/change-email', account.session({
        method: 'POST',
        body: JSON.stringify({ password: BUILDER_PASSWORD, email: account.email }),
      }));
      expect(attempt.response.status).toBe(400);
    });

    it('rejects an email already registered to another account, case-insensitively', async () => {
      const takenEmail = `change-email-taken-${crypto.randomUUID()}@example.com`;
      await signup(takenEmail, 'first password here');
      const account = await signupBuilder('change-email-collision');

      const attempt = await api('/auth/change-email', account.session({
        method: 'POST',
        body: JSON.stringify({ password: BUILDER_PASSWORD, email: takenEmail.toUpperCase() }),
      }));
      expect(attempt.response.status).toBe(409);

      // Untouched on the failed attempt.
      const me = await api('/auth/me', account.session());
      expect(me.body.user.email).toBe(account.email);
    });
  });
});
