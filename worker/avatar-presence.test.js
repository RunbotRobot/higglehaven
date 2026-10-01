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

async function presenceRow(builderId) {
  return env.DB.prepare('SELECT * FROM avatar_presence WHERE builder_id = ?').bind(builderId).first();
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
      'SELECT * FROM avatar_presence WHERE builder_id = ?',
    ).bind(builder.builderId).all();
    expect(results.length).toBe(1);
    expect(results[0].x).toBe(10);
  });

  it('heading is optional and stored as null when omitted', async () => {
    const builder = await signupBuilder('presence-no-heading');
    const reported = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 0, y: 0, z: 0 }),
    }));
    expect(reported.response.status).toBe(200);
    expect(reported.body.presence.heading).toBeNull();
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
    const bucketKey = `presence-report:${builder.builderId}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 599 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 1, y: 1, z: 1 }),
    }));
    expect(atLimit.response.status).toBe(200);

    const limited = await api('/presence', builder.session({
      method: 'POST', body: JSON.stringify({ x: 2, y: 2, z: 2 }),
    }));
    expect(limited.response.status).toBe(429);
  });

  it('404s on an unsupported method/path shape', async () => {
    const builder = await signupBuilder('presence-bad-route');
    const getAttempt = await api('/presence', builder.session({ method: 'GET' }));
    expect(getAttempt.response.status).toBe(404);
  });
});
