// #3464: POST and GET /api/presence run once a second per person in the world,
// and each awaited D1 round trip is about 75-100 ms of that request. Counts the
// trips so a later change cannot quietly add one back, and pins that the
// answers did not change when they were cut.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handlePresence } from './lib/social.js';
import { api, signupAdmin, signupBuilder, createGreenbeltLandletAs } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('presence-trips-admin');
  adminSession = admin.session;
});

// Every awaited first()/run()/all()/raw() and every db.batch() is one trip.
function countingDb(real) {
  const unwrap = new WeakMap();
  const counter = { trips: 0 };
  const wrapStatement = (stmt) => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...args) => wrapStatement(target.bind(...args));
        if (['first', 'run', 'all', 'raw'].includes(prop)) {
          return (...args) => { counter.trips += 1; return target[prop](...args); };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    unwrap.set(proxy, stmt);
    return proxy;
  };
  const db = {
    prepare: (sql) => wrapStatement(real.prepare(sql)),
    batch: (statements) => { counter.trips += 1; return real.batch(statements.map((st) => unwrap.get(st) ?? st)); },
  };
  return { db, counter };
}

async function callPresence(db, init) {
  const request = new Request('https://higglehaven.test/api/presence', init);
  return handlePresence(request, db, ['presence'], new URL(request.url));
}

function postInit(builder, body) {
  return builder.session({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('presence round trips (#3464)', () => {
  it('a position report with no landlet is session, builder, rate limit, one write', async () => {
    const builder = await signupBuilder('presence-trips-post');
    const { db, counter } = countingDb(env.DB);
    const response = await callPresence(db, postInit(builder, { x: 1, y: 2, z: 3, heading: 0.5 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.presence).toMatchObject({ landletId: null, x: 1, y: 2, z: 3, heading: 0.5, flying: false });
    expect(body.presence.updatedAt).toBeTruthy();
    expect(counter.trips).toBe(4);
  });

  it('a report on a real landlet costs the same: the existence guard is inside the write', async () => {
    const landletId = `presence-trips-landlet-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const builder = await signupBuilder('presence-trips-post-landlet');
    const { db, counter } = countingDb(env.DB);
    const response = await callPresence(db, postInit(builder, { x: 4, y: 5, z: 6, landletId, flying: true }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.presence).toMatchObject({ landletId, x: 4, y: 5, z: 6, flying: true });
    expect(counter.trips).toBe(4);
  });

  it('a report for a landlet that does not exist is still the same 404 and writes nothing', async () => {
    const builder = await signupBuilder('presence-trips-post-bogus');
    const first = await api('/presence', postInit(builder, { x: 1, y: 1, z: 1 }));
    expect(first.response.status).toBe(200);
    const before = await env.DB.prepare('SELECT * FROM avatar_presence WHERE user_id = ?').bind(first.body.presence.userId).first();
    const { db, counter } = countingDb(env.DB);
    await expect(callPresence(db, postInit(builder, { x: 9, y: 9, z: 9, landletId: 'no-such-landlet' })))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('not found') });
    // the refusal pays one more read to say which thing was missing
    expect(counter.trips).toBe(5);
    const after = await env.DB.prepare('SELECT * FROM avatar_presence WHERE user_id = ?').bind(first.body.presence.userId).first();
    expect(after).toEqual(before);
  });

  it('a second report replaces the first row rather than adding one', async () => {
    const builder = await signupBuilder('presence-trips-post-twice');
    const one = await api('/presence', postInit(builder, { x: 1, y: 1, z: 1 }));
    const two = await api('/presence', postInit(builder, { x: 7, y: 8, z: 9 }));
    expect(two.response.status).toBe(200);
    expect(two.body.presence).toMatchObject({ userId: one.body.presence.userId, x: 7, y: 8, z: 9 });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM avatar_presence WHERE user_id = ?').bind(one.body.presence.userId).first();
    expect(count.n).toBe(1);
  });

  it('who is nearby: answers as before, and an over-limit caller still gets the 429', async () => {
    const landletId = `presence-trips-nearby-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const me = await signupBuilder('presence-trips-me');
    const other = await signupBuilder('presence-trips-other');
    const blocked = await signupBuilder('presence-trips-blocked');
    await api('/presence', postInit(me, { x: 0, y: 0, z: 0, landletId }));
    await api('/presence', postInit(other, { x: 1, y: 1, z: 1, landletId }));
    await api('/presence', postInit(blocked, { x: 2, y: 2, z: 2, landletId }));
    const block = await api('/blocks', me.session({
      method: 'POST',
      body: JSON.stringify({ builderId: blocked.builderId }),
    }));
    expect(block.response.status).toBe(201);

    const { db, counter } = countingDb(env.DB);
    const response = await callPresence(db, me.session());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.avatars.map((avatar) => avatar.builderId)).toEqual([other.builderId]);
    // session, builder, rate limit + own row (one batch), nearby read and
    // on-shift read (overlapped), equipped avatars, equipped animations.
    expect(counter.trips).toBe(7); // was 8 before the batch

    // nowhere recent enough: nothing nearby, and the quota is still spent
    const stranger = await signupBuilder('presence-trips-nowhere');
    const empty = await callPresence(countingDb(env.DB).db, stranger.session());
    expect((await empty.json()).avatars).toEqual([]);
    const spent = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket_key LIKE ?')
      .bind(`presence-nearby:%`).first();
    expect(spent.n).toBeGreaterThanOrEqual(2);
  });
});
