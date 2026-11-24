import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signup, extractSessionCookie, withSession, signupBuilder } from './test-helpers.js';

// #4136: the username rules apply on sign-up and on rename, from one function, and the folded form is what names are
// compared by.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const email = () => `u-${crypto.randomUUID()}@example.com`;
const trySignup = (username) => signup(email(), 'a fine long password here', { username });

describe('sign-up username rules (#4136)', () => {
  it('stores a trimmed name with runs of spaces collapsed, and refuses the collapsed twin', async () => {
    const first = await trySignup('  Ada   Builder4136 ');
    expect(first.response.status).toBe(201);
    expect(first.body.user.username).toBe('Ada Builder4136');
    const twin = await trySignup('ada builder4136');
    expect(twin.response.status).toBe(409);
  });

  it('refuses unshowable characters and says why', async () => {
    for (const bad of ['Zero​Width', 'Over‮ride', 'New\nline']) {
      const result = await trySignup(bad);
      expect(result.response.status).toBe(400);
      expect(result.body.error).toMatch(/character we cannot show/);
    }
  });

  it('refuses a look-alike of an existing name', async () => {
    expect((await trySignup('Pauline4136')).response.status).toBe(201);
    const lookAlike = await trySignup('Pаulinе' + '4136'); // Cyrillic a and e
    expect(lookAlike.response.status).toBe(409);
  });

  it('reserves the misleading names and the assistants, also as look-alikes', async () => {
    for (const name of ['Admin', 'support', 'Staff', 'Moderator', 'Higgle haven', 'Junіper', 'Sage']) {
      const result = await trySignup(name);
      expect(result.response.status, name).toBe(409);
    }
  });

  it('backfills the folded form for an account that has none, so it still blocks a look-alike', async () => {
    const old = await trySignup('Legacy4136');
    expect(old.response.status).toBe(201);
    await env.DB.prepare("UPDATE users SET username_skeleton = NULL WHERE username = 'Legacy4136'").run();
    const lookAlike = await trySignup('Lеgacy4136');
    expect(lookAlike.response.status).toBe(409);
    const row = await env.DB.prepare("SELECT username_skeleton FROM users WHERE username = 'Legacy4136'").first();
    expect(row.username_skeleton).toBe('legacy4136');
  });
});

describe('rename username rules (#4136)', () => {
  it('applies the same rules to a rename', async () => {
    const holder = await signupBuilder('Renamer4136Holder');
    const e = email();
    const su = await signup(e, 'a fine long password here', { username: 'Renamer4136' });
    expect(su.response.status).toBe(201);
    const tok = extractSessionCookie(su.response);
    const me = await api('/builders/me', withSession(tok));
    const a = { builderId: me.body.builder.builderId, session: (o) => withSession(tok, o) };
    const rename = (label) => api(`/builders/${a.builderId}`, a.session({ method: 'PUT', body: JSON.stringify({ label }) }));

    const spaced = await rename('  New   Name4136 ');
    expect(spaced.body, JSON.stringify(spaced.body)).toBeTruthy();
    expect(spaced.response.status, JSON.stringify(spaced.body)).toBe(200);
    expect(spaced.body.builder.label).toBe('New Name4136');

    expect((await rename('Bad​Name')).response.status).toBe(400);
    expect((await rename('Admin')).response.status).toBe(409);
    expect((await rename('Renamer4136Hоlder')).response.status).toBe(409); // Cyrillic o: look-alike of an existing name
    expect(holder.builderId).toBeTruthy();
  });
});
