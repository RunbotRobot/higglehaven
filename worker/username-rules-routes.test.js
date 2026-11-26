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
  it('stores a trimmed name and refuses its other-case twin', async () => {
    const first = await trySignup('  AdaBuilder4136 ');
    expect(first.response.status).toBe(201);
    expect(first.body.user.username).toBe('AdaBuilder4136');
    const twin = await trySignup('adabuilder4136');
    expect(twin.response.status).toBe(409);
  });

  it('refuses a name with a space and says what to do (#4407)', async () => {
    for (const name of ['Ada Builder', '  Ada   Builder4407 ']) {
      const result = await trySignup(name);
      expect(result.response.status, name).toBe(400);
      expect(result.body.error).toBe("A name can't have spaces. Try BenjaminChae or Benjamin_Chae.");
    }
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
    for (const name of ['Admin', 'support', 'Staff', 'Moderator', 'Higgle_haven', 'Junіper', 'Sage']) {
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

describe('names that read as the team (#4383)', () => {
  it('sign-up refuses a name starting with higglehaven and says it is taken', async () => {
    for (const name of ['higglehaven17', 'Higgle_haven_99', 'higglehaven-2']) {
      const result = await trySignup(name);
      expect(result.response.status, name).toBe(409);
      expect(result.body.error).toMatch(/already taken/);
    }
    expect((await trySignup('thehigglehavenfan4383')).response.status).toBe(201);
  });

  it('a rename refuses them too', async () => {
    const su = await signup(email(), 'a fine long password here', { username: 'Renamer4383' });
    const tok = extractSessionCookie(su.response);
    const me = await api('/builders/me', withSession(tok));
    const rename = (label) => api(`/builders/${me.body.builder.builderId}`, withSession(tok, { method: 'PUT', body: JSON.stringify({ label }) }));
    expect((await rename('higglehaven17')).response.status).toBe(409);
    expect((await rename('Juniper2')).response.status).toBe(409);
    expect((await rename('Renamed4383')).response.status).toBe(200);
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

    const spaced = await rename('  NewName4136 ');
    expect(spaced.response.status, JSON.stringify(spaced.body)).toBe(200);
    expect(spaced.body.builder.label).toBe('NewName4136');
    // #4407: a space is refused on a rename too
    const withSpace = await rename('New Name4136');
    expect(withSpace.response.status).toBe(400);
    expect(withSpace.body.error).toMatch(/can't have spaces/);

    expect((await rename('Bad​Name')).response.status).toBe(400);
    expect((await rename('Admin')).response.status).toBe(409);
    expect((await rename('Renamer4136Hоlder')).response.status).toBe(409); // Cyrillic o: look-alike of an existing name
    expect(holder.builderId).toBeTruthy();
  });
});
