// #3464: POST and GET /api/presence run once a second per person in the world,
// and each awaited D1 round trip is about 75-100 ms of that request. Pins what
// this route itself does with D1 (which statements, in which trips), not the
// totals: the session, builder, equipped-avatar and on-shift lookups belong to
// other code and may change without this file having an opinion. Also pins
// that the answers did not change when the trips were cut.
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

// Records every statement the handler sends to D1, in order: a statement run on
// its own is one trip, and a db.batch() is one trip carrying several. `log` has a
// 'start' and an 'end' entry per standalone statement so overlap can be read.
function recordingDb(real) {
  const sqlOf = new WeakMap();
  const log = [];
  const wrapStatement = (stmt, sql) => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'bind') return (...args) => wrapStatement(target.bind(...args), sql);
        if (['first', 'run', 'all', 'raw'].includes(prop)) {
          return async (...args) => {
            log.push({ phase: 'start', kind: 'single', sql });
            try { return await target[prop](...args); } finally { log.push({ phase: 'end', kind: 'single', sql }); }
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    sqlOf.set(proxy, { stmt, sql });
    return proxy;
  };
  const db = {
    prepare: (sql) => wrapStatement(real.prepare(sql), sql),
    batch: async (statements) => {
      log.push({ phase: 'start', kind: 'batch', sqls: statements.map((st) => sqlOf.get(st)?.sql ?? '') });
      try { return await real.batch(statements.map((st) => sqlOf.get(st)?.stmt ?? st)); } finally {
        log.push({ phase: 'end', kind: 'batch' });
      }
    },
  };
  const singles = () => log.filter((entry) => entry.phase === 'start' && entry.kind === 'single').map((entry) => entry.sql);
  const batches = () => log.filter((entry) => entry.phase === 'start' && entry.kind === 'batch').map((entry) => entry.sqls);
  return { db, log, singles, batches };
}

const count = (sqls, pattern) => sqls.filter((sql) => pattern.test(sql)).length;

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

async function userIdOf(builder) {
  return (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builder.builderId).first()).user_id;
}

describe('POST /api/presence round trips (#3464)', () => {
  it('the guard, the write and the read-back are one statement, with or without a lándlet', async () => {
    const landletId = `presence-trips-landlet-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const noLandlet = await signupBuilder('presence-trips-post');
    const onLandlet = await signupBuilder('presence-trips-post-landlet');

    for (const [builder, body] of [
      [noLandlet, { x: 1, y: 2, z: 3, heading: 0.5 }],
      [onLandlet, { x: 4, y: 5, z: 6, landletId, flying: true }],
    ]) {
      const { db, singles } = recordingDb(env.DB);
      const response = await callPresence(db, postInit(builder, body));
      expect(response.status).toBe(200);
      const written = (await response.json()).presence;
      expect(written).toMatchObject({ landletId: body.landletId ?? null, x: body.x, y: body.y, z: body.z, flying: body.flying === true });
      expect(written.updatedAt).toBeTruthy();
      const sqls = singles();
      expect(count(sqls, /INSERT INTO avatar_presence/)).toBe(1);
      // the separate existence read and the separate re-read are gone
      expect(count(sqls, /^\s*SELECT \* FROM landlets/)).toBe(0);
      expect(count(sqls, /^\s*SELECT \* FROM avatar_presence/)).toBe(0);
    }
  });

  it('a lándlet that does not exist is still the same 404 and writes nothing', async () => {
    const builder = await signupBuilder('presence-trips-post-bogus');
    const first = await api('/presence', postInit(builder, { x: 1, y: 1, z: 1 }));
    expect(first.response.status).toBe(200);
    const userId = first.body.presence.userId;
    const before = await env.DB.prepare('SELECT * FROM avatar_presence WHERE user_id = ?').bind(userId).first();
    const { db } = recordingDb(env.DB);
    await expect(callPresence(db, postInit(builder, { x: 9, y: 9, z: 9, landletId: 'no-such-landlet' })))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('not found') });
    const after = await env.DB.prepare('SELECT * FROM avatar_presence WHERE user_id = ?').bind(userId).first();
    expect(after).toEqual(before);
  });

  it('a second report replaces the first row rather than adding one', async () => {
    const builder = await signupBuilder('presence-trips-post-twice');
    const one = await api('/presence', postInit(builder, { x: 1, y: 1, z: 1 }));
    const two = await api('/presence', postInit(builder, { x: 7, y: 8, z: 9 }));
    expect(two.response.status).toBe(200);
    expect(two.body.presence).toMatchObject({ userId: one.body.presence.userId, x: 7, y: 8, z: 9 });
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM avatar_presence WHERE user_id = ?').bind(one.body.presence.userId).first();
    expect(rows.n).toBe(1);
  });
});

describe('GET /api/presence round trips (#3464)', () => {
  it('the rate-limit insert and the own-row read share one batch; the answer is unchanged', async () => {
    const landletId = `presence-trips-nearby-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const me = await signupBuilder('presence-trips-me');
    const other = await signupBuilder('presence-trips-other');
    const blocked = await signupBuilder('presence-trips-blocked');
    await api('/presence', postInit(me, { x: 0, y: 0, z: 0, landletId }));
    await api('/presence', postInit(other, { x: 1, y: 1, z: 1, landletId }));
    await api('/presence', postInit(blocked, { x: 2, y: 2, z: 2, landletId }));
    const block = await api('/blocks', me.session({ method: 'POST', body: JSON.stringify({ builderId: blocked.builderId }) }));
    expect(block.response.status).toBe(201);

    const { db, log, singles, batches } = recordingDb(env.DB);
    const response = await callPresence(db, me.session());
    expect(response.status).toBe(200);
    // a blocked person stays absent, exactly as before
    expect((await response.json()).avatars.map((avatar) => avatar.builderId)).toEqual([other.builderId]);

    const sqls = singles();
    // exactly one batch carries the rate-limit insert and the caller's own row...
    const carrying = batches().filter((group) => group.some((sql) => /INSERT INTO rate_limit_events/.test(sql)));
    expect(carrying).toHaveLength(1);
    expect(carrying[0].some((sql) => /FROM avatar_presence WHERE user_id = \?/.test(sql))).toBe(true);
    // ...so neither is a trip of its own any more
    expect(count(sqls, /INSERT INTO rate_limit_events/)).toBe(0);
    expect(count(sqls, /^\s*SELECT landlet_id, updated_at FROM avatar_presence/)).toBe(0);

    // the on-shift read is sent before the nearby read has come back (one
    // trip window, not two in a row)
    const nearbyEnd = log.findIndex((entry) => entry.phase === 'end' && /JOIN builders ON builders\.user_id = avatar_presence\.user_id/.test(entry.sql ?? ''));
    const shiftStart = log.findIndex((entry) => entry.phase === 'start' && /assistant_shifts/.test(entry.sql ?? ''));
    expect(nearbyEnd).toBeGreaterThan(-1);
    expect(shiftStart).toBeGreaterThan(-1);
    expect(shiftStart).toBeLessThan(nearbyEnd);
  });

  it('nowhere recent enough: nothing nearby, and the attempt is still counted against that caller', async () => {
    const stranger = await signupBuilder('presence-trips-nowhere');
    const bucket = `presence-nearby:${await userIdOf(stranger)}`;
    const { db } = recordingDb(env.DB);
    const response = await callPresence(db, stranger.session());
    expect((await response.json()).avatars).toEqual([]);
    const spent = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket_key = ?').bind(bucket).first();
    expect(spent.n).toBe(1);
  });

  it('an over-limit caller gets the 429 before any nearby read', async () => {
    const landletId = `presence-trips-limit-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const capped = await signupBuilder('presence-trips-capped');
    await api('/presence', postInit(capped, { x: 0, y: 0, z: 0, landletId }));
    const bucket = `presence-nearby:${await userIdOf(capped)}`;
    const now = Date.now();
    // the whole window's budget (PRESENCE_NEARBY_RATE_LIMIT_MAX = 600), spent
    await env.DB.batch(Array.from({ length: 600 }, () => env.DB
      .prepare('INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)').bind(bucket, now)));

    const { db, singles } = recordingDb(env.DB);
    await expect(callPresence(db, capped.session())).rejects.toMatchObject({ status: 429 });
    expect(count(singles(), /JOIN builders ON builders\.user_id = avatar_presence\.user_id/)).toBe(0);
    const stillOnly = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket_key = ?').bind(bucket).first();
    expect(stillOnly.n).toBe(600);
  });
});
