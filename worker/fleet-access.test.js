import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, extractSessionCookie, withSession, signupBuilder, signupSeller, signupAdmin, createGreenbeltLandletAs } from './test-helpers.js';
import { FLEET_AGENT_NAMES } from './lib/fleet-agents.js';

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

  it('creates the account once, then signs in the same one; the session works', async () => {
    const first = await fleetLogin('higglehaven3');
    expect(first.response.status).toBe(200);
    expect(first.token).toBeTruthy();
    const second = await fleetLogin('higglehaven3');
    expect(second.body.user.userId).toBe(first.body.user.userId);
    const rows = await env.DB.prepare("SELECT user_id, is_fleet, email_verified_at, is_admin FROM users WHERE username = 'higglehaven3'").all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ is_fleet: 1, is_admin: 0 });
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

  it('the presence payload carries the assistant flag and name for a fleet account only', async () => {
    const admin = await signupAdmin('fleet-presence-admin');
    const landletId = 'fleet-presence-landlet';
    await createGreenbeltLandletAs(admin.session, landletId);
    const viewer = await signupBuilder('fleet-presence-viewer');
    const other = await signupBuilder('fleet-presence-ordinary');
    const fleet = await withMappingResult({ higglehaven8: 'Presence Agent' }, () => fleetLogin('higglehaven8'));
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
    expect(fleetAvatar.assistant).toEqual({ name: 'Presence Agent' });
    expect(ordinary).toBeDefined();
    expect('assistant' in ordinary).toBe(false);
  });
});

async function withMappingResult(entries, fn) {
  Object.assign(FLEET_AGENT_NAMES, entries);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(entries)) delete FLEET_AGENT_NAMES[key];
  }
}
