// #1994 (sub-issue of #1976, "Orb-collection mechanic to ration free
// video-to-3D generation credits within a hard $5/day budget"): covers
// the data model + spawn-cadence + read-endpoint scope of this sub-issue
// -- spawnCreditOrbIfDue (called from scheduled() on the existing cron)
// and GET /api/credit-orbs. Rendering/proximity-collection is #1995's own
// scope, not this file's.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnCreditOrbIfDue } from './index.js';
import { api } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// spawnCreditOrbIfDue's "is one due" check reads the most recent
// spawned_at across the whole credit_orbs table (its own "last spawn
// time" anchor, see its own comment in worker/index.js) -- every test
// below needs a clean table to reason about independently of whatever an
// earlier test in this file left behind, the same way other D1-backed
// test files isolate state across tests sharing one instance.
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM credit_orbs').run();
  await env.DB.prepare("UPDATE landlets SET status = 'claimed' WHERE status = 'greenbelt'").run();
});

let idCounter = 0;

async function seedLandlet(status) {
  idCounter += 1;
  const landletId = `credit-orb-landlet-${idCounter}`;
  await env.DB.prepare(
    'INSERT INTO landlets (landlet_id, name, status) VALUES (?, ?, ?)',
  ).bind(landletId, landletId, status).run();
  return landletId;
}

async function seedOrb(landletId, { collected = false, spawnedAgeMs = 0 } = {}) {
  idCounter += 1;
  const orbId = `credit-orb-test-${idCounter}`;
  const spawnedAt = new Date(Date.now() - spawnedAgeMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m, z_m, spawned_at, collected_at)
    VALUES (?, ?, 0, 0, 0, ?, ?)
  `).bind(orbId, landletId, spawnedAt, collected ? spawnedAt : null).run();
  return orbId;
}

describe('spawnCreditOrbIfDue (#1994)', () => {
  it('spawns a first orb into a greenbelt landlet when none exist yet', async () => {
    const greenbelt = await seedLandlet('greenbelt');

    await spawnCreditOrbIfDue(env.DB);

    const row = await env.DB.prepare('SELECT landlet_id FROM credit_orbs').first();
    expect(row).toBeTruthy();
    expect(row.landlet_id).toBe(greenbelt);
  });

  it('does not spawn a second orb before the spawn interval has elapsed', async () => {
    const greenbelt = await seedLandlet('greenbelt');
    await seedOrb(greenbelt, { spawnedAgeMs: 1000 }); // 1 second old -- nowhere near due

    await spawnCreditOrbIfDue(env.DB);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM credit_orbs').first();
    expect(count.n).toBe(1); // only the seeded row, nothing new from the call
  });

  it('spawns a new orb once the interval has elapsed since the last one', async () => {
    const existing = await seedLandlet('greenbelt');
    await seedOrb(existing, { spawnedAgeMs: 365 * 24 * 60 * 60 * 1000 }); // a year old -- certainly due

    await spawnCreditOrbIfDue(env.DB);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM credit_orbs').first();
    expect(count.n).toBe(2);
  });

  it('is a no-op when there is no greenbelt landlet to spawn into', async () => {
    await seedLandlet('claimed');

    await spawnCreditOrbIfDue(env.DB);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM credit_orbs').first();
    expect(count.n).toBe(0);
  });

  it('two concurrent calls never both spawn (race-proofed the same as reserveVideoGenerationJob)', async () => {
    await seedLandlet('greenbelt');

    await Promise.all([spawnCreditOrbIfDue(env.DB), spawnCreditOrbIfDue(env.DB)]);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM credit_orbs').first();
    expect(count.n).toBe(1);
  });
});

describe('GET /api/credit-orbs (#1994)', () => {
  it('lists an active orb and leaves out a collected one, with no auth required', async () => {
    const landlet = await seedLandlet('greenbelt');
    const activeOrbId = await seedOrb(landlet);
    const collectedOrbId = await seedOrb(landlet, { collected: true });

    const { response, body } = await api('/credit-orbs');
    expect(response.status).toBe(200);
    const orbIds = body.orbs.map((orb) => orb.orbId);
    expect(orbIds).toContain(activeOrbId);
    expect(orbIds).not.toContain(collectedOrbId);
    const active = body.orbs.find((orb) => orb.orbId === activeOrbId);
    expect(active.landletId).toBe(landlet);
    expect(typeof active.x).toBe('number');
    expect(typeof active.spawnedAt).toBe('string');
  });

  it('scopes to one landlet via ?landletId=', async () => {
    const landletA = await seedLandlet('greenbelt');
    const landletB = await seedLandlet('greenbelt');
    const orbA = await seedOrb(landletA);
    const orbB = await seedOrb(landletB);

    const { body } = await api(`/credit-orbs?landletId=${encodeURIComponent(landletA)}`);
    const orbIds = body.orbs.map((orb) => orb.orbId);
    expect(orbIds).toContain(orbA);
    expect(orbIds).not.toContain(orbB);
  });

  it('404s on an unrelated sub-path', async () => {
    const { response } = await api('/credit-orbs/not-a-real-path');
    expect(response.status).toBe(404);
  });
});
