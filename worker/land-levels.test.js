import {
  applyD1Migrations, env, SELF,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import { DEFAULT_EARTH_RADIUS_M, footprintScaleAtHeight } from './earthCurvature.js';
import {
  api, extractSessionCookie, withSession, signup, signupBuilder, signupSeller, glbFile, signupAdmin,
  createGreenbeltLandletAs,
} from './test-helpers.js';

// Shared across every test that needs to act as an admin (world/land-
// candidate tooling — see requireAdmin in worker/index.js) — one admin
// account for the whole file rather than a fresh one per test, since
// admin status carries no per-test state of its own to isolate.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}


describe('Landlet levels', () => {
  const LEVEL_HEIGHT_M = 10; // matches worker/index.js's own LEVEL_HEIGHT_M / src/main.js's LANDLET_HEIGHT_M

  async function createGreenbeltLandletWithArea(landletId, areaM2) {
    return api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
    }));
  }

  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  function expectedCapConsumedM2(areaM2, levelIndex) {
    const scale = footprintScaleAtHeight(levelIndex * LEVEL_HEIGHT_M, DEFAULT_EARTH_RADIUS_M);
    return areaM2 * scale * scale;
  }

  // #489: land cap now actually gates adding a level (see worker/index.js's
  // own comment on that endpoint), and every fresh builder's default cap
  // exactly equals their one free starter lándlet's area — so a builder who
  // has only just claimed starts already at 100% of cap, with zero
  // headroom for even a single level. Tests below whose actual point is
  // something *other* than the cap gate itself (per-level cap math, the
  // outermost-only removal rule, the z-range endpoint, ...) call this
  // first to give the test builder enormous headroom via a real (large)
  // earnings event, so the endpoint's happy path stays reachable. A test
  // that needs to inspect the *exact* resulting land cap number after this
  // still shouldn't call this (it would swamp the ratchet) — those seed a
  // level directly via SQL instead, bypassing the gate entirely since it's
  // not what they're testing.
  async function growLandCapHeadroom(builderId) {
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind(`headroom-${crypto.randomUUID()}`, builderId, 100000000).run();
    await api('/builders'); // forces recomputeLandCapsBatch to ratchet land_cap_m2 up now
  }

  it('lists no levels for a fresh lándlet', async () => {
    await createGreenbeltLandletWithArea('levels-fresh-landlet', 1000);
    const list = await api('/landlets/levels-fresh-landlet/levels');
    expect(list.response.status).toBe(200);
    expect(list.body.levels).toEqual([]);
  });

  it('404s listing levels for a lándlet that does not exist, matching GET /landlets/:id', async () => {
    const missing = await api('/landlets/levels-does-not-exist/levels');
    expect(missing.response.status).toBe(404);
  });

  it('requires a session and ownership to add a level', async () => {
    const owner = await signupBuilder('levels-auth-owner');
    const stranger = await signupBuilder('levels-auth-stranger');
    await createGreenbeltLandletWithArea('levels-auth-landlet', 1000);
    await claim('levels-auth-landlet', owner);

    const unauthenticated = await api('/landlets/levels-auth-landlet/levels', {
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    });
    expect(unauthenticated.response.status).toBe(401);

    const notOwner = await api('/landlets/levels-auth-landlet/levels', stranger.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(notOwner.response.status).toBe(403);

    const invalidDirection = await api('/landlets/levels-auth-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'sideways' }),
    }));
    expect(invalidDirection.response.status).toBe(400);
  });

  // #489 (owner-confirmed): land cap now gates vertical construction, not
  // just the depth/footprint checks above. A freshly-claimed builder's
  // owned area already equals their default cap exactly (the starter
  // lándlet is sized to match LAND_CAP_STARTER_M2), so — with no headroom
  // grown first — even a single level in either direction is over cap.
  it('rejects adding a level that would exceed the builder\'s land cap', async () => {
    const owner = await signupBuilder('levels-cap-gate-owner');
    await createGreenbeltLandletWithArea('levels-cap-gate-landlet', 1000);
    await claim('levels-cap-gate-landlet', owner);

    const up = await api('/landlets/levels-cap-gate-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(up.response.status).toBe(409);
    expect(up.body.error).toMatch(/land cap/i);

    const down = await api('/landlets/levels-cap-gate-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'down' }),
    }));
    expect(down.response.status).toBe(409);
    expect(down.body.error).toMatch(/land cap/i);

    const list = await api('/landlets/levels-cap-gate-landlet/levels');
    expect(list.body.levels).toEqual([]);
  });

  it('allows adding a level once the builder has grown enough land cap headroom', async () => {
    const owner = await signupBuilder('levels-cap-headroom-owner');
    await createGreenbeltLandletWithArea('levels-cap-headroom-landlet', 1000);
    await claim('levels-cap-headroom-landlet', owner);
    await growLandCapHeadroom(owner.builderId);

    const up = await api('/landlets/levels-cap-headroom-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(up.response.status).toBe(201);
  });

  // #706: same land-cap-frees-on-commitment fix as the auction-bid tests
  // above, exercised through the level-add path instead — this is also
  // the only test that actually round-trips the atomic INSERT guard's own
  // (separately duplicated) copy of the exclusion, not just the eager
  // pre-check both paths share via recomputeLandCap.
  it('frees land-cap headroom for adding a level once another owned landlet is committed via a $0 auction', async () => {
    const owner = await signupBuilder('levels-cap-free-owner');
    await createGreenbeltLandletWithArea('levels-cap-free-committed', 1000);
    await claim('levels-cap-free-committed', owner);
    await api('/landlets/levels-cap-free-committed/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    })); // $0 starting bid — commits it

    // #199 already lets a builder claim a new landlet once their existing
    // one is committed via auction — needed here just to have something
    // to add a level to.
    await createGreenbeltLandletWithArea('levels-cap-free-new', 10);
    const claimed = await claim('levels-cap-free-new', owner);
    expect(claimed.response.status).toBe(200);

    const up = await api('/landlets/levels-cap-free-new/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(up.response.status).toBe(201);
  });

  // Owner: the frontend always displays area rounded to the nearest whole
  // m² (src/settings.js's formatArea), so a builder comparing two numbers
  // that read identically on screen shouldn't get rejected over a
  // fraction-of-a-unit difference neither of them can actually see. The
  // gate gives itself exactly a 1m² buffer against that — this pins down
  // both edges of it: 1m² over cap still succeeds, 2m² over does not.
  it('gives the land cap gate a one-unit buffer against display rounding, per owner feedback', async () => {
    const levelCapM2 = expectedCapConsumedM2(1000, 1);

    const withinBuffer = await signupBuilder('levels-cap-buffer-within-owner');
    await createGreenbeltLandletWithArea('levels-cap-buffer-within-landlet', 1000);
    await claim('levels-cap-buffer-within-landlet', withinBuffer);
    await env.DB.prepare('UPDATE builders SET land_cap_m2 = ? WHERE builder_id = ?')
      .bind(1000 + levelCapM2 - 1, withinBuffer.builderId).run();
    const allowed = await api('/landlets/levels-cap-buffer-within-landlet/levels', withinBuffer.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(allowed.response.status).toBe(201);

    const beyondBuffer = await signupBuilder('levels-cap-buffer-beyond-owner');
    await createGreenbeltLandletWithArea('levels-cap-buffer-beyond-landlet', 1000);
    await claim('levels-cap-buffer-beyond-landlet', beyondBuffer);
    await env.DB.prepare('UPDATE builders SET land_cap_m2 = ? WHERE builder_id = ?')
      .bind(1000 + levelCapM2 - 2, beyondBuffer.builderId).run();
    const rejected = await api('/landlets/levels-cap-buffer-beyond-landlet/levels', beyondBuffer.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(rejected.response.status).toBe(409);
  });

  it('adds sequential levels above and below ground, each costing the correct asymmetric cap', async () => {
    const owner = await signupBuilder('levels-sequential-owner');
    await createGreenbeltLandletWithArea('levels-sequential-landlet', 1000);
    await claim('levels-sequential-landlet', owner);
    await growLandCapHeadroom(owner.builderId);

    const up1 = await api('/landlets/levels-sequential-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(up1.response.status).toBe(201);
    expect(up1.body.level).toMatchObject({ landletId: 'levels-sequential-landlet', levelIndex: 1 });
    // Above ground costs strictly more than the ground-level baseline area.
    expect(up1.body.level.capConsumedM2).toBeGreaterThan(1000);
    expect(up1.body.level.capConsumedM2).toBeCloseTo(expectedCapConsumedM2(1000, 1), 9);

    const up2 = await api('/landlets/levels-sequential-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(up2.body.level.levelIndex).toBe(2);
    // Each level up costs more than the one below it (cone widening outward).
    expect(up2.body.level.capConsumedM2).toBeGreaterThan(up1.body.level.capConsumedM2);

    const down1 = await api('/landlets/levels-sequential-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'down' }),
    }));
    expect(down1.body.level.levelIndex).toBe(-1);
    // Below ground costs strictly less than the ground-level baseline area.
    expect(down1.body.level.capConsumedM2).toBeLessThan(1000);
    expect(down1.body.level.capConsumedM2).toBeCloseTo(expectedCapConsumedM2(1000, -1), 9);

    const list = await api('/landlets/levels-sequential-landlet/levels');
    expect(list.body.levels.map((level) => level.levelIndex)).toEqual([-1, 1, 2]);
  });

  it('only lets the outermost level be removed, in either direction', async () => {
    const owner = await signupBuilder('levels-remove-owner');
    const stranger = await signupBuilder('levels-remove-stranger');
    await createGreenbeltLandletWithArea('levels-remove-landlet', 1000);
    await claim('levels-remove-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    for (const direction of ['up', 'up', 'down']) {
      await api('/landlets/levels-remove-landlet/levels', owner.session({
        method: 'POST', body: JSON.stringify({ direction }),
      }));
    }
    // Levels 1, 2 (up) and -1 (down) now exist.

    const removeGround = await api('/landlets/levels-remove-landlet/levels/0', owner.session({ method: 'DELETE' }));
    expect(removeGround.response.status).toBe(409);

    const removeInner = await api('/landlets/levels-remove-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removeInner.response.status).toBe(409);

    const notOwnerRemove = await api('/landlets/levels-remove-landlet/levels/2', stranger.session({ method: 'DELETE' }));
    expect(notOwnerRemove.response.status).toBe(403);

    const removeOutermost = await api('/landlets/levels-remove-landlet/levels/2', owner.session({ method: 'DELETE' }));
    expect(removeOutermost.response.status).toBe(200);
    expect(removeOutermost.body.deleted).toBe(true);

    // Now level 1 is the outermost up level and can be removed.
    const removeNowOutermost = await api('/landlets/levels-remove-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removeNowOutermost.response.status).toBe(200);

    const list = await api('/landlets/levels-remove-landlet/levels');
    expect(list.body.levels.map((level) => level.levelIndex)).toEqual([-1]);
  });

  // #522 (owner-confirmed, 2026-09-09): nothing previously re-checked an
  // already-placed instance's z once a level it depended on was removed —
  // assertInstanceZWithinLevels only ever runs on that instance's own
  // create/move, never on level removal. The owner's answer: instances left
  // in the removed level's z-range should come out of active shoppable
  // space.
  it('removes instances left in a level\'s z-range once that level is removed, leaving others untouched', async () => {
    const owner = await signupBuilder('levels-remove-instances-owner');
    await createGreenbeltLandletWithArea('levels-remove-instances-landlet', 1000);
    await claim('levels-remove-instances-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-remove-instances-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const onGround = await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'levels-remove-instances-ground',
        landletId: 'levels-remove-instances-landlet',
        templateId: 'placeholder-tree',
        x: 1, y: 1, z: 0,
      }),
    }));
    expect(onGround.response.status).toBe(201);

    const onLevel1 = await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'levels-remove-instances-upper',
        landletId: 'levels-remove-instances-landlet',
        templateId: 'placeholder-tree',
        x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
      }),
    }));
    expect(onLevel1.response.status).toBe(201);

    const removed = await api('/landlets/levels-remove-instances-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removed.response.status).toBe(200);
    // #901: the frontend has no other way to find out which instances just
    // got swept out of its local scene -- without this, their meshes go
    // stale and can later block an unrelated batch sync.
    expect(removed.body.sweptInstanceIds).toEqual(['levels-remove-instances-upper']);

    const instances = await api('/instances?landletId=levels-remove-instances-landlet');
    expect(instances.body.instances.map((i) => i.instanceId)).toEqual(['levels-remove-instances-ground']);
  });

  // #901: a removal with nothing to sweep should report an empty array, not
  // omit the field or return null -- the frontend loops over it unconditionally.
  it('reports an empty sweptInstanceIds array when nothing needed sweeping', async () => {
    const owner = await signupBuilder('levels-remove-nothing-owner');
    await createGreenbeltLandletWithArea('levels-remove-nothing-landlet', 1000);
    await claim('levels-remove-nothing-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-remove-nothing-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const removed = await api('/landlets/levels-remove-nothing-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removed.response.status).toBe(200);
    expect(removed.body.sweptInstanceIds).toEqual([]);
  });

  // #633 (sub-issue of #631, owner-confirmed on #522/#631): the instances
  // swept out of active space above aren't just gone — they're snapshotted
  // into a reusable saved_level_layouts/saved_layout_instances record
  // first, mirroring version_instances' own snapshot shape.
  it('saves instances swept out of active space into a reusable layout record', async () => {
    const owner = await signupBuilder('levels-save-layout-owner');
    await createGreenbeltLandletWithArea('levels-save-layout-landlet', 1000);
    await claim('levels-save-layout-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-save-layout-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'levels-save-layout-ground',
        landletId: 'levels-save-layout-landlet',
        templateId: 'placeholder-tree',
        x: 1, y: 1, z: 0,
      }),
    }));
    const swept = await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'levels-save-layout-upper',
        landletId: 'levels-save-layout-landlet',
        templateId: 'placeholder-tree',
        x: 2, y: 3, z: LEVEL_HEIGHT_M * 1.5,
        rotationZ: 1.25,
      }),
    }));
    expect(swept.response.status).toBe(201);

    const removed = await api('/landlets/levels-save-layout-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removed.response.status).toBe(200);

    const { results: layouts } = await env.DB.prepare(
      'SELECT * FROM saved_level_layouts WHERE builder_id = ?',
    ).bind(owner.builderId).all();
    expect(layouts).toHaveLength(1);
    expect(layouts[0].source_landlet_id).toBe('levels-save-layout-landlet');
    expect(layouts[0].source_level_index).toBe(1);
    expect(layouts[0].name).toMatch(/Level 1/);

    const { results: savedInstances } = await env.DB.prepare(
      'SELECT * FROM saved_layout_instances WHERE saved_layout_id = ?',
    ).bind(layouts[0].saved_layout_id).all();
    // Only the swept (upper) instance is saved — the ground one that
    // survived was never deleted, so nothing needed preserving for it.
    expect(savedInstances).toHaveLength(1);
    expect(savedInstances[0].source_instance_id).toBe('levels-save-layout-upper');
    expect(savedInstances[0].x_m).toBe(2);
    expect(savedInstances[0].y_m).toBe(3);
    expect(savedInstances[0].rotation_z_rad).toBe(1.25);
  });

  // #928: the outOfRange snapshot used to be taken once, before
  // checkRateLimit and the level DELETE (two awaited round-trips) — a
  // concurrent write landing in the doomed z-range during that gap would be
  // silently destroyed by the final sweep DELETE (scoped by z-range, not by
  // the snapshotted instance ids) without ever getting a
  // saved_layout_instances row. Simulating a genuine concurrent request via
  // real timing (Promise.all of two fetches) turned out not to reliably
  // land inside this specific window in this test runtime — both requests
  // complete too predictably relative to each other. Instead, this hooks
  // env.DB.prepare (the exact same binding object the worker's own fetch
  // handler sees, per vitest-pool-workers) to insert a new instance directly
  // into placed_instances at the moment checkRateLimit's own INSERT runs —
  // i.e. exactly in the gap between the original outOfRange snapshot and
  // everything that follows it, the same gap a real concurrent request would
  // land in.
  it('never silently destroys an instance placed concurrently with a level removal, without saving it', async () => {
    const owner = await signupBuilder('levels-remove-sweep-race-owner');
    await createGreenbeltLandletWithArea('levels-remove-sweep-race-landlet', 1000);
    await claim('levels-remove-sweep-race-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-remove-sweep-race-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const racingInstanceId = 'levels-remove-sweep-race-instance';
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        // Fire-and-continue: this mirrors a concurrent request's write
        // landing in the gap between the original snapshot and the level
        // DELETE, without needing this hook itself to be async.
        originalPrepare(`
          INSERT INTO placed_instances (
            instance_id, landlet_id, template_id, x_m, y_m, z_m,
            rotation_x_rad, rotation_y_rad, rotation_z_rad, scale
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 1)
        `).bind(racingInstanceId, 'levels-remove-sweep-race-landlet', 'placeholder-tree', 1, 1, LEVEL_HEIGHT_M * 1.5).run();
      }
      return originalPrepare(sql);
    };
    try {
      const removed = await api('/landlets/levels-remove-sweep-race-landlet/levels/1', owner.session({ method: 'DELETE' }));
      expect(removed.response.status).toBe(200);
    } finally {
      env.DB.prepare = originalPrepare;
    }

    const stillPlaced = await env.DB.prepare(
      'SELECT 1 FROM placed_instances WHERE instance_id = ?',
    ).bind(racingInstanceId).first();
    if (stillPlaced) return; // survived (shouldn't happen given the injection point, but not a bug either way)
    const saved = await env.DB.prepare(
      'SELECT 1 FROM saved_layout_instances WHERE source_instance_id = ?',
    ).bind(racingInstanceId).first();
    expect(saved, `${racingInstanceId} was destroyed by the level-removal sweep without ever being saved`).not.toBeNull();
  });

  // #2470: the #928 fix above re-queries placed_instances fresh right
  // before the sweep, but still scoped by minZ/maxZ computed from the
  // pre-DELETE snapshot taken before checkRateLimit -- that snapshot only
  // excludes the level actually being removed, so it doesn't account for a
  // concurrent level ADD in the *other* direction landing in that same
  // gap. Here the landlet starts with only an "up" level (1); while this
  // request is removing it, a concurrent request (simulated the same way
  // as the #928 test above, via the same env.DB.prepare hook on
  // checkRateLimit's own INSERT) adds a "down" level (-1) and places an
  // instance at z = -10 -- outside the stale pre-DELETE range ([-5, 5], since
  // the original snapshot saw no other levels once level 1 is removed) but
  // squarely inside the real, live range once level -1 exists ([-15, 5]).
  // The instance is genuinely valid under the landlet's actual current
  // levels and must survive untouched -- not swept into a saved layout, not
  // deleted from active space.
  it('does not sweep an instance that only became valid via a concurrent level add in the other direction', async () => {
    const owner = await signupBuilder('levels-other-direction-race-owner');
    await createGreenbeltLandletWithArea('levels-other-direction-race-landlet', 1000);
    await claim('levels-other-direction-race-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-other-direction-race-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const racingInstanceId = 'levels-other-direction-race-instance';
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        // Mirrors a concurrent tab's own real POST /levels {direction:
        // 'down'} + place-an-instance sequence landing in the gap between
        // the original pre-DELETE snapshot and this request's own DELETE.
        originalPrepare(`
          INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
        `).bind('levels-other-direction-race-down-level', 'levels-other-direction-race-landlet', -1, 1).run();
        originalPrepare(`
          INSERT INTO placed_instances (
            instance_id, landlet_id, template_id, x_m, y_m, z_m,
            rotation_x_rad, rotation_y_rad, rotation_z_rad, scale
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 1)
        `).bind(racingInstanceId, 'levels-other-direction-race-landlet', 'placeholder-tree', 1, 1, -LEVEL_HEIGHT_M).run();
      }
      return originalPrepare(sql);
    };
    try {
      const removed = await api('/landlets/levels-other-direction-race-landlet/levels/1', owner.session({ method: 'DELETE' }));
      expect(removed.response.status).toBe(200);
    } finally {
      env.DB.prepare = originalPrepare;
    }

    const stillPlaced = await env.DB.prepare(
      'SELECT 1 FROM placed_instances WHERE instance_id = ?',
    ).bind(racingInstanceId).first();
    expect(stillPlaced, `${racingInstanceId} was wrongly swept even though it's valid under the live (post-concurrent-add) levels`).not.toBeNull();
    const saved = await env.DB.prepare(
      'SELECT 1 FROM saved_layout_instances WHERE source_instance_id = ?',
    ).bind(racingInstanceId).first();
    expect(saved, `${racingInstanceId} was wrongly archived as swept even though it's valid under the live (post-concurrent-add) levels`).toBeNull();
  });

  // #958: same #415 "auction transfer in the await gap" race already closed
  // for landlet versions/draft/instances -- an owning builder's add-level
  // request must not still succeed once a concurrent auction resolution has
  // transferred the landlet away, even though assertOwner passed a moment
  // earlier. Same injection point (checkRateLimit's own INSERT) as the
  // sweep-race test above, since that's the earliest awaited step after
  // assertOwner in this handler too.
  it('does not add a level onto a landlet that was transferred to a new owner mid-request', async () => {
    const owner = await signupBuilder('levels-add-ownership-race-owner');
    const newOwner = await signupBuilder('levels-add-ownership-race-new-owner');
    await createGreenbeltLandletWithArea('levels-add-ownership-race-landlet', 1000);
    await claim('levels-add-ownership-race-landlet', owner);
    await growLandCapHeadroom(owner.builderId);

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(newOwner.builderId, 'levels-add-ownership-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let added;
    try {
      added = await api('/landlets/levels-add-ownership-race-landlet/levels', owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(added.response.status).toBe(409);

    const { results: levels } = await env.DB.prepare(
      'SELECT * FROM landlet_levels WHERE landlet_id = ?',
    ).bind('levels-add-ownership-race-landlet').all();
    expect(levels).toHaveLength(0);
  });

  // #958: same race, remove-level side. A stale DELETE from the old owner
  // must not still remove a level once ownership has transferred mid-request.
  it('does not remove a level from a landlet that was transferred to a new owner mid-request', async () => {
    const owner = await signupBuilder('levels-remove-ownership-race-owner');
    const newOwner = await signupBuilder('levels-remove-ownership-race-new-owner');
    await createGreenbeltLandletWithArea('levels-remove-ownership-race-landlet', 1000);
    await claim('levels-remove-ownership-race-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-remove-ownership-race-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(newOwner.builderId, 'levels-remove-ownership-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let removed;
    try {
      removed = await api('/landlets/levels-remove-ownership-race-landlet/levels/1', owner.session({ method: 'DELETE' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(removed.response.status).toBe(409);

    const stillThere = await env.DB.prepare(
      'SELECT 1 FROM landlet_levels WHERE landlet_id = ? AND level_index = 1',
    ).bind('levels-remove-ownership-race-landlet').first();
    expect(stillThere).not.toBeNull();
  });

  // Removing a level with nothing in its z-range shouldn't create an empty
  // saved-layout record — there's nothing worth preserving.
  it('creates no saved-layout record when a removed level has no instances to sweep', async () => {
    const owner = await signupBuilder('levels-no-save-layout-owner');
    await createGreenbeltLandletWithArea('levels-no-save-layout-landlet', 1000);
    await claim('levels-no-save-layout-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-no-save-layout-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const removed = await api('/landlets/levels-no-save-layout-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removed.response.status).toBe(200);

    const { results: layouts } = await env.DB.prepare(
      'SELECT * FROM saved_level_layouts WHERE builder_id = ?',
    ).bind(owner.builderId).all();
    expect(layouts).toHaveLength(0);
  });

  // #794: unlike every comparable repeatable write in this file (sign
  // posts, calendar events, bundle creation), the #633 snapshot-on-removal
  // above had no rate limit — and the level-add's own land-cap cost isn't
  // a real deterrent, since removing the level fully restores that
  // headroom. An add-level/place-instance/remove-level loop could grow
  // saved_level_layouts for free.
  it('rate-limits repeated level-removal saved-layout snapshots from the same builder', async () => {
    const owner = await signupBuilder('levels-rate-limit-owner');
    await createGreenbeltLandletWithArea('levels-rate-limit-landlet', 1000);
    await claim('levels-rate-limit-landlet', owner);
    await growLandCapHeadroom(owner.builderId);

    async function sweepOneLevel(instanceId) {
      await api('/landlets/levels-rate-limit-landlet/levels', owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
      await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId, landletId: 'levels-rate-limit-landlet', templateId: 'placeholder-tree',
          x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
        }),
      }));
      return api('/landlets/levels-rate-limit-landlet/levels/1', owner.session({ method: 'DELETE' }));
    }

    for (let i = 0; i < 20; i++) {
      const removed = await sweepOneLevel(`levels-rate-limit-instance-${i}`);
      expect(removed.response.status).not.toBe(429);
    }
    const limited = await sweepOneLevel('levels-rate-limit-instance-final');
    expect(limited.response.status).toBe(429);
  }, 90000); // #978/#2060/#2157: 20 iterations x 3 real HTTP requests each
  // (add level, place instance, sweep-delete) reliably finishes in ~2s in
  // isolation, but this file shares one D1 instance across its whole,
  // ever-growing test count, and late-file cumulative state occasionally
  // pushes this specific test past its own timeout under CI load -- 20s
  // (the global default) wasn't enough (#978, bumped to 45000ms), #2060
  // found 45000ms itself no longer enough either (bumped to 60000ms), and
  // #2157 found even 60000ms insufficient under this file's continued
  // growth, so this is the next step up.

  // #907: the sweep-specific rate limit just above (#794) only covers a
  // level removal that has an out-of-range instance to archive -- the
  // add-level branch itself had no rate limit at all, letting a builder
  // loop POST .../levels indefinitely (each call doing a real atomic
  // multi-subquery INSERT plus a recomputeLandCap call).
  it('rate-limits repeated level additions from the same builder', async () => {
    const owner = await signupBuilder('levels-add-rate-limit-owner');
    await createGreenbeltLandletWithArea('levels-add-rate-limit-landlet', 1000);
    await claim('levels-add-rate-limit-landlet', owner);
    await growLandCapHeadroom(owner.builderId);

    for (let i = 0; i < 40; i++) {
      const added = await api('/landlets/levels-add-rate-limit-landlet/levels', owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
      expect(added.response.status).not.toBe(429);
      // Removed directly (bypassing the DELETE endpoint's own, separate
      // #907 rate limit below) so each add lands on level index 1 again
      // without this loop also draining that other bucket.
      await env.DB.prepare('DELETE FROM landlet_levels WHERE landlet_id = ?')
        .bind('levels-add-rate-limit-landlet').run();
    }
    const limited = await api('/landlets/levels-add-rate-limit-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(limited.response.status).toBe(429);
  }, 90000); // #978/#2157: same cumulative-D1-state-under-CI-load shape as
  // the sweep-rate-limit test above — 40 real HTTP round trips late in this
  // file's ever-growing test run against one shared D1 instance, reliably
  // finishing in well under 1s in isolation but occasionally pushed past
  // the original 45000ms (itself already a bump from the 20000ms default)
  // under CI load, hence this further bump.

  // #907: a level removal with nothing to sweep (the common case for an
  // empty level) fell through with no rate limit at all -- only the sweep
  // sub-branch tested above (#794) had one.
  it('rate-limits repeated level removals with nothing to sweep, from the same builder', async () => {
    const owner = await signupBuilder('levels-remove-rate-limit-owner');
    await createGreenbeltLandletWithArea('levels-remove-rate-limit-landlet', 1000);
    await claim('levels-remove-rate-limit-landlet', owner);
    const levelCapM2 = expectedCapConsumedM2(1000, 1);

    async function seedLevelDirectly() {
      // Seeded directly (bypassing POST /levels and its own separate
      // #907 add-rate-limit above) so this isolates just the DELETE-side
      // limit being tested here.
      await env.DB.prepare(`
        INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
      `).bind(`levels-remove-rate-limit-seed-${crypto.randomUUID()}`, 'levels-remove-rate-limit-landlet', 1, levelCapM2).run();
    }

    for (let i = 0; i < 40; i++) {
      await seedLevelDirectly();
      const removed = await api('/landlets/levels-remove-rate-limit-landlet/levels/1', owner.session({ method: 'DELETE' }));
      expect(removed.response.status).not.toBe(429);
    }
    await seedLevelDirectly();
    const limited = await api('/landlets/levels-remove-rate-limit-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(limited.response.status).toBe(429);
  }, 60000); // #978/#2196: same cumulative-D1-state-under-CI-load shape as
  // the sweep-rate-limit test above and its own "leaves the level row
  // untouched" sibling just below (which already carries this same
  // override) — 40-41 real round trips late in this file's 121-test run,
  // occasionally pushed past the 20s default under CI load. #2196: the
  // prior 45000ms override was itself observed timing out under CI load,
  // same precedent as #2060's bump for this same describe block.

  // #924: the rate-limit check used to run AFTER the level row was already
  // deleted -- a rate-limited caller still got the real, irreversible
  // removal committed, just with a 429 response and none of the
  // sweep/save-layout/recomputeLandCap follow-through that's supposed to
  // come with it. A rate-limited request must leave the level row (and
  // everything else) completely untouched.
  it('leaves the level row untouched when the removal is rate-limited, not deleted with a 429 response', async () => {
    const owner = await signupBuilder('levels-remove-rate-limit-untouched-owner');
    await createGreenbeltLandletWithArea('levels-remove-rate-limit-untouched-landlet', 1000);
    await claim('levels-remove-rate-limit-untouched-landlet', owner);
    const levelCapM2 = expectedCapConsumedM2(1000, 1);

    async function seedLevelDirectly(levelId) {
      await env.DB.prepare(`
        INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
      `).bind(levelId, 'levels-remove-rate-limit-untouched-landlet', 1, levelCapM2).run();
    }

    for (let i = 0; i < 40; i++) {
      await seedLevelDirectly(`levels-remove-rate-limit-untouched-seed-${i}`);
      await api('/landlets/levels-remove-rate-limit-untouched-landlet/levels/1', owner.session({ method: 'DELETE' }));
    }
    await seedLevelDirectly('levels-remove-rate-limit-untouched-final');
    const limited = await api('/landlets/levels-remove-rate-limit-untouched-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(limited.response.status).toBe(429);

    const { results } = await env.DB.prepare(
      'SELECT * FROM landlet_levels WHERE level_id = ?',
    ).bind('levels-remove-rate-limit-untouched-final').all();
    expect(results).toHaveLength(1);
  }, 60000); // #978/#1511/#2196: 40 iterations of a direct DB seed plus a
  // DELETE call each, late in this file's 121-test run against one shared
  // D1 instance -- reliably finishes in ~2s in isolation but has hit the
  // 20s default, then the 30s override, under CI load already (#1511:
  // bumped again to 45000, matching worker/commerce.test.js:2621's
  // precedent for a comparable request volume). #2196: 45000ms itself was
  // then observed timing out under CI load, matching #2060's own bump for
  // this same describe block.

  // #634 (sub-issue of #631): list/delete the saved-layout records #633
  // creates above. Reuses this describe block's own growLandCapHeadroom/
  // createGreenbeltLandletWithArea helpers to get a real removed-level
  // save on the books without duplicating that whole setup per test.
  describe('Listing and deleting saved layouts (#634)', () => {
    async function saveALayout(ownerLabel, landletId) {
      const owner = await signupBuilder(ownerLabel);
      await createGreenbeltLandletWithArea(landletId, 1000);
      await claim(landletId, owner);
      await growLandCapHeadroom(owner.builderId);
      await api(`/landlets/${landletId}/levels`, owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
      const placed = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: `${landletId}-upper`,
          landletId,
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
        }),
      }));
      expect(placed.response.status).toBe(201);
      const removed = await api(`/landlets/${landletId}/levels/1`, owner.session({ method: 'DELETE' }));
      expect(removed.response.status).toBe(200);
      const { results } = await env.DB.prepare('SELECT * FROM saved_level_layouts WHERE builder_id = ?')
        .bind(owner.builderId).all();
      return { owner, savedLayoutId: results[0].saved_layout_id };
    }

    it('requires a session to list saved layouts', async () => {
      const got = await api('/builders/me/saved-layouts');
      expect(got.response.status).toBe(401);
    });

    it("lists the current builder's own saved layouts with an instance count, never another builder's", async () => {
      const { owner } = await saveALayout('saved-layouts-list-owner', 'saved-layouts-list-landlet');
      const stranger = await signupBuilder('saved-layouts-list-stranger');

      const mine = await api('/builders/me/saved-layouts', owner.session());
      expect(mine.response.status).toBe(200);
      expect(mine.body.savedLayouts).toHaveLength(1);
      expect(mine.body.savedLayouts[0]).toMatchObject({
        sourceLandletId: 'saved-layouts-list-landlet',
        sourceLevelIndex: 1,
        instanceCount: 1,
      });
      expect(mine.body.savedLayouts[0].name).toMatch(/Level 1/);

      const theirs = await api('/builders/me/saved-layouts', stranger.session());
      expect(theirs.response.status).toBe(200);
      expect(theirs.body.savedLayouts).toHaveLength(0);
    });

    it('paginates newest-first via cursor', async () => {
      const owner = await signupBuilder('saved-layouts-page-owner');
      for (const suffix of ['a', 'b']) {
        const landletId = `saved-layouts-page-landlet-${suffix}`;
        await createGreenbeltLandletWithArea(landletId, 1000);
        if (suffix === 'a') {
          await claim(landletId, owner);
        } else {
          // A builder can only hold one claimed landlet at a time via the
          // real /claim flow (POST .../claim's own NOT EXISTS guard) —
          // owner already holds landlet "a" from the loop's first pass,
          // so this second one is claimed by directly setting the same
          // columns POST .../claim itself sets (see that handler's own
          // UPDATE), bypassing that one-at-a-time restriction purely for
          // this test's own setup convenience.
          await env.DB.prepare(`
            UPDATE landlets SET status = 'claimed', owner_builder_id = ?,
              claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE landlet_id = ?
          `).bind(owner.builderId, landletId).run();
        }
        await growLandCapHeadroom(owner.builderId);
        await api(`/landlets/${landletId}/levels`, owner.session({
          method: 'POST', body: JSON.stringify({ direction: 'up' }),
        }));
        await api('/instances', owner.session({
          method: 'POST',
          body: JSON.stringify({
            instanceId: `${landletId}-upper`, landletId, templateId: 'placeholder-tree',
            x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
          }),
        }));
        const removed = await api(`/landlets/${landletId}/levels/1`, owner.session({ method: 'DELETE' }));
        expect(removed.response.status).toBe(200);
      }

      const firstPage = await api('/builders/me/saved-layouts?limit=1', owner.session());
      expect(firstPage.body.savedLayouts).toHaveLength(1);
      expect(firstPage.body.savedLayouts[0].sourceLandletId).toBe('saved-layouts-page-landlet-b');
      expect(firstPage.body.nextCursor).toBeTruthy();

      const secondPage = await api(
        `/builders/me/saved-layouts?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
        owner.session(),
      );
      expect(secondPage.body.savedLayouts).toHaveLength(1);
      expect(secondPage.body.savedLayouts[0].sourceLandletId).toBe('saved-layouts-page-landlet-a');
      expect(secondPage.body.nextCursor).toBeNull();
    });

    it('requires a session to fetch a single saved layout', async () => {
      const { savedLayoutId } = await saveALayout('saved-layouts-get-noauth-owner', 'saved-layouts-get-noauth-landlet');
      const got = await api(`/saved-layouts/${savedLayoutId}`);
      expect(got.response.status).toBe(401);
    });

    it("rejects fetching another builder's saved layout", async () => {
      const { savedLayoutId } = await saveALayout('saved-layouts-get-owner', 'saved-layouts-get-landlet');
      const stranger = await signupBuilder('saved-layouts-get-stranger');
      const got = await api(`/saved-layouts/${savedLayoutId}`, stranger.session());
      expect(got.response.status).toBe(403);
    });

    it('404s fetching a saved layout that does not exist', async () => {
      const builder = await signupBuilder('saved-layouts-get-missing');
      const got = await api('/saved-layouts/does-not-exist', builder.session());
      expect(got.response.status).toBe(404);
    });

    it("fetches a single saved layout with its full instance snapshot (position, rotation, template)", async () => {
      const { owner, savedLayoutId } = await saveALayout('saved-layouts-get-real-owner', 'saved-layouts-get-real-landlet');

      const got = await api(`/saved-layouts/${savedLayoutId}`, owner.session());
      expect(got.response.status).toBe(200);
      expect(got.body.savedLayout).toMatchObject({
        savedLayoutId,
        sourceLandletId: 'saved-layouts-get-real-landlet',
        sourceLevelIndex: 1,
        instanceCount: 1,
      });
      expect(got.body.savedLayout.instances).toHaveLength(1);
      expect(got.body.savedLayout.instances[0]).toMatchObject({
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
        z: LEVEL_HEIGHT_M * 1.5,
      });
    });

    it('requires a session to delete a saved layout', async () => {
      const { savedLayoutId } = await saveALayout('saved-layouts-delete-noauth-owner', 'saved-layouts-delete-noauth-landlet');
      const got = await api(`/saved-layouts/${savedLayoutId}`, { method: 'DELETE' });
      expect(got.response.status).toBe(401);
    });

    it("rejects deleting another builder's saved layout", async () => {
      const { savedLayoutId } = await saveALayout('saved-layouts-delete-owner', 'saved-layouts-delete-landlet');
      const stranger = await signupBuilder('saved-layouts-delete-stranger');
      const got = await api(`/saved-layouts/${savedLayoutId}`, stranger.session({ method: 'DELETE' }));
      expect(got.response.status).toBe(403);
    });

    it('404s deleting a saved layout that does not exist', async () => {
      const builder = await signupBuilder('saved-layouts-delete-missing');
      const got = await api('/saved-layouts/does-not-exist', builder.session({ method: 'DELETE' }));
      expect(got.response.status).toBe(404);
    });

    it('deletes a saved layout and cascades its saved instances, owner-gated', async () => {
      const { owner, savedLayoutId } = await saveALayout('saved-layouts-delete-real-owner', 'saved-layouts-delete-real-landlet');

      const deleted = await api(`/saved-layouts/${savedLayoutId}`, owner.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);

      const { results: layouts } = await env.DB.prepare('SELECT * FROM saved_level_layouts WHERE saved_layout_id = ?')
        .bind(savedLayoutId).all();
      expect(layouts).toHaveLength(0);
      const { results: instances } = await env.DB.prepare('SELECT * FROM saved_layout_instances WHERE saved_layout_id = ?')
        .bind(savedLayoutId).all();
      expect(instances).toHaveLength(0);

      const afterList = await api('/builders/me/saved-layouts', owner.session());
      expect(afterList.body.savedLayouts).toHaveLength(0);
    });

    // #944: unlike this file's other owner-gated CRUD DELETEs (friendship-
    // mutate, bundle-mutate), this endpoint had no rate limit at all. Seeds
    // 21 saved layouts directly via the DB (bypassing the full level-
    // create/remove flow saveALayout uses, which would be far slower to
    // repeat 21 times) so this test can exercise 21 deletes cheaply.
    it('rate-limits repeated saved-layout deletions from the same builder', async () => {
      const owner = await signupBuilder('saved-layouts-delete-rate-limit-owner');
      const savedLayoutIds = Array.from({ length: 21 }, (_, i) => `saved-layouts-delete-rate-limit-${i}`);
      await env.DB.batch(savedLayoutIds.map((savedLayoutId) => env.DB.prepare(
        `INSERT INTO saved_level_layouts (saved_layout_id, builder_id, source_level_index, name) VALUES (?, ?, ?, ?)`,
      ).bind(savedLayoutId, owner.builderId, 1, 'A saved layout')));

      for (let i = 0; i < 20; i++) {
        const attempt = await api(`/saved-layouts/${savedLayoutIds[i]}`, owner.session({ method: 'DELETE' }));
        expect(attempt.response.status).toBe(200);
      }
      const limited = await api(`/saved-layouts/${savedLayoutIds[20]}`, owner.session({ method: 'DELETE' }));
      expect(limited.response.status).toBe(429);
    }, 30000); // #1759: same cumulative-D1-state-under-CI-load shape as #978/
    // #1224/#1511 -- 20 sequential real HTTP DELETEs, comparable to #1511's
    // own ~20-request loop, which got the same 30000ms override.

    // #1441: GET /api/builders/me/saved-layouts sorts by
    // `created_at DESC, saved_layout_id DESC`, but the old builder_id index
    // didn't cover that sort — same "schema-only change, check the index
    // exists" shape as #1004's auctions/auction_bids test. The old index is
    // dropped in the same migration (now a strict leftmost-prefix subset of
    // the composite one), so this also confirms that drop didn't silently
    // no-op.
    it('indexes saved_level_layouts on builder_id, covering the sort', async () => {
      const indexes = (await env.DB.prepare('PRAGMA index_list(saved_level_layouts)').all()).results;
      expect(indexes.some((idx) => idx.name === 'idx_saved_level_layouts_builder_created')).toBe(true);
      expect(indexes.some((idx) => idx.name === 'idx_saved_level_layouts_builder_id')).toBe(false);
    });
  });

  // #976: POST/PATCH /api/catalog used to return the locally-constructed
  // `template` object built by validateTemplate, which never carries
  // imageUrl/imageEmbedding/createdAt/updatedAt -- unlike every sibling
  // create/update handler in this file (and this same resource's own
  // POST/PUT batch endpoint), which all re-select and map through
  // templateFromRow after the write.
  describe('Catalog template response completeness (#976)', () => {
    it('includes imageUrl/imageEmbedding/createdAt/updatedAt on POST /api/catalog', async () => {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'template-976-create',
          name: 'Response completeness template',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
        }),
      });
      expect(created.response.status).toBe(201);
      expect(created.body.template).toMatchObject({ imageUrl: null, imageEmbedding: null });
      expect(created.body.template.createdAt).toBeTruthy();
      expect(created.body.template.updatedAt).toBeTruthy();
    });

    it('includes imageUrl/imageEmbedding/createdAt/updatedAt on PATCH /api/catalog/:templateId', async () => {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'template-976-patch',
          name: 'Response completeness template',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
        }),
      });
      expect(created.response.status).toBe(201);

      const patched = await api('/catalog/template-976-patch', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed response completeness template' }),
      });
      expect(patched.response.status).toBe(200);
      expect(patched.body.template).toMatchObject({ name: 'Renamed response completeness template', imageUrl: null, imageEmbedding: null });
      expect(patched.body.template.createdAt).toBeTruthy();
      expect(patched.body.template.updatedAt).toBeTruthy();
    });
  });

  // #1742: same lost-update race #468 already fixed for bundles -- the old
  // code merged whichever field a PATCH omitted in from a snapshot read at
  // the top of the request, so two concurrent partial PATCHes to different
  // fields each overwrote the other's just-written field with a stale
  // value once their own UPDATE landed.
  describe('Catalog template PATCH concurrent-edit race (#1742)', () => {
    it('does not let a concurrent rename and price change clobber each other', async () => {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'template-1742-race',
          name: 'Race template',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 100,
        }),
      });
      expect(created.response.status).toBe(201);

      const [renamed, priced] = await Promise.all([
        api('/catalog/template-1742-race', { method: 'PATCH', body: JSON.stringify({ name: 'Raced rename' }) }),
        api('/catalog/template-1742-race', { method: 'PATCH', body: JSON.stringify({ priceCents: 500 }) }),
      ]);
      expect(renamed.response.status).toBe(200);
      expect(priced.response.status).toBe(200);

      const row = await env.DB.prepare('SELECT * FROM catalog_templates WHERE template_id = ?')
        .bind('template-1742-race').first();
      expect(row.name).toBe('Raced rename');
      expect(row.price_cents).toBe(500);
    });

    // A bare `null` sentinel in the UPDATE's own COALESCE would be
    // indistinguishable from "this field was omitted" -- these fields use
    // an explicit presence flag instead specifically so an omitted field
    // (left alone) and an explicitly-nulled one (cleared) stay distinguishable.
    it('still allows explicitly clearing subcategory/priceCents to null, and leaves them alone when genuinely omitted', async () => {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'template-1742-clear',
          name: 'Clear template',
          subcategory: 'chairs',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 100,
        }),
      });
      expect(created.response.status).toBe(201);
      expect(created.body.template.subcategory).toBe('chairs');

      const cleared = await api('/catalog/template-1742-clear', {
        method: 'PATCH', body: JSON.stringify({ subcategory: null, priceCents: null }),
      });
      expect(cleared.response.status).toBe(200);
      expect(cleared.body.template.subcategory).toBeNull();
      expect(cleared.body.template.priceCents).toBeNull();

      const untouched = await api('/catalog/template-1742-clear', {
        method: 'PATCH', body: JSON.stringify({ name: 'Still clear template' }),
      });
      expect(untouched.response.status).toBe(200);
      expect(untouched.body.template.subcategory).toBeNull();
      expect(untouched.body.template.priceCents).toBeNull();
    });
  });

  // #1807: metadata_json was the one column #1742 deliberately left
  // unconditional (see that handler's own comment) -- so a PATCH that
  // never touches metadata at all (a plain price change, say) still
  // re-wrote metadata_json from its own stale pre-race snapshot, silently
  // reverting a concurrent metadata-only save (digital-good flag,
  // no-returns, ...) racing against it. Forces the exact interleaving that
  // reproduces it: hooks the price-only PATCH's own UPDATE call to run the
  // metadata-only PATCH to completion first, so the metadata change is
  // already committed by the time the price-only PATCH's stale snapshot
  // gets written -- matching "whichever PATCH omits a field commits its
  // own stale copy of it last" rather than relying on real scheduling.
  describe('Catalog template PATCH concurrent-edit race on metadata (#1807)', () => {
    it('does not let a price-only PATCH silently revert a concurrent metadata-only save', async () => {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'template-1807-race',
          name: 'Metadata race template',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 100,
          metadata: { placeholder: true },
        }),
      });
      expect(created.response.status).toBe(201);

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (armed && sql.includes('UPDATE catalog_templates') && sql.includes('SET name = COALESCE')) {
          const originalBind = stmt.bind.bind(stmt);
          return {
            bind: (...bindArgs) => {
              const bound = originalBind(...bindArgs);
              const originalRun = bound.run.bind(bound);
              bound.run = async () => {
                armed = false;
                // The metadata-only PATCH must actually commit before this
                // price-only PATCH's own UPDATE runs, not just be fired --
                // awaiting it here (rather than firing it unawaited
                // alongside this one) is what makes the test deterministic
                // instead of a coin flip on which write lands first, same
                // reasoning avatar-ownership.test.js's own #1261 test gives
                // for its own await.
                await api('/catalog/template-1807-race', {
                  method: 'PATCH', body: JSON.stringify({ metadata: { placeholder: true, noReturns: true } }),
                });
                return originalRun();
              };
              return bound;
            },
          };
        }
        return stmt;
      };
      let priced;
      try {
        priced = await api('/catalog/template-1807-race', { method: 'PATCH', body: JSON.stringify({ priceCents: 500 }) });
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(priced.response.status).toBe(200);

      const row = await env.DB.prepare('SELECT * FROM catalog_templates WHERE template_id = ?')
        .bind('template-1807-race').first();
      expect(row.price_cents).toBe(500);
      expect(JSON.parse(row.metadata_json)).toEqual({ placeholder: true, noReturns: true });
    });
  });

  // #1824: the admin dashboard's purchases-fallback panel (refund/
  // mark-shipped for a purchase whose seller_id is dangling) had no way to
  // find the purchases it exists for -- GET /purchases's existing
  // builderId/templateId filters both need the caller to already know
  // which builder/template to ask for. danglingSeller lists every
  // purchase whose seller_id is non-null but no longer in `sellers`,
  // admin-only since nothing here is scoped back to the caller's own
  // session. Lives here, not alongside GET /purchases's sibling tests in
  // worker/commerce.test.js, because that file is already at the
  // #385/#390-established per-file test-count ceiling (vitest-pool-
  // workers/workerd's own V8 stack limit for one isolate) -- see #1853.
  describe('GET /purchases?danglingSeller=1 (#1824)', () => {
    async function createGreenbeltLandletWithArea(landletId, areaM2) {
      return api('/landlets', adminSession({
        method: 'POST',
        body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
      }));
    }

    async function claim(landletId, builder) {
      return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
    }

    async function placeInstance(instanceId, landletId, templateId, builder) {
      const placed = await api('/instances', builder.session({
        method: 'POST',
        body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
      }));
      expect(placed.response.status).toBe(201);
      return instanceId;
    }

    it('lists purchases with a dangling seller_id, admin-only', async () => {
      const seller = await signupSeller('purchase-dangling-seller');
      const builder = await signupAdmin('purchase-dangling-seller-builder');
      await createGreenbeltLandletWithArea('purchase-dangling-seller-landlet', 1000);
      await claim('purchase-dangling-seller-landlet', builder);
      const created = await api('/catalog', seller.session({
        method: 'POST',
        body: JSON.stringify({
          templateId: 'purchase-dangling-seller-template',
          name: 'Product whose seller later deletes their account',
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
          priceCents: 1500,
          sellerId: seller.sellerId,
        }),
      }));
      expect(created.response.status).toBe(201);
      await placeInstance('purchase-dangling-seller-instance', 'purchase-dangling-seller-landlet', 'purchase-dangling-seller-template', builder);
      const purchased = await api('/instances/purchase-dangling-seller-instance/purchase', builder.session({ method: 'POST' }));
      expect(purchased.response.status).toBe(201);

      // Not listed yet — this seller still exists, so this purchase's own
      // seller_id isn't dangling.
      const beforeDelete = await api('/purchases?danglingSeller=1', adminSession());
      expect(beforeDelete.response.status).toBe(200);
      expect(beforeDelete.body.purchases).not.toContainEqual(
        expect.objectContaining({ purchaseId: purchased.body.purchase.purchaseId }),
      );

      const sellerDeleted = await api(`/sellers/${seller.sellerId}`, seller.session({ method: 'DELETE' }));
      expect(sellerDeleted.response.status).toBe(200);

      const nonAdmin = await signupBuilder('purchase-dangling-seller-nonadmin');
      const wrongSession = await api('/purchases?danglingSeller=1', nonAdmin.session());
      expect(wrongSession.response.status).toBe(403);

      const unauthenticated = await api('/purchases?danglingSeller=1');
      expect(unauthenticated.response.status).toBe(401);

      const asAdmin = await api('/purchases?danglingSeller=1', adminSession());
      expect(asAdmin.response.status).toBe(200);
      expect(asAdmin.body.purchases).toContainEqual(
        expect.objectContaining({ purchaseId: purchased.body.purchase.purchaseId, sellerId: seller.sellerId }),
      );
    });
  });

  // #729: saved_layout_instances and version_instances both hold a
  // template_id under ON DELETE RESTRICT (see migrations/0080 and 0007's
  // own comments), so a template referenced only by one of these snapshot
  // tables — with zero live placed_instances left — used to fall through
  // to a generic "still in use" 409 indistinguishable from a template
  // that's actually still placed somewhere. Uses freshly-created,
  // otherwise-unreferenced templates (never 'placeholder-tree', which is
  // shared across dozens of other tests in this file and must stay
  // deletable-in-theory for them).
  describe('Catalog template deletion blocked by a snapshot reference (#729)', () => {
    async function createTemplate(templateId) {
      const created = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId,
          name: `Test template ${templateId}`,
          color: '#123456',
          dimensions: { width: 1, depth: 1, height: 1 },
        }),
      });
      expect(created.response.status).toBe(201);
      return templateId;
    }

    it("blocks deleting a template still referenced by a stranger's saved layout, with a distinct message", async () => {
      const templateId = await createTemplate('template-729-saved-layout');
      const owner = await signupBuilder('template-729-saved-layout-owner');
      const landletId = 'template-729-saved-layout-landlet';
      await createGreenbeltLandletWithArea(landletId, 1000);
      await claim(landletId, owner);
      await growLandCapHeadroom(owner.builderId);
      await api(`/landlets/${landletId}/levels`, owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
      const placed = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: `${landletId}-upper`, landletId, templateId, x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
        }),
      }));
      expect(placed.response.status).toBe(201);
      // Removing the level auto-snapshots it into saved_layout_instances
      // (#633) and deletes the live placed_instances row — the template
      // has zero live instances left after this, only the snapshot.
      const removed = await api(`/landlets/${landletId}/levels/1`, owner.session({ method: 'DELETE' }));
      expect(removed.response.status).toBe(200);
      const { results: live } = await env.DB.prepare('SELECT 1 FROM placed_instances WHERE template_id = ?')
        .bind(templateId).all();
      expect(live).toHaveLength(0);

      // Deleted by a stranger — not the owner of the saved layout at all —
      // matching the issue's own "stranger's private saved-layout snapshot"
      // framing: the blocker isn't visible to this caller in any way.
      const deleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
      expect(deleted.response.status).toBe(409);
      expect(deleted.body.error).toMatch(/referenced by a saved layout/);
      expect(deleted.body.error).not.toMatch(/still in use/);

      const { results: stillExists } = await env.DB.prepare('SELECT 1 FROM catalog_templates WHERE template_id = ?')
        .bind(templateId).all();
      expect(stillExists).toHaveLength(1);
    });

    it("blocks deleting a template still referenced by a landlet's version history, with a distinct message", async () => {
      const templateId = await createTemplate('template-729-version');
      const owner = await signupBuilder('template-729-version-owner');
      const landletId = 'template-729-version-landlet';
      await createGreenbeltLandletWithArea(landletId, 1000);
      await claim(landletId, owner);
      const placed = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: `${landletId}-inst`, landletId, templateId, x: 1, y: 1, z: 0 }),
      }));
      expect(placed.response.status).toBe(201);
      const version = await api(`/landlets/${landletId}/versions`, owner.session({
        method: 'POST', body: JSON.stringify({}),
      }));
      expect(version.response.status).toBe(201);
      // The live instance is removed afterward, so only the version
      // snapshot (version_instances) still references the template.
      const removedInstance = await api(`/instances/${landletId}-inst`, owner.session({ method: 'DELETE' }));
      expect(removedInstance.response.status).toBe(200);

      const deleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
      expect(deleted.response.status).toBe(409);
      expect(deleted.body.error).toMatch(/referenced by a landlet's version history/);
      expect(deleted.body.error).not.toMatch(/still in use/);
    });

    it('blocks deleting a template still actually placed on a landlet, with a distinct message (#1706)', async () => {
      const templateId = await createTemplate('template-1706-placed');
      const owner = await signupBuilder('template-1706-placed-owner');
      const landletId = 'template-1706-placed-landlet';
      await createGreenbeltLandletWithArea(landletId, 1000);
      await claim(landletId, owner);
      const placed = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: `${landletId}-inst`, landletId, templateId, x: 1, y: 1, z: 0 }),
      }));
      expect(placed.response.status).toBe(201);

      const deleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
      expect(deleted.response.status).toBe(409);
      expect(deleted.body.error).toMatch(/still placed on a landlet/);
      expect(deleted.body.error).not.toMatch(/still in use/);

      const { results: stillExists } = await env.DB.prepare('SELECT 1 FROM catalog_templates WHERE template_id = ?')
        .bind(templateId).all();
      expect(stillExists).toHaveLength(1);
    });

    // #2315: archived_version_instances (migrations/0140, the inactivity-
    // reclaim "preserve version history" feature) carries the same
    // ON DELETE RESTRICT on template_id as version_instances above, but
    // was added after this precheck's own #1706 audit and never got wired
    // in -- a template only referenced by an archived version snapshot
    // used to fall through to the generic "still in use" 409. Inserts
    // directly into both archived tables (same idiom
    // export-data.test.js's own "#2185" tests use) rather than driving a
    // full inactivity-auction resolution, since only the schema shape
    // matters here, not how a row gets there.
    it('blocks deleting a template still referenced by an archived version snapshot, with a distinct message (#2315)', async () => {
      const templateId = await createTemplate('template-2315-archived-version');
      const owner = await signupBuilder('template-2315-archived-version-owner');
      await env.DB.prepare(`
        INSERT INTO archived_landlet_versions (version_id, builder_id, version_number, name, created_at)
        VALUES (?, ?, 1, 'archived-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).bind('template-2315-archived-version', owner.builderId).run();
      await env.DB.prepare(`
        INSERT INTO archived_version_instances (version_id, source_instance_id, template_id, x_m, y_m, z_m)
        VALUES (?, ?, ?, 1, 1, 0)
      `).bind('template-2315-archived-version', 'template-2315-archived-version-inst', templateId).run();

      const deleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
      expect(deleted.response.status).toBe(409);
      expect(deleted.body.error).toMatch(/referenced by an archived version snapshot/);
      expect(deleted.body.error).not.toMatch(/still in use/);

      const { results: stillExists } = await env.DB.prepare('SELECT 1 FROM catalog_templates WHERE template_id = ?')
        .bind(templateId).all();
      expect(stillExists).toHaveLength(1);
    });

    it('deletes a template cleanly once its only saved-layout reference is gone', async () => {
      const templateId = await createTemplate('template-729-cleared');
      const owner = await signupBuilder('template-729-cleared-owner');
      const landletId = 'template-729-cleared-landlet';
      await createGreenbeltLandletWithArea(landletId, 1000);
      await claim(landletId, owner);
      await growLandCapHeadroom(owner.builderId);
      await api(`/landlets/${landletId}/levels`, owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
      await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: `${landletId}-upper`, landletId, templateId, x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
        }),
      }));
      await api(`/landlets/${landletId}/levels/1`, owner.session({ method: 'DELETE' }));
      const { results } = await env.DB.prepare('SELECT * FROM saved_level_layouts WHERE builder_id = ?')
        .bind(owner.builderId).all();
      const savedLayoutId = results[0].saved_layout_id;

      const blocked = await api(`/catalog/${templateId}`, { method: 'DELETE' });
      expect(blocked.response.status).toBe(409);

      const layoutDeleted = await api(`/saved-layouts/${savedLayoutId}`, owner.session({ method: 'DELETE' }));
      expect(layoutDeleted.response.status).toBe(200);

      const deleted = await api(`/catalog/${templateId}`, { method: 'DELETE' });
      expect(deleted.response.status).toBe(200);
      expect(deleted.body.deleted).toBe(true);
    });
  });

  // Found via backlog audit (#395): the outermost-level DELETE used to run
  // a plain SELECT-then-DELETE with no guard tying the delete to the
  // extent it was read against. Racing two DELETEs against the exact same
  // level is deterministic regardless of request interleaving (unlike
  // racing two adds, which both legitimately succeed with different
  // indexes whenever they happen to run sequentially) — same shape as the
  // calendar-trigger race test above and the bid-race test in
  // commerce.test.js, both of which race identical requests for the same
  // reason. Exactly one DELETE can ever actually remove the row.
  it('lets exactly one of two concurrent deletes for the same level succeed', async () => {
    const owner = await signupBuilder('levels-remove-race-owner');
    await createGreenbeltLandletWithArea('levels-remove-race-landlet', 1000);
    await claim('levels-remove-race-landlet', owner);
    await growLandCapHeadroom(owner.builderId);
    await api('/landlets/levels-remove-race-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

    const [first, second] = await Promise.all([
      api('/landlets/levels-remove-race-landlet/levels/1', owner.session({ method: 'DELETE' })),
      api('/landlets/levels-remove-race-landlet/levels/1', owner.session({ method: 'DELETE' })),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);

    const list = await api('/landlets/levels-remove-race-landlet/levels');
    expect(list.body.levels).toEqual([]);
  });

  it('folds level cap consumption into the owning builder\'s land cap growth formula', async () => {
    const owner = await signupBuilder('levels-cap-owner');
    await createGreenbeltLandletWithArea('levels-cap-landlet', 1000);
    await claim('levels-cap-landlet', owner);
    const levelCapM2 = expectedCapConsumedM2(1000, 1);
    // Seeded directly rather than through POST /levels (now gated by
    // #489's land cap check — see growLandCapHeadroom's own comment above
    // on why that endpoint isn't usable here): this test measures the
    // cap-growth FORMULA's exact output, which any headroom big enough to
    // pass the gate would itself ratchet the cap past.
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('levels-cap-seed', 'levels-cap-landlet', 1, levelCapM2).run();

    // $40 trailing earnings, normalized against (1000 ground + the level's
    // own consumed area) instead of just 1000 — a strictly smaller land
    // cap increase than the plain "1000 m² owned" Land cap formula test
    // above gets from the same $40, proving the level's own area was
    // actually folded into the normalization.
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('levels-cap-earning', owner.builderId, 4000).run();
    // #717's bounded ids= lookup, not the plain unfiltered (#715-paginated,
    // 100/page) list — this test's own builder isn't guaranteed to land on
    // page 1 once enough other builders exist earlier in this cumulative
    // test file's run.
    const afterAdd = (await api(`/builders?ids=${owner.builderId}`)).body.builders.find((b) => b.builderId === owner.builderId).landCapM2;
    const expectedIncrease = Math.floor((40 / ((1000 + levelCapM2) / 1000)) * 100);
    expect(afterAdd).toBe(1000 + expectedIncrease);
    expect(afterAdd).toBeLessThan(5000); // strictly less than the no-levels 1000m2-owned case
  });

  it('exposes ownedAreaM2 on the builder object, including level area (#312)', async () => {
    const owner = await signupBuilder('levels-owned-area-owner');
    await createGreenbeltLandletWithArea('levels-owned-area-landlet', 1000);
    await claim('levels-owned-area-landlet', owner);
    const levelCapM2 = expectedCapConsumedM2(1000, 1);
    // Seeded directly — see the cap-growth-formula test's own comment
    // above on why POST /levels isn't used here now that #489 gates it.
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('levels-owned-area-seed', 'levels-owned-area-landlet', 1, levelCapM2).run();
    const expectedOwnedAreaM2 = 1000 + levelCapM2;

    // #717's bounded ids= lookup, not the plain unfiltered (#715-paginated,
    // 100/page) list — same reasoning as the cap-growth-formula test above.
    const listed = (await api(`/builders?ids=${owner.builderId}`)).body.builders.find((b) => b.builderId === owner.builderId);
    expect(listed.ownedAreaM2).toBe(expectedOwnedAreaM2);

    const me = await api('/builders/me', owner.session());
    expect(me.body.builder.ownedAreaM2).toBe(expectedOwnedAreaM2);
  });

  it('leaves ownedAreaM2 null on a builder response that never recomputed it (plain create)', async () => {
    const created = await api('/builders', { method: 'POST', body: JSON.stringify({ label: 'Owned Area Null Builder' }) });
    expect(created.body.builder.ownedAreaM2).toBeNull();
  });

  it('cascades landlet_levels cleanup on builder deletion, same as placed_instances/landlet_versions', async () => {
    const owner = await signupBuilder('levels-delete-owner');
    await createGreenbeltLandletWithArea('levels-delete-landlet', 1000);
    await claim('levels-delete-landlet', owner);
    // Seeded directly — this test only cares that an existing level row
    // gets cascade-deleted, not how it got there, and #489's land cap gate
    // on POST /levels makes that endpoint no longer the cheapest way to
    // set this precondition up.
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('levels-delete-seed', 'levels-delete-landlet', 1, expectedCapConsumedM2(1000, 1)).run();

    await api(`/builders/${owner.builderId}`, owner.session({ method: 'DELETE' }));
    const { results } = await env.DB.prepare('SELECT * FROM landlet_levels WHERE landlet_id = ?')
      .bind('levels-delete-landlet').all();
    expect(results).toHaveLength(0);
  });

  it('rejects digging down once the level footprint would fall below the 10m² minimum', async () => {
    const owner = await signupBuilder('levels-min-footprint-owner');
    // Small enough that even the very first level down already dips under
    // the 10m² floor — a realistic-sized (~1000m²) lándlet would need to
    // dig hundreds of thousands of levels deep to ever reach this, so a
    // tiny lándlet is the only practical way to exercise the check at all.
    // Going up is unaffected either way (the cone only narrows going down).
    await createGreenbeltLandletWithArea('levels-min-footprint-landlet', 5);
    await claim('levels-min-footprint-landlet', owner);

    const down = await api('/landlets/levels-min-footprint-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'down' }),
    }));
    expect(down.response.status).toBe(409);
    expect(down.body.error).toContain('10m²');

    const up = await api('/landlets/levels-min-footprint-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    expect(up.response.status).toBe(201);

    const list = await api('/landlets/levels-min-footprint-landlet/levels');
    expect(list.body.levels.map((level) => level.levelIndex)).toEqual([1]);
  });

  it('rejects digging down past Earth\'s center even for a hypothetically enormous lándlet', async () => {
    // Directly seeds a level one step short of the hard depth floor —
    // reaching it by actually POSTing one level at a time (LEVEL_HEIGHT_M
    // at a time, down to -earthRadiusM) would take hundreds of thousands
    // of requests, same practical problem as the 10m² test above. This
    // isolates the depth check itself, which the 10m² floor otherwise
    // always trips first for any real (positive-area) lándlet — see
    // MIN_LEVEL_FOOTPRINT_M2's own comment in worker/index.js.
    const owner = await signupBuilder('levels-earth-center-owner');
    await createGreenbeltLandletWithArea('levels-earth-center-landlet', 1000);
    await claim('levels-earth-center-landlet', owner);
    const secondToLastLevelIndex = Math.round(DEFAULT_EARTH_RADIUS_M / LEVEL_HEIGHT_M) - 1;
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('levels-earth-center-seed', 'levels-earth-center-landlet', -secondToLastLevelIndex, 0.01).run();

    const down = await api('/landlets/levels-earth-center-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'down' }),
    }));
    expect(down.response.status).toBe(409);
    expect(down.body.error).toMatch(/center/i);
  });

  // #394: nothing previously stopped placing an instance's z arbitrarily
  // high/deep without ever buying the level through this file's own
  // endpoint above — bypassing the land-cap cost that endpoint charges.
  describe('instance z bounds (#394)', () => {
    it('allows an instance within one level height of ground on a lándlet with no levels purchased', async () => {
      const owner = await signupBuilder('instance-z-no-levels-owner');
      await createGreenbeltLandletWithArea('instance-z-no-levels-landlet', 1000);
      await claim('instance-z-no-levels-landlet', owner);

      const withinRange = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-within-no-levels',
          landletId: 'instance-z-no-levels-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: LEVEL_HEIGHT_M / 2,
        }),
      }));
      expect(withinRange.response.status).toBe(201);
    });

    it('rejects an instance z beyond one level height of ground with no levels purchased', async () => {
      const owner = await signupBuilder('instance-z-reject-owner');
      await createGreenbeltLandletWithArea('instance-z-reject-landlet', 1000);
      await claim('instance-z-reject-landlet', owner);

      const tooHigh = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-too-high',
          landletId: 'instance-z-reject-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: LEVEL_HEIGHT_M * 2,
        }),
      }));
      expect(tooHigh.response.status).toBe(400);
      expect(tooHigh.body.error).toMatch(/purchased levels/);

      const tooDeep = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-too-deep',
          landletId: 'instance-z-reject-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: -LEVEL_HEIGHT_M * 2,
        }),
      }));
      expect(tooDeep.response.status).toBe(400);
    });

    it('extends the allowed instance z range as levels are purchased, in both directions', async () => {
      const owner = await signupBuilder('instance-z-extend-owner');
      await createGreenbeltLandletWithArea('instance-z-extend-landlet', 1000);
      await claim('instance-z-extend-landlet', owner);
      await growLandCapHeadroom(owner.builderId);
      await api('/landlets/instance-z-extend-landlet/levels', owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));

      const nowInRange = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-now-in-range',
          landletId: 'instance-z-extend-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5,
        }),
      }));
      expect(nowInRange.response.status).toBe(201);

      const stillOutOfRange = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-still-out',
          landletId: 'instance-z-extend-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: LEVEL_HEIGHT_M * 2.5,
        }),
      }));
      expect(stillOutOfRange.response.status).toBe(400);

      // Downward is unaffected by an upward-only purchase.
      const downStillOutOfRange = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-down-still-out',
          landletId: 'instance-z-extend-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: -LEVEL_HEIGHT_M * 2,
        }),
      }));
      expect(downStillOutOfRange.response.status).toBe(400);
    });

    it('rejects moving an existing instance\'s z out of range via PATCH, but leaves an untouched out-of-range z alone', async () => {
      const owner = await signupBuilder('instance-z-patch-owner');
      await createGreenbeltLandletWithArea('instance-z-patch-landlet', 1000);
      await claim('instance-z-patch-landlet', owner);
      const created = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-z-patch-target',
          landletId: 'instance-z-patch-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: 0,
        }),
      }));
      expect(created.response.status).toBe(201);

      const movedOutOfRange = await api('/instances/instance-z-patch-target', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ z: LEVEL_HEIGHT_M * 5 }),
      }));
      expect(movedOutOfRange.response.status).toBe(400);

      // A grandfathered-in out-of-range z (e.g. from before this check
      // existed, or a level removed out from under it) directly seeded —
      // an unrelated field-only PATCH that never touches z must not
      // suddenly start re-validating and bricking it, the same
      // "only re-check what actually changed" reasoning already applied
      // to crop/template above.
      await env.DB.prepare(
        "UPDATE placed_instances SET z_m = ? WHERE instance_id = 'instance-z-patch-target'",
      ).bind(LEVEL_HEIGHT_M * 5).run();
      const unrelatedPatch = await api('/instances/instance-z-patch-target', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ label: 'Renamed' }),
      }));
      expect(unrelatedPatch.response.status).toBe(200);
      expect(unrelatedPatch.body.instance.label).toBe('Renamed');
      expect(unrelatedPatch.body.instance.z).toBe(LEVEL_HEIGHT_M * 5);
    });

    it('applies the same z bounds to the lándlet draft save endpoint', async () => {
      const owner = await signupBuilder('instance-z-draft-owner');
      await createGreenbeltLandletWithArea('instance-z-draft-landlet', 1000);
      await claim('instance-z-draft-landlet', owner);

      const rejected = await api('/landlets/instance-z-draft-landlet/draft', owner.session({
        method: 'PUT',
        body: JSON.stringify({
          instances: [{
            instanceId: 'instance-z-draft-out-of-range',
            templateId: 'placeholder-tree',
            x: 1, y: 1, z: LEVEL_HEIGHT_M * 3,
          }],
        }),
      }));
      expect(rejected.response.status).toBe(400);

      const accepted = await api('/landlets/instance-z-draft-landlet/draft', owner.session({
        method: 'PUT',
        body: JSON.stringify({
          instances: [{
            instanceId: 'instance-z-draft-in-range',
            templateId: 'placeholder-tree',
            x: 1, y: 1, z: 0,
          }],
        }),
      }));
      expect(accepted.response.status).toBe(200);
    });
  });

  // #789: same underlying gap as #394 above, but for x/y instead of z —
  // a raw API write could set an instance's horizontal position to any
  // finite value with nothing server-side enforcing it stays anywhere near
  // its own landlet, even though the frontend's own clampToLandlet always
  // has. LANDLET_SIDE_M = sqrt(1000) ≈ 31.62, so ±15.81 is the fixed
  // buildable-footprint half-span every landlet shares (independent of its
  // own area_m2 — see #746).
  describe('instance x/y bounds (#789)', () => {
    it('allows an instance within its landlet\'s buildable footprint', async () => {
      const owner = await signupBuilder('instance-xy-within-owner');
      await createGreenbeltLandletWithArea('instance-xy-within-landlet', 1000);
      await claim('instance-xy-within-landlet', owner);

      const withinRange = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-xy-within',
          landletId: 'instance-xy-within-landlet',
          templateId: 'placeholder-tree',
          x: 15, y: -15, z: 0,
        }),
      }));
      expect(withinRange.response.status).toBe(201);
    });

    it('rejects an instance x/y placed far outside its landlet\'s buildable footprint', async () => {
      const owner = await signupBuilder('instance-xy-reject-owner');
      await createGreenbeltLandletWithArea('instance-xy-reject-landlet', 1000);
      await claim('instance-xy-reject-landlet', owner);

      const tooFarX = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-xy-too-far-x',
          landletId: 'instance-xy-reject-landlet',
          templateId: 'placeholder-tree',
          x: 10000, y: 0, z: 0,
        }),
      }));
      expect(tooFarX.response.status).toBe(400);
      expect(tooFarX.body.error).toMatch(/buildable footprint/);

      const tooFarY = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-xy-too-far-y',
          landletId: 'instance-xy-reject-landlet',
          templateId: 'placeholder-tree',
          x: 0, y: -10000, z: 0,
        }),
      }));
      expect(tooFarY.response.status).toBe(400);
    });

    it('rejects moving an existing instance\'s x/y out of range via PATCH, but leaves an untouched out-of-range x/y alone', async () => {
      const owner = await signupBuilder('instance-xy-patch-owner');
      await createGreenbeltLandletWithArea('instance-xy-patch-landlet', 1000);
      await claim('instance-xy-patch-landlet', owner);
      const created = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-xy-patch-target',
          landletId: 'instance-xy-patch-landlet',
          templateId: 'placeholder-tree',
          x: 1, y: 1, z: 0,
        }),
      }));
      expect(created.response.status).toBe(201);

      const movedOutOfRange = await api('/instances/instance-xy-patch-target', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ x: 10000 }),
      }));
      expect(movedOutOfRange.response.status).toBe(400);

      // A grandfathered-in out-of-range x/y (e.g. from before this check
      // existed) directly seeded — an unrelated field-only PATCH that
      // never touches x/y must not suddenly start re-validating and
      // bricking it, the same "only re-check what actually changed"
      // reasoning already applied to crop/z above.
      await env.DB.prepare(
        "UPDATE placed_instances SET x_m = ? WHERE instance_id = 'instance-xy-patch-target'",
      ).bind(10000).run();
      const unrelatedPatch = await api('/instances/instance-xy-patch-target', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ label: 'Renamed' }),
      }));
      expect(unrelatedPatch.response.status).toBe(200);
      expect(unrelatedPatch.body.instance.label).toBe('Renamed');
      expect(unrelatedPatch.body.instance.x).toBe(10000);
    });

    it('applies the same x/y bounds to the lándlet draft save and batch endpoints', async () => {
      const owner = await signupBuilder('instance-xy-draft-owner');
      await createGreenbeltLandletWithArea('instance-xy-draft-landlet', 1000);
      await claim('instance-xy-draft-landlet', owner);

      const rejectedDraft = await api('/landlets/instance-xy-draft-landlet/draft', owner.session({
        method: 'PUT',
        body: JSON.stringify({
          instances: [{
            instanceId: 'instance-xy-draft-out-of-range',
            templateId: 'placeholder-tree',
            x: 10000, y: 0, z: 0,
          }],
        }),
      }));
      expect(rejectedDraft.response.status).toBe(400);

      const rejectedBatch = await api('/instances/batch', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instances: [{
            instanceId: 'instance-xy-batch-out-of-range',
            landletId: 'instance-xy-draft-landlet',
            templateId: 'placeholder-tree',
            x: 0, y: 10000, z: 0,
          }],
        }),
      }));
      expect(rejectedBatch.response.status).toBe(400);
    });
  });

  describe('instance scale bounds (#845)', () => {
    it('allows an instance with scale within the legacy Resize gizmo\'s [0.001, 1000] range, placed so its scaled footprint still fits', async () => {
      const owner = await signupBuilder('instance-scale-within-owner');
      await createGreenbeltLandletWithArea('instance-scale-within-landlet', 1000);
      await claim('instance-scale-within-landlet', owner);

      // placeholder-tree is 1.5m x 1.5m — scale: 5 gives a 7.5m x 7.5m
      // footprint, comfortably inside the landlet's fixed ~15.8m half-span
      // (LANDLET_AREA_M2 = 1000) even before #1048's footprint-aware check.
      const withinRange = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-scale-within',
          landletId: 'instance-scale-within-landlet',
          templateId: 'placeholder-tree',
          x: 0, y: 0, z: 0,
          scale: 5,
        }),
      }));
      expect(withinRange.response.status).toBe(201);
    });

    // #1048: this used to be the exact vulnerability -- scale: 500 is well
    // within assertInstanceScaleWithinBounds' own [0.001, 1000] range (so
    // that check alone accepted it), and x: 0/y: 0 is dead center of the
    // landlet (so the old center-point-only assertInstanceXYWithinLandlet
    // accepted it too) -- but a scale-500 placeholder-tree (1.5m x 1.5m)
    // renders as 750m x 750m, vastly larger than the landlet's own ~31.6m
    // buildable footprint. This test used to assert 201 here; now that
    // assertInstanceXYWithinLandlet accounts for scale (and crop), it
    // correctly rejects.
    it('rejects a scale within [0.001, 1000] whose resulting footprint still doesn\'t fit the landlet', async () => {
      const owner = await signupBuilder('instance-scale-footprint-owner');
      await createGreenbeltLandletWithArea('instance-scale-footprint-landlet', 1000);
      await claim('instance-scale-footprint-landlet', owner);

      const tooBigForLandlet = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-scale-footprint',
          landletId: 'instance-scale-footprint-landlet',
          templateId: 'placeholder-tree',
          x: 0, y: 0, z: 0,
          scale: 500,
        }),
      }));
      expect(tooBigForLandlet.response.status).toBe(400);
      expect(tooBigForLandlet.body.error).toMatch(/extends outside landlet/);
    });

    it('rejects an instance scale far outside the legacy Resize gizmo\'s range', async () => {
      const owner = await signupBuilder('instance-scale-reject-owner');
      await createGreenbeltLandletWithArea('instance-scale-reject-landlet', 1000);
      await claim('instance-scale-reject-landlet', owner);

      // This own [0.001, 1000] domain bound is checked before the
      // footprint-aware XY check (see #1048), so a scale this far outside
      // range still gets its own specific "scale must be between" error
      // rather than the XY check's "extends outside landlet" one.
      const tooLarge = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-scale-too-large',
          landletId: 'instance-scale-reject-landlet',
          templateId: 'placeholder-tree',
          x: 0, y: 0, z: 0,
          scale: 1e6,
        }),
      }));
      expect(tooLarge.response.status).toBe(400);
      expect(tooLarge.body.error).toMatch(/scale must be between/);

      const tooSmall = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-scale-too-small',
          landletId: 'instance-scale-reject-landlet',
          templateId: 'placeholder-tree',
          x: 0, y: 0, z: 0,
          scale: 1e-7,
        }),
      }));
      expect(tooSmall.response.status).toBe(400);
    });

    it('rejects changing an existing instance\'s scale out of range via PATCH, but leaves an untouched out-of-range scale alone', async () => {
      const owner = await signupBuilder('instance-scale-patch-owner');
      await createGreenbeltLandletWithArea('instance-scale-patch-landlet', 1000);
      await claim('instance-scale-patch-landlet', owner);
      const created = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: 'instance-scale-patch-target',
          landletId: 'instance-scale-patch-landlet',
          templateId: 'placeholder-tree',
          x: 0, y: 0, z: 0,
        }),
      }));
      expect(created.response.status).toBe(201);

      const scaledOutOfRange = await api('/instances/instance-scale-patch-target', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ scale: 1e6 }),
      }));
      expect(scaledOutOfRange.response.status).toBe(400);

      // A grandfathered-in out-of-range scale (e.g. from before this bound
      // existed) directly seeded — an unrelated field-only PATCH that never
      // touches scale must not suddenly start re-validating and bricking
      // it, the same "only re-check what actually changed" reasoning
      // already applied to crop/z/xy above.
      await env.DB.prepare(
        "UPDATE placed_instances SET scale = ? WHERE instance_id = 'instance-scale-patch-target'",
      ).bind(1e6).run();
      const unrelatedPatch = await api('/instances/instance-scale-patch-target', owner.session({
        method: 'PATCH',
        body: JSON.stringify({ label: 'Renamed' }),
      }));
      expect(unrelatedPatch.response.status).toBe(200);
      expect(unrelatedPatch.body.instance.label).toBe('Renamed');
      expect(unrelatedPatch.body.instance.scale).toBe(1e6);
    });

    it('applies the same scale bounds to the lándlet draft save and batch endpoints', async () => {
      const owner = await signupBuilder('instance-scale-draft-owner');
      await createGreenbeltLandletWithArea('instance-scale-draft-landlet', 1000);
      await claim('instance-scale-draft-landlet', owner);

      const rejectedDraft = await api('/landlets/instance-scale-draft-landlet/draft', owner.session({
        method: 'PUT',
        body: JSON.stringify({
          instances: [{
            instanceId: 'instance-scale-draft-out-of-range',
            templateId: 'placeholder-tree',
            x: 0, y: 0, z: 0,
            scale: 1e6,
          }],
        }),
      }));
      expect(rejectedDraft.response.status).toBe(400);

      const rejectedBatch = await api('/instances/batch', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instances: [{
            instanceId: 'instance-scale-batch-out-of-range',
            landletId: 'instance-scale-draft-landlet',
            templateId: 'placeholder-tree',
            x: 0, y: 0, z: 0,
            scale: 1e6,
          }],
        }),
      }));
      expect(rejectedBatch.response.status).toBe(400);
    });
  });
});
