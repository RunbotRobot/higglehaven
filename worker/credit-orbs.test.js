// #1994 (sub-issue of #1976, "Orb-collection mechanic to ration free
// video-to-3D generation credits within a hard $5/day budget"): covers
// the data model + spawn-cadence + read-endpoint scope of this sub-issue
// -- spawnCreditOrbIfDue (called from scheduled() on the existing cron)
// and GET /api/credit-orbs. Rendering/proximity-collection is #1995's own
// scope, not this file's.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnCreditOrbIfDue } from './index.js';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

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

// Non-zero default center so a test that gets the orb's landlet-local x_m/
// y_m confused with its own world position (what #2222's own collect fix
// has to convert between) fails loudly instead of accidentally passing --
// landlets.center_x_m/center_y_m both default to 0 in the schema, which
// would silently paper over exactly that bug.
const DEFAULT_LANDLET_CENTER_X = 1000;
const DEFAULT_LANDLET_CENTER_Y = -500;

async function seedLandlet(status, { centerX = DEFAULT_LANDLET_CENTER_X, centerY = DEFAULT_LANDLET_CENTER_Y } = {}) {
  idCounter += 1;
  const landletId = `credit-orb-landlet-${idCounter}`;
  await env.DB.prepare(
    'INSERT INTO landlets (landlet_id, name, status, center_x_m, center_y_m) VALUES (?, ?, ?, ?, ?)',
  ).bind(landletId, landletId, status, centerX, centerY).run();
  return landletId;
}

async function seedOrb(landletId, { collected = false, spawnedAgeMs = 0, x = 0, y = 0 } = {}) {
  idCounter += 1;
  const orbId = `credit-orb-test-${idCounter}`;
  const spawnedAt = new Date(Date.now() - spawnedAgeMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m, z_m, spawned_at, collected_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).bind(orbId, landletId, x, y, spawnedAt, collected ? spawnedAt : null).run();
  return orbId;
}

// #2222: collect now requires a fresh, nearby avatar_presence row (same
// table/shape #1098's real POST /presence writes) -- seeds one directly,
// the same "insert the state a real write would have produced" shortcut
// presence.test.js's own setPresence already uses. Takes a WORLD position
// (matching what a real client reports), not a landlet-local one --
// deliberately no landletId param, since the collect check doesn't use
// one either (see worker/index.js's own comment on why).
async function seedPresence(builderId, { x = 0, y = 0, ageMs = 0 } = {}) {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO avatar_presence (builder_id, landlet_id, x, y, z, heading, updated_at)
    VALUES (?, NULL, ?, ?, 0, 0, ?)
    ON CONFLICT (builder_id) DO UPDATE SET
      x = excluded.x, y = excluded.y, updated_at = excluded.updated_at
  `).bind(builderId, x, y, updatedAt).run();
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

describe('POST /api/credit-orbs (admin seed fixture, #1995)', () => {
  it('requires admin', async () => {
    const landlet = await seedLandlet('greenbelt');
    const builder = await signupBuilder('orb-seed-non-admin');
    const { response } = await api('/credit-orbs', builder.session({
      method: 'POST',
      body: JSON.stringify({ landletId: landlet }),
    }));
    expect(response.status).toBe(403);
  });

  it('seeds an orb into the given landlet at the given position, listed by GET', async () => {
    const landlet = await seedLandlet('greenbelt');
    const admin = await signupAdmin('orb-seed-admin');
    const { response, body } = await api('/credit-orbs', admin.session({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ landletId: landlet, x: 3.5, y: -1.5 }),
    }));
    expect(response.status).toBe(201);
    expect(body.orbId).toBeTruthy();

    const { body: listed } = await api(`/credit-orbs?landletId=${encodeURIComponent(landlet)}`);
    const orb = listed.orbs.find((o) => o.orbId === body.orbId);
    expect(orb).toBeTruthy();
    expect(orb.x).toBe(3.5);
    expect(orb.y).toBe(-1.5);
  });

  it('404s seeding into a landlet that does not exist', async () => {
    const admin = await signupAdmin('orb-seed-missing-landlet');
    const { response } = await api('/credit-orbs', admin.session({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ landletId: 'not-a-real-landlet' }),
    }));
    expect(response.status).toBe(404);
  });
});

describe('POST /api/credit-orbs/:orbId/collect (#1995)', () => {
  it('requires a session', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);

    const { response } = await api(`/credit-orbs/${orbId}/collect`, { method: 'POST' });
    expect(response.status).toBe(401);
  });

  it('marks the orb collected and grants the collecting builder one video-generation credit', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet); // at the landlet's own local (0, 0)
    const builder = await signupBuilder('orb-collector');
    await seedPresence(builder.builderId, { x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y });

    const { response, body } = await api(`/credit-orbs/${orbId}/collect`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(200);
    expect(body.collected).toBe(true);

    const orbRow = await env.DB.prepare('SELECT collected_at, collected_by_builder_id FROM credit_orbs WHERE orb_id = ?')
      .bind(orbId).first();
    expect(orbRow.collected_at).toBeTruthy();
    expect(orbRow.collected_by_builder_id).toBe(builder.builderId);

    const builderRow = await env.DB.prepare('SELECT video_generation_credits FROM builders WHERE builder_id = ?')
      .bind(builder.builderId).first();
    expect(builderRow.video_generation_credits).toBe(1);

    const stillListed = await api('/credit-orbs');
    expect(stillListed.body.orbs.map((orb) => orb.orbId)).not.toContain(orbId);
  });

  it('404s a second collect attempt on the same orb, and does not grant a second credit', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);
    const first = await signupBuilder('orb-first');
    const second = await signupBuilder('orb-second');
    await seedPresence(first.builderId, { x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y });
    await seedPresence(second.builderId, { x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y });

    const won = await api(`/credit-orbs/${orbId}/collect`, first.session({ method: 'POST' }));
    expect(won.response.status).toBe(200);

    const lost = await api(`/credit-orbs/${orbId}/collect`, second.session({ method: 'POST' }));
    expect(lost.response.status).toBe(404);

    const secondRow = await env.DB.prepare('SELECT video_generation_credits FROM builders WHERE builder_id = ?')
      .bind(second.builderId).first();
    expect(secondRow.video_generation_credits).toBe(0);
  });

  it('two concurrent collect attempts on the same orb: exactly one succeeds and exactly one credit is granted', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);
    const a = await signupBuilder('orb-race-a');
    const b = await signupBuilder('orb-race-b');
    await seedPresence(a.builderId, { x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y });
    await seedPresence(b.builderId, { x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y });

    const [resultA, resultB] = await Promise.all([
      api(`/credit-orbs/${orbId}/collect`, a.session({ method: 'POST' })),
      api(`/credit-orbs/${orbId}/collect`, b.session({ method: 'POST' })),
    ]);
    const statuses = [resultA.response.status, resultB.response.status].sort();
    expect(statuses).toEqual([200, 404]);

    const totalCredits = await env.DB.prepare(`
      SELECT
        (SELECT video_generation_credits FROM builders WHERE builder_id = ?) +
        (SELECT video_generation_credits FROM builders WHERE builder_id = ?) AS total
    `).bind(a.builderId, b.builderId).first();
    expect(totalCredits.total).toBe(1);
  });

  it('404s collecting an orb that does not exist', async () => {
    const builder = await signupBuilder('orb-missing');
    const { response } = await api('/credit-orbs/not-a-real-orb/collect', builder.session({ method: 'POST' }));
    expect(response.status).toBe(404);
  });

  // #2222: the presence/proximity gate -- closes the gap where a scripted
  // caller with no real "walk up to it" gesture at all could still claim
  // any orb returned by GET /api/credit-orbs.
  it('403s collecting with no avatar_presence row at all (the scripted-caller exploit)', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);
    const builder = await signupBuilder('orb-no-presence');

    const { response } = await api(`/credit-orbs/${orbId}/collect`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(403);

    const orbRow = await env.DB.prepare('SELECT collected_at FROM credit_orbs WHERE orb_id = ?').bind(orbId).first();
    expect(orbRow.collected_at).toBeNull();
  });

  it('403s collecting from too far away, converting the orb\'s landlet-local position to world coordinates correctly', async () => {
    const landlet = await seedLandlet('greenbelt'); // center at (1000, -500)
    const orbId = await seedOrb(landlet); // at the landlet's own local (0, 0) -- world (1000, -500)
    const builder = await signupBuilder('orb-too-far');
    // Right on top of the landlet-local (0, 0) offset itself, NOT the
    // orb's real world position -- would wrongly pass if the collect
    // check compared presence.x/y against the orb's raw x_m/y_m instead
    // of center_x_m/center_y_m + x_m/y_m.
    await seedPresence(builder.builderId, { x: 0, y: 0 });

    const { response } = await api(`/credit-orbs/${orbId}/collect`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(403);
  });

  it('403s collecting on a stale presence row, even if it was once nearby', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);
    const builder = await signupBuilder('orb-stale-presence');
    await seedPresence(builder.builderId, {
      x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y, ageMs: 60 * 1000, // long past PRESENCE_STALE_AFTER_MS
    });

    const { response } = await api(`/credit-orbs/${orbId}/collect`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(403);
  });

  // Greenbelt landlets (every credit orb's own home, by construction) never
  // get a reported landletId at all -- updateShopLandletInfo (src/main.js)
  // only sets one while standing on a *claimed* plot -- so a real
  // collector's own presence row always has landlet_id: null here. World
  // proximity alone has to be enough.
  it('succeeds on world-position proximity alone, with no landletId recorded at all', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);
    const builder = await signupBuilder('orb-nearby-presence');
    await seedPresence(builder.builderId, { x: DEFAULT_LANDLET_CENTER_X + 1, y: DEFAULT_LANDLET_CENTER_Y + 1 });

    const { response, body } = await api(`/credit-orbs/${orbId}/collect`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(200);
    expect(body.collected).toBe(true);
  });

  it('rate-limits repeated collect attempts by the same builder (#2092)', async () => {
    const builder = await signupBuilder('orb-rate-limited');

    for (let i = 0; i < 20; i += 1) {
      // Each attempt targets a nonexistent orb id -- a 404 still counts
      // against the rate limit (it's a cost/load gap, not specifically a
      // double-collect one), and keeps this test from needing 21 real rows.
      const { response } = await api('/credit-orbs/not-a-real-orb/collect', builder.session({ method: 'POST' }));
      expect(response.status).toBe(404);
    }

    const { response } = await api('/credit-orbs/not-a-real-orb/collect', builder.session({ method: 'POST' }));
    expect(response.status).toBe(429);
  });
});

// #2223: spawnCreditOrbIfDue only ever targets a 'greenbelt' landlet, and
// nothing else used to ever delete a credit_orbs row -- an orb left
// uncollected on a landlet that then got claimed survived forever,
// permanently wasting part of the rationed daily budget (the client only
// loads orbs for still-greenbelt landlets, so it became invisible too).
describe('POST /landlets/:id/claim cleans up an orb left on it (#2223)', () => {
  it('deletes an uncollected orb that was sitting on the landlet being claimed', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet);
    const builder = await signupBuilder('orb-cleanup-claimer');

    const { response } = await api(`/landlets/${landlet}/claim`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM credit_orbs WHERE orb_id = ?').bind(orbId).first();
    expect(row).toBeFalsy(); // was the #2223 bug -- used to survive forever, uncollectible
  });

  it('leaves an already-collected orb on the landlet untouched', async () => {
    const landlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(landlet, { collected: true });
    const builder = await signupBuilder('orb-cleanup-collected-claimer');

    const { response } = await api(`/landlets/${landlet}/claim`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM credit_orbs WHERE orb_id = ?').bind(orbId).first();
    expect(row).toBeTruthy();
  });

  it('does not delete an orb elsewhere when a claim attempt fails', async () => {
    const alreadyClaimed = await seedLandlet('claimed');
    const otherLandlet = await seedLandlet('greenbelt');
    const orbId = await seedOrb(otherLandlet);
    const builder = await signupBuilder('orb-cleanup-conflict-claimer');

    const { response } = await api(`/landlets/${alreadyClaimed}/claim`, builder.session({ method: 'POST' }));
    expect(response.status).toBe(409);

    const row = await env.DB.prepare('SELECT * FROM credit_orbs WHERE orb_id = ?').bind(orbId).first();
    expect(row).toBeTruthy();
  });
});

// #2309: collected_by_builder_id (migrations/0136) was declared as a live
// FK into builders with no ON DELETE clause at all -- SQLite's default
// blocks the delete, so DELETE /api/builders/:id used to 409 outright for
// any builder who had ever collected a credit orb. migrations/0147 drops
// the live FK (same "historical record must survive the account going
// away" fix already used for auctions.seller_builder_id/auction_bids.
// bidder_builder_id/video_generation_jobs.builder_id), so the id now just
// survives as plain historical data.
describe('Builder self-delete after collecting a credit orb (#2309)', () => {
  it('lets a builder delete their own profile after collecting a credit orb, leaving the orb row intact', async () => {
    const landlet = await seedLandlet('greenbelt');
    const builder = await signupBuilder('orb-then-self-delete');
    await seedPresence(builder.builderId, { x: DEFAULT_LANDLET_CENTER_X, y: DEFAULT_LANDLET_CENTER_Y });
    const orbId = await seedOrb(landlet);

    const collected = await api(`/credit-orbs/${orbId}/collect`, builder.session({ method: 'POST' }));
    expect(collected.response.status).toBe(200);

    const deleted = await api(`/builders/${builder.builderId}`, builder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    // The orb's own collection record survives, unchanged, as plain
    // historical data -- not cascaded away, not nulled out.
    const row = await env.DB.prepare('SELECT * FROM credit_orbs WHERE orb_id = ?').bind(orbId).first();
    expect(row.collected_by_builder_id).toBe(builder.builderId);
  });
});
