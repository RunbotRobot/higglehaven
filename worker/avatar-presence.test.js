import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import { api, signupBuilder, signupAdmin, createGreenbeltLandletAs } from './test-helpers.js';

// #1098 (sub-issue of #1095, multiplayer presence): POST /api/presence
// upserts the caller's own live position into avatar_presence
// (#1097/migrations/0100_avatar_presence.sql).

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('presence-shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}

// #3147: avatar_presence is keyed on the account; tests still hold builder ids.
async function presenceRow(builderId) {
  return env.DB.prepare('SELECT * FROM avatar_presence WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)')
    .bind(builderId).first();
}

describe('POST /api/presence', () => {
  it('requires a real session', async () => {
    const unauthenticated = await api('/presence', {
      method: 'POST', body: JSON.stringify({ x: 1, y: 2, z: 0 }),
    });
    expect(unauthenticated.response.status).toBe(401);
  });

  it('rejects non-finite coordinates', async () => {
    const builder = await signupBuilder('presence-invalid-coords');
    const missingX = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ y: 2, z: 0 }),
    }));
    expect(missingX.response.status).toBe(400);

    const nonFiniteHeading = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 1, y: 2, z: 0, heading: 'north' }),
    }));
    expect(nonFiniteHeading.response.status).toBe(400);
  });

  it('upserts the caller\'s own row — a second report updates it in place rather than duplicating it', async () => {
    const builder = await signupBuilder('presence-upsert');

    const first = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 1, y: 2, z: 3, heading: 0.5 }),
    }));
    expect(first.response.status).toBe(200);
    expect(first.body.presence).toMatchObject({ x: 1, y: 2, z: 3, heading: 0.5, landletId: null });

    const second = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 10, y: 20, z: 30, heading: 1.5 }),
    }));
    expect(second.response.status).toBe(200);
    expect(second.body.presence).toMatchObject({ x: 10, y: 20, z: 30, heading: 1.5 });

    // Exactly one row for this builder — the second report replaced the
    // first rather than adding a second one.
    const { results } = await env.DB.prepare(
      'SELECT * FROM avatar_presence WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)',
    ).bind(builder.builderId).all();
    expect(results.length).toBe(1);
    expect(results[0].x).toBe(10);
  });

  // #2492: not found here means a concurrent account deletion (cascadeDeleteAccount
  // removes the row explicitly since #3147; it used to be migrations/0100's own
  // ON DELETE CASCADE on builder_id) landed in the single await gap
  // between the upsert and this handler's own re-SELECT -- same race shape
  // #2334/#2354/#2391/#2428/#2429 already cover elsewhere, previously an
  // uncaught null-dereference crash instead of a clean 404. Same
  // env.DB.prepare hijack idiom as other POST-then-reselect race tests in
  // this suite, targeting the exact re-SELECT SQL (the only call site in
  // this file matching this exact string).
  it('defensive: a write that returns no row is a clean 404, not a raw 500', async () => {
    // #3464: the upsert and the re-read are one INSERT ... RETURNING statement
    // now, so the old race this test was written for (a deletion landing
    // between the two, #2492) can no longer happen, and this fallback is
    // effectively unreachable in practice. It stays as defensive coverage of
    // the null-row branch only: it does NOT prove the race is handled, it
    // proves that if the statement ever returned nothing the caller would get
    // the same clean 404. Same env.DB.prepare hijack idiom as the other
    // POST-then-reselect tests in this suite, swapping the write for a
    // statement that returns no row (it keeps the eight bound parameters the
    // real one takes).
    const builder = await signupBuilder('presence-post-reselect-race');

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO avatar_presence') && sql.includes('RETURNING')) {
        armed = false;
        return originalPrepare('SELECT * FROM avatar_presence WHERE 0 AND ?1 IS ?2 AND ?3 IS ?4 AND ?5 IS ?6 AND ?7 IS NULL AND ?8 IS NULL');
      }
      return originalPrepare(sql);
    };
    let reported;
    try {
      reported = await api('/presence', builder.session({
        method: 'POST', body: JSON.stringify({ x: 1, y: 2, z: 3 }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(reported.response.status).toBe(404);
    expect(reported.body.error).toMatch(/deleted concurrently/i);
  });

  it('heading is optional and stored as null when omitted', async () => {
    const builder = await signupBuilder('presence-no-heading');
    const reported = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0 }),
    }));
    expect(reported.response.status).toBe(200);
    expect(reported.body.presence.heading).toBeNull();
  });

  // #2043: docs/SPEC.md's "Flying avatars are invisible to other users" --
  // this is the write side; GET /presence (worker/presence.test.js) is
  // where it's actually withheld from other viewers.
  it('flying is optional, defaults to false, and is stored/returned as a real boolean', async () => {
    const builder = await signupBuilder('presence-flying-default');
    const defaulted = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0 }),
    }));
    expect(defaulted.response.status).toBe(200);
    expect(defaulted.body.presence.flying).toBe(false);

    const flying = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0, flying: true }),
    }));
    expect(flying.response.status).toBe(200);
    expect(flying.body.presence.flying).toBe(true);
    const row = await presenceRow(builder.builderId);
    expect(row.flying).toBe(1);

    const landedAgain = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0, flying: false }),
    }));
    expect(landedAgain.response.status).toBe(200);
    expect(landedAgain.body.presence.flying).toBe(false);
  });

  // #4390: the AFK bit (a person standing still too long) travels the same way flying does.
  it('afk is optional, defaults to false, and is stored/returned as a real boolean', async () => {
    const builder = await signupBuilder('presence-afk');
    const defaulted = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0 }),
    }));
    expect(defaulted.body.presence.afk).toBe(false);
    const away = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0, afk: true }),
    }));
    expect(away.response.status).toBe(200);
    expect(away.body.presence.afk).toBe(true);
    expect((await presenceRow(builder.builderId)).afk).toBe(1);
    const back = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0, afk: false }),
    }));
    expect(back.body.presence.afk).toBe(false);
  });

  it('accepts a real landletId and stores it on the row', async () => {
    const builder = await signupBuilder('presence-real-landlet');
    await createGreenbeltLandlet('presence-real-landlet-id');

    const reported = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 5, y: 5, z: 0, landletId: 'presence-real-landlet-id' }),
    }));
    expect(reported.response.status).toBe(200);
    expect(reported.body.presence.landletId).toBe('presence-real-landlet-id');

    const row = await presenceRow(builder.builderId);
    expect(row.landlet_id).toBe('presence-real-landlet-id');
  });

  // The cheap spoof guard from #1098's own scope — a landletId that
  // doesn't correspond to any real landlet is rejected outright, rather
  // than silently stored for #1099's GET to later scope a query by.
  it('rejects a landletId that does not correspond to a real landlet', async () => {
    const builder = await signupBuilder('presence-fake-landlet');
    const reported = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0, landletId: 'no-such-landlet' }),
    }));
    expect(reported.response.status).toBe(404);
  });

  // Same direct-table-seeding approach as the instance-write/auction-start
  // rate-limit tests (worker/land.test.js, worker/commerce.test.js) —
  // looping 600 real HTTP calls to actually exhaust the window would be
  // needlessly slow for the same assertion.
  it('rate-limits repeated position reports from the same builder', async () => {
    const builder = await signupBuilder('presence-rate-limit');
    const bucketKey = `presence-report:${(await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builder.builderId).first()).user_id}`;
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO rate_limit_counters (bucket_key, window_start, count) VALUES (?, ?, 1499)',
    ).bind(bucketKey, Math.floor(now / (15 * 60 * 1000)) * 15 * 60 * 1000).run();

    const atLimit = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 1, y: 1, z: 1 }),
    }));
    expect(atLimit.response.status).toBe(200);

    const limited = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 2, y: 2, z: 2 }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // GET /api/presence is a real, separate endpoint (#1099) — only an
  // actually-unsupported method is a 404 here.
  it('404s on an unsupported method', async () => {
    const builder = await signupBuilder('presence-bad-route');
    const deleteAttempt = await api('/presence', builder.session({ method: 'DELETE' }));
    expect(deleteAttempt.response.status).toBe(404);
  });
});
