import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// #3464: opt-in only, so a person's own requests never carry a new header.
describe('Server-Timing for D1 (#3464)', () => {
  it('answers how many D1 trips a request made when asked, and only then', async () => {
    const account = await signupBuilder('server-timing-account');
    const asked = await api('/auth/me', account.session({ headers: { 'x-server-timing': '1' } }));
    expect(asked.response.status).toBe(200);
    expect(asked.response.headers.get('server-timing')).toMatch(/^d1;dur=\d+;desc="[1-9]\d* trips?", d1rows;dur=0;desc="\d+ rows read"$/);
    expect(asked.body.user).toBeTruthy(); // the wrapper changes nothing about the answer

    const plain = await api('/auth/me', account.session());
    expect(plain.response.status).toBe(200);
    expect(plain.response.headers.get('server-timing')).toBeNull();
  });

  it('also answers for a request the server refuses', async () => {
    const missing = await api('/instances/no-such-instance/purchase-quote', { headers: { 'x-server-timing': '1' } });
    expect(missing.response.headers.get('server-timing')).toMatch(/^d1;dur=\d+;desc="\d+ trips?", d1rows;dur=0;desc="\d+ rows read"$/);
  });
});
