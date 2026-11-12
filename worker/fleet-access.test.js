import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, extractSessionCookie, withSession, signupBuilder, signupSeller, signupAdmin, createGreenbeltLandletAs } from './test-helpers.js';
import { FLEET_AGENT_NAMES } from './lib/fleet-agents.js';
import { assistantSpot, ASSISTANT_SHIFT_STALE_AFTER_MS } from './lib/assistant-shift.js';

// #3429 (part of #3428): fleet access. Own file (own isolate) because it sets
// env.ACCESS_PASSPHRASE and env.FLEET_ACCESS_KEY, which every other test file
// relies on staying unset (see access-gate.test.js).
const FLEET_KEY = 'test-fleet-access-key';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.ACCESS_PASSPHRASE = 'test-access-passphrase';
  env.FLEET_ACCESS_KEY = FLEET_KEY;
});

afterAll(() => {
  env.ACCESS_PASSPHRASE = undefined;
  env.FLEET_ACCESS_KEY = undefined;
});

const ip = () => ({ 'cf-connecting-ip': `test-${crypto.randomUUID()}` });

function fleetFetch(path, { key, headers, ...options } = {}) {
  return SELF.fetch(`https://higglehaven.test${path}`, {
    ...options,
    headers: {
      ...ip(),
      ...(key === undefined ? {} : { 'x-fleet-key': key }),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });
}

async function fleetLogin(name) {
  const response = await fleetFetch('/api/auth/fleet-login', {
    method: 'POST', key: FLEET_KEY, body: JSON.stringify({ name }),
  });
  const body = await response.json();
  return { response, body, token: extractSessionCookie(response) };
}

describe('Fleet key and the preview gate', () => {
  it('passes the gate with the right key, and not with a wrong or missing one', async () => {
    expect((await fleetFetch('/api/auth/me', { key: FLEET_KEY })).status).not.toBe(401);
    expect((await fleetFetch('/api/auth/me', { key: 'wrong' })).status).toBe(401);
    expect((await fleetFetch('/api/auth/me')).status).toBe(401);
  });

  it('does nothing when the secret is unset', async () => {
    env.FLEET_ACCESS_KEY = undefined;
    try {
      expect((await fleetFetch('/api/auth/me', { key: FLEET_KEY })).status).toBe(401);
    } finally {
      env.FLEET_ACCESS_KEY = FLEET_KEY;
    }
  });

  it('rate-limits wrong keys per IP, and then stops comparing even a correct one from that IP', async () => {
    const headers = ip();
    for (let i = 0; i < 10; i++) {
      expect((await fleetFetch('/api/auth/me', { key: `wrong-${i}`, headers })).status).toBe(401);
    }
    expect((await fleetFetch('/api/auth/me', { key: 'wrong-again', headers })).status).toBe(429);
    expect((await fleetFetch('/api/auth/me', { key: FLEET_KEY, headers })).status).toBe(429);
    // Another client with the right key is unaffected.
    expect((await fleetFetch('/api/auth/me', { key: FLEET_KEY })).status).not.toBe(401);
  });

  it('never counts correct keys against the budget', async () => {
    const headers = ip();
    for (let i = 0; i < 15; i++) {
      expect((await fleetFetch('/api/auth/me', { key: FLEET_KEY, headers })).status).not.toBe(429);
    }
  });
});

describe('POST /api/auth/fleet-login', () => {
  it('is a 404 without the key, with a wrong key, and when the secret is unset', async () => {
    const body = JSON.stringify({ name: 'higglehaven7' });
    expect((await fleetFetch('/api/auth/fleet-login', { method: 'POST', body })).status).toBe(401); // gate first
    expect((await fleetFetch('/api/auth/fleet-login', { method: 'POST', body, key: 'wrong' })).status).toBe(401);
    env.ACCESS_PASSPHRASE = undefined;
    try {
      expect((await fleetFetch('/api/auth/fleet-login', { method: 'POST', body })).status).toBe(404);
      expect((await fleetFetch('/api/auth/fleet-login', { method: 'POST', body, key: 'wrong' })).status).toBe(404);
    } finally {
      env.ACCESS_PASSPHRASE = 'test-access-passphrase';
    }
  });

  it('repairs a fleet account left at the lowest trust tier on its next login (#3430)', async () => {
    await fleetLogin('higglehaven7');
    await env.DB.prepare("UPDATE users SET trust_tier = 'none' WHERE username = 'higglehaven7'").run();
    await fleetLogin('higglehaven7');
    const row = await env.DB.prepare("SELECT trust_tier FROM users WHERE username = 'higglehaven7'").first();
    expect(row.trust_tier).toBe('credit_card');
  });

  it('creates the account once, then signs in the same one; the session works', async () => {
    const first = await fleetLogin('higglehaven3');
    expect(first.response.status).toBe(200);
    expect(first.token).toBeTruthy();
    const second = await fleetLogin('higglehaven3');
    expect(second.body.user.userId).toBe(first.body.user.userId);
    const rows = await env.DB.prepare("SELECT user_id, is_fleet, email_verified_at, is_admin, trust_tier FROM users WHERE username = 'higglehaven3'").all();
    expect(rows.results).toHaveLength(1);
    // #3430: past the app's age-and-card verify step, which a fleet account cannot do.
    expect(rows.results[0]).toMatchObject({ is_fleet: 1, is_admin: 0, trust_tier: 'credit_card' });
    expect(rows.results[0].email_verified_at).not.toBeNull();

    const me = await fleetFetch('/api/auth/me', { key: FLEET_KEY, headers: { cookie: `hh_session=${second.token}` } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe('higglehaven3');
  });

  it('rejects a name that is not a fleet session name', async () => {
    for (const name of ['alice', 'higglehaven', 'higglehavenx', 'Higglehaven3', 'higglehaven1234']) {
      const result = await fleetLogin(name);
      expect(result.response.status).toBe(400);
      expect(result.token).toBeNull();
    }
  });

  it('never signs in as a regular account that holds the name', async () => {
    // A real signup chose the username first.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (user_id, email, password_hash, username, email_canonical) VALUES ('user-real-hh9', 'real-hh9@example.test', 'x', 'higglehaven9', 'real-hh9@example.test')",
    ).run();
    const result = await fleetLogin('higglehaven9');
    expect(result.response.status).toBe(409);
    expect(result.token).toBeNull();
  });

  it('cannot become an admin by any path', async () => {
    const { token, body } = await fleetLogin('higglehaven4');
    await expect(env.DB.prepare('UPDATE users SET is_admin = 1 WHERE user_id = ?').bind(body.user.userId).run())
      .rejects.toThrow(/fleet account can never be an admin/);
    // Bootstrap is refused before the secret is even read.
    const attempt = await api('/auth/admin-bootstrap', withSession(token, {
      method: 'POST', body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
      headers: { 'x-fleet-key': FLEET_KEY },
    }));
    expect(attempt.response.status).toBe(403);
    expect(attempt.body.error).toMatch(/fleet account cannot become an admin/);
  });
});

// #3508: with ASSISTANT_ACCESS_KEY set, the coding fleet's key and the
// assistant environment's key each sign in only their own kind of account.
describe('Two fleet keys: coding and assistant (#3508)', () => {
  const ASSISTANT_KEY = 'test-assistant-access-key';
  beforeAll(() => { env.ASSISTANT_ACCESS_KEY = ASSISTANT_KEY; });
  afterAll(() => { env.ASSISTANT_ACCESS_KEY = undefined; });

  const loginWith = (key, name, headers) => fleetFetch('/api/auth/fleet-login', {
    method: 'POST', key, headers, body: JSON.stringify({ name }),
  });

  it('both keys pass the preview gate', async () => {
    expect((await fleetFetch('/api/auth/me', { key: FLEET_KEY })).status).not.toBe(401);
    expect((await fleetFetch('/api/auth/me', { key: ASSISTANT_KEY })).status).not.toBe(401);
  });

  it('the coding key signs in a coding session and not an assistant', async () => {
    expect((await loginWith(FLEET_KEY, 'higglehaven5')).status).toBe(200);
    const refused = await loginWith(FLEET_KEY, 'assistant-juniper');
    expect(refused.status).toBe(404);
    expect(extractSessionCookie(refused)).toBeFalsy();
  });

  it('the assistant key signs in an assistant and not a coding session', async () => {
    expect((await loginWith(ASSISTANT_KEY, 'assistant-juniper')).status).toBe(200);
    const refused = await loginWith(ASSISTANT_KEY, 'higglehaven5');
    expect(refused.status).toBe(404);
    expect(extractSessionCookie(refused)).toBeFalsy();
  });

  it('the refusal is the plain "Not found" 404 the route gives without a key, and a refused login creates no account', async () => {
    const refused = await loginWith(ASSISTANT_KEY, 'higglehaven77');
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'Not found' });
    const row = await env.DB.prepare("SELECT 1 FROM users WHERE email = 'higglehaven77@fleet.invalid'").first();
    expect(row).toBeNull();
  });

  it('a wrong key is counted the same, and neither real key is counted', async () => {
    const headers = ip();
    for (let i = 0; i < 10; i++) {
      expect((await fleetFetch('/api/auth/me', { key: `wrong-${i}`, headers })).status).toBe(401);
    }
    expect((await fleetFetch('/api/auth/me', { key: ASSISTANT_KEY, headers })).status).toBe(429);
    const other = ip();
    for (let i = 0; i < 12; i++) {
      expect((await fleetFetch('/api/auth/me', { key: i % 2 ? FLEET_KEY : ASSISTANT_KEY, headers: other })).status).not.toBe(429);
    }
  });

  it('the assistant key alone turns the gate on for assistants, and the coding key being unset turns coding off', async () => {
    env.FLEET_ACCESS_KEY = undefined;
    try {
      expect((await loginWith(ASSISTANT_KEY, 'assistant-fig')).status).toBe(200);
      expect((await loginWith(FLEET_KEY, 'higglehaven5')).status).toBe(401);
    } finally {
      env.FLEET_ACCESS_KEY = FLEET_KEY;
    }
  });

  it('with ASSISTANT_ACCESS_KEY unset the one key still signs in either kind', async () => {
    env.ASSISTANT_ACCESS_KEY = undefined;
    try {
      expect((await loginWith(FLEET_KEY, 'assistant-sage')).status).toBe(200);
      expect((await loginWith(FLEET_KEY, 'higglehaven6')).status).toBe(200);
    } finally {
      env.ASSISTANT_ACCESS_KEY = ASSISTANT_KEY;
    }
  });
});

describe('What a fleet account cannot do', () => {
  // The shared helpers sign up without any gate credential, so this block runs
  // with the preview gate off; fleet-login still needs (and uses) the key.
  beforeAll(() => { env.ACCESS_PASSPHRASE = undefined; });
  afterAll(() => { env.ACCESS_PASSPHRASE = 'test-access-passphrase'; });

  const withKey = (token, options = {}) => withSession(token, { ...options, headers: { 'x-fleet-key': FLEET_KEY, ...options.headers } });

  async function createTemplate(templateId, seller) {
    const created = await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({
        templateId, name: `Fleet test ${templateId}`, color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, sellerId: seller.sellerId,
      }),
    }));
    expect(created.response.status).toBe(201);
  }

  it('its product flag is recorded but carries zero weight', async () => {
    const seller = await signupSeller('fleet-flag-seller');
    await createTemplate('fleet-flag-template', seller);
    const admin = await signupAdmin('fleet-flag-admin');
    const fleet = await fleetLogin('higglehaven5');
    await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE username = 'higglehaven5'").run();
    const flagged = await api('/catalog/fleet-flag-template/flags', withKey(fleet.token, { method: 'POST', body: JSON.stringify({}) }));
    expect(flagged.body.error ?? null).toBeNull();
    expect(flagged.response.status).toBe(201);
    const listed = await api('/product-flags', admin.session({ headers: { 'x-fleet-key': FLEET_KEY } }));
    const entry = listed.body.listings.find((l) => l.templateId === 'fleet-flag-template');
    expect(entry).toMatchObject({ pendingCount: 1, pendingWeight: 0 });
  });

  it('cannot file a conduct report, even once identity-verified', async () => {
    const target = await signupBuilder('fleet-report-target');
    const fleet = await fleetLogin('higglehaven6');
    await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE username = 'higglehaven6'").run();
    const reported = await api('/voice/report', withKey(fleet.token, {
      method: 'POST', body: JSON.stringify({ reportedBuilderId: target.builderId, reason: 'test' }),
    }));
    expect(reported.response.status).toBe(403);
    expect(reported.body.error).toMatch(/fleet account cannot file a report/);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM voice_conduct_reports').first();
    expect(rows.n).toBe(0);
  });
});

describe('Live-mode guard', () => {
  it('treats only live Stripe keys as live', async () => {
    const { stripeIsLive } = await import('./lib/fleet.js');
    expect(stripeIsLive({ STRIPE_SECRET_KEY: 'sk_live_abc' })).toBe(true);
    expect(stripeIsLive({ STRIPE_SECRET_KEY: 'rk_live_abc' })).toBe(true);
    expect(stripeIsLive({ STRIPE_SECRET_KEY: 'sk_test_abc' })).toBe(false);
    expect(stripeIsLive({})).toBe(false);
  });
});

// #3445 (part of #3444): the name a shopper sees for an assistant.
describe('Fleet assistants: agent names', () => {
  // Like the block above: the shared helpers sign up without a gate
  // credential, so the preview gate is off here; fleet-login still needs the key.
  beforeAll(() => { env.ACCESS_PASSPHRASE = undefined; });
  afterAll(() => { env.ACCESS_PASSPHRASE = 'test-access-passphrase'; });

  async function withMapping(entries, fn) {
    Object.assign(FLEET_AGENT_NAMES, entries);
    try {
      await fn();
    } finally {
      for (const key of Object.keys(entries)) delete FLEET_AGENT_NAMES[key];
    }
  }

  it('fleet-login sets the mapped username and builder label, and applies a rename at the next login', async () => {
    await withMapping({ higglehaven12: 'Test Agent' }, async () => {
      const first = await fleetLogin('higglehaven12');
      expect(first.response.status).toBe(200);
      expect(first.body.user.username).toBe('Test Agent');
      const label = () => env.DB.prepare('SELECT label FROM builders WHERE user_id = ?').bind(first.body.user.userId).first();
      expect((await label()).label).toBe('Test Agent');

      FLEET_AGENT_NAMES.higglehaven12 = 'Renamed Agent';
      const second = await fleetLogin('higglehaven12');
      expect(second.body.user.userId).toBe(first.body.user.userId);
      expect(second.body.user.username).toBe('Renamed Agent');
      expect((await label()).label).toBe('Renamed Agent');
    });
  });

  it('an unmapped session keeps its session name as before', async () => {
    const { body } = await fleetLogin('higglehaven11');
    expect(body.user.username).toBe('higglehaven11');
  });

  it('refuses a mapped name that a regular account already holds', async () => {
    await withMapping({ higglehaven10: 'Held Name' }, async () => {
      await env.DB.prepare(
        "INSERT INTO users (user_id, email, password_hash, username, email_canonical) VALUES ('user-real-held', 'real-held@example.test', 'x', 'Held Name', 'real-held@example.test')",
      ).run();
      const result = await fleetLogin('higglehaven10');
      expect(result.response.status).toBe(409);
      expect(result.token).toBeNull();
    });
  });

  it('signup cannot claim an agent name, in any case, but session names stay open (local mode needs them)', async () => {
    await withMapping({ higglehaven9: 'Reserved Agent' }, async () => {
      for (const username of ['Reserved Agent', 'reserved agent', ' Reserved Agent ']) {
        const result = await api('/auth/signup', {
          method: 'POST',
          headers: ip(),
          body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: 'correct horse battery', username, ageAttested: true }),
        });
        expect(result.response.status, username).toBe(409);
      }
      const sessionName = await api('/auth/signup', {
        method: 'POST',
        headers: ip(),
        body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: 'correct horse battery', username: 'higglehaven2', ageAttested: true }),
      });
      expect(sessionName.response.status).toBe(201);
    });
  });

  it('the owner\'s eleven assistant names are reserved and each has a login of its own', async () => {
    const names = ['Juniper', 'Clover', 'Fig', 'Sorrel', 'Maple', 'Tansy', 'Bramble', 'Moss', 'Basil', 'Fern', 'Sage'];
    expect(Object.values(FLEET_AGENT_NAMES)).toEqual(names);
    for (const name of names) {
      const login = `assistant-${name.toLowerCase()}`;
      expect(FLEET_AGENT_NAMES[login]).toBe(name);
      const signup = await api('/auth/signup', {
        method: 'POST',
        headers: ip(),
        body: JSON.stringify({ email: `${crypto.randomUUID()}@example.test`, password: 'correct horse battery', username: name.toUpperCase(), ageAttested: true }),
      });
      expect(signup.response.status, name).toBe(409);
    }
    const first = await fleetLogin('assistant-juniper');
    expect(first.response.status).toBe(200);
    expect(first.body.user.username).toBe('Juniper');
    const again = await fleetLogin('assistant-juniper');
    expect(again.body.user.userId).toBe(first.body.user.userId);
    // A name that is neither a coding session nor an assistant login is refused.
    expect((await fleetLogin('assistant-nobody')).response.status).toBe(400);
    expect((await fleetLogin('juniper')).response.status).toBe(400);
  });

  it('only an assistant is shown as one: a coding session\'s account is an ordinary avatar in presence', async () => {
    const admin = await signupAdmin('fleet-coding-presence-admin');
    const landletId = 'fleet-coding-presence-landlet';
    await createGreenbeltLandletAs(admin.session, landletId);
    const viewer = await signupBuilder('fleet-coding-presence-viewer');
    const coding = await fleetLogin('higglehaven6');
    const assistant = await fleetLogin('assistant-clover');
    const setPresence = (userIdSql, bind) => env.DB.prepare(`
      INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
      VALUES (${userIdSql}, ?, 0, 0, 0, 0, 0, ?)
      ON CONFLICT (user_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
    `).bind(bind, landletId, new Date().toISOString()).run();
    await setPresence('(SELECT user_id FROM builders WHERE builder_id = ?)', viewer.builderId);
    await setPresence('?', coding.body.user.userId);
    await setPresence('?', assistant.body.user.userId);

    const { body } = await api('/presence', viewer.session());
    const codingAvatar = body.avatars.find((a) => a.userId === coding.body.user.userId);
    const assistantAvatar = body.avatars.find((a) => a.userId === assistant.body.user.userId);
    expect(codingAvatar).toBeDefined();
    expect('assistant' in codingAvatar).toBe(false);
    expect(assistantAvatar.assistant).toEqual({ name: 'Clover', busy: false });
  });

  it('the presence payload carries the assistant flag and name for an assistant account only', async () => {
    const admin = await signupAdmin('fleet-presence-admin');
    const landletId = 'fleet-presence-landlet';
    await createGreenbeltLandletAs(admin.session, landletId);
    const viewer = await signupBuilder('fleet-presence-viewer');
    const other = await signupBuilder('fleet-presence-ordinary');
    const fleet = await fleetLogin('assistant-fig');
    const setPresence = (userIdSql, bind) => env.DB.prepare(`
      INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
      VALUES (${userIdSql}, ?, 0, 0, 0, 0, 0, ?)
      ON CONFLICT (user_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
    `).bind(bind, landletId, new Date().toISOString()).run();
    await setPresence('(SELECT user_id FROM builders WHERE builder_id = ?)', viewer.builderId);
    await setPresence('(SELECT user_id FROM builders WHERE builder_id = ?)', other.builderId);
    await setPresence('?', fleet.body.user.userId);

    const { body } = await api('/presence', viewer.session());
    const fleetAvatar = body.avatars.find((a) => a.userId === fleet.body.user.userId);
    const ordinary = body.avatars.find((a) => a.builderId === other.builderId);
    expect(fleetAvatar.assistant).toEqual({ name: 'Fig', busy: false });
    expect(ordinary).toBeDefined();
    expect('assistant' in ordinary).toBe(false);
  });

  // #3445: nearby chat says who is speaking only when it is an assistant.
  it('nearby chat lines carry the assistant flag for an assistant sender only', async () => {
    const admin = await signupAdmin('fleet-chat-admin');
    const landletId = 'fleet-chat-landlet';
    await createGreenbeltLandletAs(admin.session, landletId);
    const viewer = await signupBuilder('fleet-chat-viewer');
    const other = await signupBuilder('fleet-chat-ordinary');
    const coding = await fleetLogin('higglehaven7');
    const assistant = await fleetLogin('assistant-sorrel');
    const verify = (userIdSql, bind) => env.DB.prepare(`UPDATE users SET trust_tier = 'id_verified' WHERE user_id = ${userIdSql}`).bind(bind).run();
    const setPresence = (userIdSql, bind) => env.DB.prepare(`
      INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
      VALUES (${userIdSql}, ?, 0, 0, 0, 0, 0, ?)
      ON CONFLICT (user_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
    `).bind(bind, landletId, new Date().toISOString()).run();
    const byBuilder = '(SELECT user_id FROM builders WHERE builder_id = ?)';
    await verify(byBuilder, viewer.builderId);
    await verify(byBuilder, other.builderId);
    await verify('?', assistant.body.user.userId);
    await verify('?', coding.body.user.userId);
    await setPresence(byBuilder, viewer.builderId);
    await setPresence(byBuilder, other.builderId);
    await setPresence('?', assistant.body.user.userId);
    await setPresence('?', coding.body.user.userId);

    const say = (token, text) => fleetFetch('/api/nearby-chat', {
      method: 'POST', key: FLEET_KEY, body: JSON.stringify({ text }),
      headers: { cookie: `hh_session=${token}` },
    });
    // The assistant and the coding session speak through their own sessions;
    // the ordinary shopper through the standard test helper.
    expect((await say(assistant.token, 'Hello, I can help.')).status).toBe(201);
    expect((await say(coding.token, 'coding session line')).status).toBe(201);
    expect((await api('/nearby-chat', other.session({ method: 'POST', body: JSON.stringify({ text: 'shopper line' }) }))).response.status).toBe(201);

    const { body } = await api('/nearby-chat', viewer.session());
    const line = (text) => body.messages.find((m) => m.text === text);
    expect(line('Hello, I can help.').assistant).toEqual({ name: 'Sorrel' });
    expect('assistant' in line('coding session line')).toBe(false);
    expect('assistant' in line('shopper line')).toBe(false);
  });
});

// #3449 (part of #3444): an assistant is in the world while its heartbeat is fresh.
describe('Assistant shifts', () => {
  beforeAll(() => { env.ACCESS_PASSPHRASE = undefined; });
  async function greenbelt() {
    const { results } = await env.DB.prepare(
      "SELECT landlet_id, center_x_m, center_y_m, elevation_m FROM landlets WHERE status = 'greenbelt'",
    ).all();
    return results;
  }
  const beat = (token, body = {}) => fleetFetch('/api/assistant/heartbeat', {
    method: 'POST', key: FLEET_KEY, headers: { cookie: `hh_session=${token}` }, body: JSON.stringify(body),
  });
  async function viewerOn(landletId, name) {
    const viewer = await signupBuilder(name);
    await env.DB.prepare(`
      INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
      VALUES ((SELECT user_id FROM builders WHERE builder_id = ?), ?, 0, 0, 0, 0, 0, ?)
    `).bind(viewer.builderId, landletId, new Date().toISOString()).run();
    return viewer;
  }

  it('a fresh heartbeat shows the assistant with its name and free/busy; a lapsed one removes it', async () => {
    const admin = await signupAdmin('shift-admin');
    await createGreenbeltLandletAs(admin.session, 'shift-landlet');
    const login = await fleetLogin('assistant-juniper');
    expect((await beat(login.token, { busy: true })).status).toBe(200);
    const spot = assistantSpot('Juniper', await greenbelt());
    const viewer = await viewerOn(spot.landletId, 'shift-viewer');
    let { body } = await api('/presence', viewer.session());
    let found = body.avatars.find((a) => a.userId === login.body.user.userId);
    expect(found.assistant).toEqual({ name: 'Juniper', busy: true });
    expect(found.landletId).toBe(spot.landletId);

    // busy omitted keeps the last value; false clears it.
    await beat(login.token);
    ({ body } = await api('/presence', viewer.session()));
    expect(body.avatars.find((a) => a.userId === login.body.user.userId).assistant.busy).toBe(true);
    await beat(login.token, { busy: false });
    ({ body } = await api('/presence', viewer.session()));
    expect(body.avatars.find((a) => a.userId === login.body.user.userId).assistant.busy).toBe(false);

    const old = new Date(Date.now() - ASSISTANT_SHIFT_STALE_AFTER_MS - 1000).toISOString();
    await env.DB.prepare('UPDATE assistant_shifts SET last_seen_at = ? WHERE user_id = ?').bind(old, login.body.user.userId).run();
    ({ body } = await api('/presence', viewer.session()));
    expect(body.avatars.find((a) => a.userId === login.body.user.userId)).toBeUndefined();
  });

  it('only an assistant account may send a heartbeat; a coding session or a shopper is refused and never appears', async () => {
    const coding = await fleetLogin('higglehaven7');
    expect((await beat(coding.token)).status).toBe(403);
    const shopper = await signupBuilder('shift-shopper');
    const response = await beat(shopper.sessionToken);
    expect(response.status).toBe(403);
    const row = await env.DB.prepare('SELECT 1 AS n FROM assistant_shifts WHERE user_id = ?').bind(coding.body.user.userId).first();
    expect(row).toBeNull();
  });

  it('an on-shift assistant is not shown on a landlet other than its spot', async () => {
    const admin = await signupAdmin('shift-admin-2');
    await createGreenbeltLandletAs(admin.session, 'shift-landlet-a', { x: 500, y: 500 });
    await createGreenbeltLandletAs(admin.session, 'shift-landlet-b', { x: 900, y: 900 });
    const login = await fleetLogin('assistant-clover');
    await beat(login.token);
    const spot = assistantSpot('Clover', await greenbelt());
    const other = (await greenbelt()).find((l) => l.landlet_id !== spot.landletId);
    const viewer = await viewerOn(other.landlet_id, 'shift-viewer-2');
    const { body } = await api('/presence', viewer.session());
    expect(body.avatars.find((a) => a.userId === login.body.user.userId)).toBeUndefined();
  });
});
