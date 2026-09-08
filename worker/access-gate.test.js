import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Own file (own D1/worker isolate, see test-helpers.js's own comment on
// why the suite is split by file) specifically so mutating
// env.ACCESS_PASSPHRASE here can't leak into any other test file — every
// other worker/*.test.js file relies on it staying unset (see
// checkAccessGate in worker/index.js: the whole gate is skipped when it
// is falsy), so this can't share an isolate with them.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.ACCESS_PASSPHRASE = 'test-access-passphrase';
});

afterAll(() => {
  env.ACCESS_PASSPHRASE = undefined;
});

async function postAccessLogin(passphrase, headers) {
  const form = new URLSearchParams({ passphrase });
  return SELF.fetch('https://higglehaven.test/__access/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: form.toString(),
    redirect: 'manual',
  });
}

describe('Access gate (/__access/login)', () => {
  it('grants the access cookie for the correct passphrase', async () => {
    const response = await postAccessLogin('test-access-passphrase', { 'cf-connecting-ip': `test-${crypto.randomUUID()}` });
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('hh_access=');
  });

  it('rejects an incorrect passphrase without granting a cookie', async () => {
    const response = await postAccessLogin('wrong-passphrase', { 'cf-connecting-ip': `test-${crypto.randomUUID()}` });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  // Found via backlog audit: unlike every other unauthenticated secret-
  // comparison endpoint in this file (admin-bootstrap, signup,
  // password-reset), this one had no throttle at all.
  it('rate-limits repeated passphrase guesses from the same IP', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 10; i++) {
      const attempt = await postAccessLogin('wrong-passphrase', headers);
      expect(attempt.status).not.toBe(429);
    }
    const limited = await postAccessLogin('wrong-passphrase', headers);
    expect(limited.status).toBe(429);

    // A correct guess right after being rate-limited still doesn't get
    // through — the throttle applies before the passphrase is even
    // compared, not just to repeated failures.
    const stillLimited = await postAccessLogin('test-access-passphrase', headers);
    expect(stillLimited.status).toBe(429);
    expect(stillLimited.headers.get('set-cookie')).toBeNull();
  });

  it('does not share a rate-limit bucket with a different IP', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 10; i++) {
      await postAccessLogin('wrong-passphrase', headers);
    }
    const otherIp = await postAccessLogin('test-access-passphrase', { 'cf-connecting-ip': `test-${crypto.randomUUID()}` });
    expect(otherIp.status).toBe(302);
  });
});
