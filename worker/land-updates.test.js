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


describe('Landlet updates', () => {
  it('does not let an unowned landlet be flipped to claimed with no owner via PUT/PATCH', async () => {
    await createGreenbeltLandlet('unowned-status-flip-landlet');
    const hijacked = await api('/landlets/unowned-status-flip-landlet', {
      method: 'PATCH', body: JSON.stringify({ status: 'claimed' }),
    });
    expect(hijacked.response.status).toBe(200);
    // The request's status is silently ignored, the same way ownerBuilderId
    // already is — the landlet stays available to claim normally instead of
    // being permanently stuck as claimed-with-no-owner.
    expect(hijacked.body.landlet.status).toBe('greenbelt');
    expect(hijacked.body.landlet.ownerBuilderId).toBeNull();

    const stored = await env.DB.prepare(
      'SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?',
    ).bind('unowned-status-flip-landlet').first();
    expect(stored.status).toBe('greenbelt');
    expect(stored.owner_builder_id).toBeNull();

    const stillClaimable = await api('/landlets/unowned-status-flip-landlet/claim', (await signupBuilder('status-flip-claimer')).session({ method: 'POST' }));
    expect(stillClaimable.response.status).toBe(200);
  });

  // #956: the pin above only ever applied to the unowned branch -- an
  // owning builder could PATCH their own claimed landlet's status away
  // from 'claimed' while keeping ownership, the "owner implies claimed"
  // half of #799's own invariant, just reachable here instead of via POST.
  // Left unfixed, this would drop the landlet out of POST .../claim's
  // "already own a claimed landlet" NOT EXISTS check, letting the same
  // builder claim unlimited additional landlets.
  it('does not let an owning builder move their own claimed landlet away from status claimed via PUT/PATCH', async () => {
    await createGreenbeltLandlet('owned-status-flip-landlet');
    const owner = await signupBuilder('owned-status-flip-claimer');
    const claimed = await api('/landlets/owned-status-flip-landlet/claim', owner.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const hijacked = await api('/landlets/owned-status-flip-landlet', owner.session({
      method: 'PATCH', body: JSON.stringify({ status: 'greenbelt' }),
    }));
    expect(hijacked.response.status).toBe(200);
    expect(hijacked.body.landlet.status).toBe('claimed');
    expect(hijacked.body.landlet.ownerBuilderId).toBe(owner.builderId);

    const stored = await env.DB.prepare(
      'SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?',
    ).bind('owned-status-flip-landlet').first();
    expect(stored.status).toBe('claimed');
    expect(stored.owner_builder_id).toBe(owner.builderId);

    // The one-claimed-landlet-per-builder cap must still hold -- this
    // builder can't claim a second landlet just because the PATCH above
    // silently no-op'd.
    await createGreenbeltLandlet('owned-status-flip-second-landlet');
    const secondClaim = await api('/landlets/owned-status-flip-second-landlet/claim', owner.session({ method: 'POST' }));
    expect(secondClaim.response.status).toBe(409);
  });

  // #1786: same pin gap as #956's status fix just above, for areaM2/
  // landClass instead -- an owning builder could shrink their own claimed
  // landlet's areaM2 via PUT/PATCH, bypassing recomputeLandCap's own
  // SUM(area_m2) land-cap accounting while keeping the same real,
  // LANDLET_AREA_M2-sized buildable footprint.
  it('does not let an owning builder change their own landlet\'s areaM2 or landClass via PUT/PATCH', async () => {
    await createGreenbeltLandlet('owned-area-class-flip-landlet');
    const owner = await signupBuilder('owned-area-class-flip-claimer');
    const claimed = await api('/landlets/owned-area-class-flip-landlet/claim', owner.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    const originalAreaM2 = claimed.body.landlet.areaM2;
    const originalLandClass = claimed.body.landlet.landClass;

    const hijacked = await api('/landlets/owned-area-class-flip-landlet', owner.session({
      method: 'PATCH', body: JSON.stringify({ areaM2: 0.01, landClass: 99 }),
    }));
    expect(hijacked.response.status).toBe(200);
    expect(hijacked.body.landlet.areaM2).toBe(originalAreaM2);
    expect(hijacked.body.landlet.landClass).toBe(originalLandClass);

    const stored = await env.DB.prepare(
      'SELECT area_m2, landlet_class FROM landlets WHERE landlet_id = ?',
    ).bind('owned-area-class-flip-landlet').first();
    expect(stored.area_m2).toBe(originalAreaM2);
    expect(stored.landlet_class).toBe(originalLandClass);
  });

  it('does not let a concurrent claim be reverted by a racing PATCH', async () => {
    // Fired together, not awaited one at a time — PATCH's own read of the
    // still-unowned row and its later write straddle the claim's write in
    // an unfixed version, letting the claim's status/owner_builder_id get
    // silently pinned back to the stale unowned values PATCH read earlier
    // (the request even reports 200, no trace anything was reverted).
    await createGreenbeltLandlet('patch-claim-race-landlet');
    const claimer = await signupBuilder('patch-claim-race-claimer');
    const [patched, claimed] = await Promise.all([
      api('/landlets/patch-claim-race-landlet', {
        method: 'PATCH', body: JSON.stringify({ name: 'Renamed mid-race' }),
      }),
      api('/landlets/patch-claim-race-landlet/claim', claimer.session({ method: 'POST' })),
    ]);
    expect(claimed.response.status).toBe(200);
    // A PATCH that loses the race gets a 409 instead of silently no-op'ing
    // over the claim; one that fully completes before the claim starts is
    // untouched by any of this and still succeeds normally. A third
    // legitimate outcome (#500): if the claim's write commits between this
    // PATCH's own initial read and its ownership check, the PATCH correctly
    // sees an owned landlet and requires a session it doesn't have — 401.
    expect([200, 401, 409]).toContain(patched.response.status);

    const stored = await env.DB.prepare(
      'SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?',
    ).bind('patch-claim-race-landlet').first();
    expect(stored.status).toBe('claimed');
    expect(stored.owner_builder_id).toBe(claimer.builderId);
  });

  it('does not let a concurrent claim be reverted (or the newly-claimed land deleted) by a racing DELETE', async () => {
    await createGreenbeltLandlet('delete-claim-race-landlet');
    const claimer = await signupBuilder('delete-claim-race-claimer');
    const [deleted, claimed] = await Promise.all([
      api('/landlets/delete-claim-race-landlet', { method: 'DELETE' }),
      api('/landlets/delete-claim-race-landlet/claim', claimer.session({ method: 'POST' })),
    ]);
    const stored = await env.DB.prepare(
      'SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?',
    ).bind('delete-claim-race-landlet').first();
    if (claimed.response.status === 200) {
      // The claim won — the landlet must still exist, claimed, not
      // silently deleted out from under its brand-new owner.
      expect(stored).not.toBeNull();
      expect(stored.status).toBe('claimed');
      expect(stored.owner_builder_id).toBe(claimer.builderId);
    } else {
      // The delete won first — the claim correctly found nothing left to claim.
      expect(deleted.response.status).toBe(200);
      expect(stored).toBeNull();
    }
  });

  it('still allows other field updates on an unowned landlet via PUT/PATCH', async () => {
    await createGreenbeltLandlet('unowned-rename-landlet');
    const renamed = await api('/landlets/unowned-rename-landlet', {
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed by admin tooling' }),
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.landlet.name).toBe('Renamed by admin tooling');
    expect(renamed.body.landlet.status).toBe('greenbelt');
  });

  // #2967: elevation_m was missing entirely from this endpoint's own
  // UPDATE SET clause -- the response reported the requested elevationM
  // back (built from the merged input, not a DB re-read), but the row's
  // real elevation_m column was never written. Confirmed via a fresh GET,
  // not just the PATCH response, same as worker-api.test.js's own
  // create-path elevationM round-trip test.
  it('persists elevationM through PATCH, confirmed via a fresh GET (#2967)', async () => {
    await createGreenbeltLandlet('unowned-elevation-landlet');
    const patched = await api('/landlets/unowned-elevation-landlet', {
      method: 'PATCH', body: JSON.stringify({ elevationM: 42.5 }),
    });
    expect(patched.response.status).toBe(200);
    expect(patched.body.landlet.elevationM).toBe(42.5);
    const refetched = await api('/landlets/unowned-elevation-landlet');
    expect(refetched.body.landlet.elevationM).toBe(42.5);
  });

  // #3005: Shop mode's periodic landlet-record re-sync (fetchAllLandlets,
  // this list endpoint) needs to tell a mid-session owner suspension apart
  // from an ordinary unchanged record, so it knows to drop that landlet's
  // now-hidden content client-side (#2993 already hides it server-side via
  // GET /instances; the client never knew to react). Confirms the new
  // ownerSuspended field this endpoint now computes is accurate in both
  // directions, and that it's false for every other landlet (no collateral
  // flag from the correlated subquery).
  it('reports ownerSuspended on GET /landlets (list) once the owner is suspended, and clears it once lifted (#3005)', async () => {
    const owner = await signupBuilder('ownersuspended-list-owner');
    const other = await signupBuilder('ownersuspended-list-other');
    await createGreenbeltLandlet('ownersuspended-list-landlet');
    await createGreenbeltLandlet('ownersuspended-list-other-landlet');
    await api('/landlets/ownersuspended-list-landlet/claim', owner.session({ method: 'POST' }));
    await api('/landlets/ownersuspended-list-other-landlet/claim', other.session({ method: 'POST' }));

    const beforeSuspend = await api(`/landlets?ownerBuilderId=${owner.builderId}`);
    expect(beforeSuspend.body.landlets[0].ownerSuspended).toBe(false);
    const otherBefore = await api(`/landlets?ownerBuilderId=${other.builderId}`);
    expect(otherBefore.body.landlets[0].ownerSuspended).toBe(false);

    await api('/auth/suspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: owner.email, reason: 'test for #3005' }),
    }));
    const duringSuspend = await api(`/landlets?ownerBuilderId=${owner.builderId}`);
    expect(duringSuspend.body.landlets[0].ownerSuspended).toBe(true);
    // The other builder's own landlet is unaffected -- not a global flag.
    const otherDuringSuspend = await api(`/landlets?ownerBuilderId=${other.builderId}`);
    expect(otherDuringSuspend.body.landlets[0].ownerSuspended).toBe(false);

    await api('/auth/unsuspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: owner.email }),
    }));
    const afterLift = await api(`/landlets?ownerBuilderId=${owner.builderId}`);
    expect(afterLift.body.landlets[0].ownerSuspended).toBe(false);
  });

  // #1150: a rename that collides with a *different* landlet's name
  // (including a same-letters-different-case collision) must be rejected
  // with a message that actually explains why, not databaseHttpError's
  // generic "Resource already exists" 409 (or, worse, a silent success).
  // Enforced via an atomic NOT EXISTS on the PATCH write itself, not a
  // schema-level UNIQUE index — see that write's own comment for why a real
  // index would collide with ring-generated landlets' auto-assigned names.
  describe('land name uniqueness (#1150)', () => {
    it('rejects a rename that collides with another landlet\'s name, case-insensitively', async () => {
      await createGreenbeltLandlet('name-unique-taken-landlet');
      await api('/landlets/name-unique-taken-landlet', {
        method: 'PATCH', body: JSON.stringify({ name: 'Sunny Acres' }),
      });
      await createGreenbeltLandlet('name-unique-renaming-landlet');
      const owner = await signupBuilder('name-unique-renaming-claimer');
      await api('/landlets/name-unique-renaming-landlet/claim', owner.session({ method: 'POST' }));

      const collided = await api('/landlets/name-unique-renaming-landlet', owner.session({
        method: 'PATCH', body: JSON.stringify({ name: 'sunny acres' }),
      }));
      expect(collided.response.status).toBe(409);
      expect(collided.body.error).toMatch(/already taken/i);

      // Rejected, not silently renamed — the landlet keeps its prior name.
      const stored = await env.DB.prepare('SELECT name FROM landlets WHERE landlet_id = ?')
        .bind('name-unique-renaming-landlet').first();
      expect(stored.name).toBe(`Test name-unique-renaming-landlet`);
    });

    it('allows a rename to a genuinely available name', async () => {
      await createGreenbeltLandlet('name-unique-available-landlet');
      const owner = await signupBuilder('name-unique-available-claimer');
      await api('/landlets/name-unique-available-landlet/claim', owner.session({ method: 'POST' }));

      const renamed = await api('/landlets/name-unique-available-landlet', owner.session({
        method: 'PATCH', body: JSON.stringify({ name: 'Maple Hollow' }),
      }));
      expect(renamed.response.status).toBe(200);
      expect(renamed.body.landlet.name).toBe('Maple Hollow');
    });

    // #1150: PATCH /api/landlets/:id's owned branch had no rate limit at
    // all before this issue gave it a real, repeatable, owner-facing write
    // affordance (rename) -- same shape as the sign-post delete rate-limit
    // test above (seeds the limit directly via repeated calls, not a
    // separate create step).
    it('rate-limits repeated PATCHes from the same owning builder', async () => {
      await createGreenbeltLandlet('owned-patch-rate-limit-landlet');
      const owner = await signupBuilder('owned-patch-rate-limit-claimer');
      await api('/landlets/owned-patch-rate-limit-landlet/claim', owner.session({ method: 'POST' }));

      let lastStatus;
      for (let i = 0; i < 21; i++) {
        const result = await api('/landlets/owned-patch-rate-limit-landlet', owner.session({
          method: 'PATCH', body: JSON.stringify({ name: `Rate Limit Attempt ${i}` }),
        }));
        lastStatus = result.response.status;
      }
      expect(lastStatus).toBe(429);
    });
  });

  // #1476: the owned branch above got its own rate limit via #1150, but
  // that issue's comment explicitly scoped itself to "the owned branch
  // only" -- this fully-unauthenticated unowned/world-gen branch had no
  // throttle at all, letting anyone flood real D1 writes to any unclaimed
  // landlet. Synthetic cf-connecting-ip per the unauthenticated-create
  // rate-limit test's own approach above.
  it('rate-limits repeated unauthenticated PATCHes to the same unowned landlet', async () => {
    await createGreenbeltLandlet('unowned-patch-rate-limit-landlet');
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };

    let lastStatus;
    for (let i = 0; i < 21; i++) {
      const result = await api('/landlets/unowned-patch-rate-limit-landlet', {
        method: 'PATCH', headers, body: JSON.stringify({ name: `Unowned Rate Limit Attempt ${i}` }),
      });
      lastStatus = result.response.status;
    }
    expect(lastStatus).toBe(429);
  });

  // Same "claimed implies non-null owner" invariant as the PUT/PATCH test
  // above (#224), but on the create path instead — an anonymous POST that
  // sets status:'claimed' while simply omitting ownerBuilderId used to sail
  // straight through the ownerBuilderId-spoofing check (#65/#69) as if it
  // were ordinary unowned world-generation housekeeping, leaving a landlet
  // permanently stuck: un-claimable via POST .../claim (no longer
  // greenbelt) and not eligible for DELETE's owned-land protection either.
  it('rejects creating a claimed landlet with no owner via POST', async () => {
    const rejected = await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'unowned-claimed-create-landlet',
        name: 'Should never exist',
        areaM2: 1000,
        status: 'claimed',
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toEqual({ error: 'A claimed landlet must have an ownerBuilderId' });

    const stored = await env.DB.prepare(
      'SELECT 1 AS found FROM landlets WHERE landlet_id = ?',
    ).bind('unowned-claimed-create-landlet').first();
    expect(stored).toBeNull();
  });

  it('still allows unauthenticated creation of unowned greenbelt/generating landlets via POST', async () => {
    const greenbelt = await createGreenbeltLandlet('unowned-create-greenbelt-landlet');
    expect(greenbelt.response.status).toBe(201);
    expect(greenbelt.body.landlet).toMatchObject({ status: 'greenbelt', ownerBuilderId: null });

    const generating = await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'unowned-create-generating-landlet', name: 'Still generating', areaM2: 4, status: 'generating',
      }),
    });
    expect(generating.response.status).toBe(201);
    expect(generating.body.landlet).toMatchObject({ status: 'generating', ownerBuilderId: null });
  });

  // #964: unlike every other free-text field in this file (see #337), the
  // unowned-creation branch's `name` used plain stringValue with no length
  // cap -- reachable by a fully unauthenticated caller.
  it('rejects an over-length name on unauthenticated landlet creation', async () => {
    const rejected = await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'unowned-overlong-name-landlet', name: 'x'.repeat(101), areaM2: 4, status: 'greenbelt',
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/name must be 100 characters or fewer/);

    const stored = await env.DB.prepare(
      'SELECT 1 AS found FROM landlets WHERE landlet_id = ?',
    ).bind('unowned-overlong-name-landlet').first();
    expect(stored).toBeNull();
  });

  // #964: unlike every other array-shaped input in this file (e.g.
  // candidates.length > 100), validatePolygon capped nothing -- an
  // unauthenticated caller could POST an unboundedly large polygon into a
  // row that's echoed back verbatim on every subsequent GET.
  it('rejects an over-length polygon on unauthenticated landlet creation', async () => {
    const rejected = await api('/landlets', {
      method: 'POST',
      body: JSON.stringify({
        landletId: 'unowned-overlong-polygon-landlet', name: 'Too many points', areaM2: 4, status: 'greenbelt',
        polygon: Array.from({ length: 101 }, (_, i) => ({ x: i, y: 0 })),
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/polygon must contain at most 100 points/);

    const stored = await env.DB.prepare(
      'SELECT 1 AS found FROM landlets WHERE landlet_id = ?',
    ).bind('unowned-overlong-polygon-landlet').first();
    expect(stored).toBeNull();
  });

  // #964: unlike the self-claim branch just below (already rate-limited),
  // this fully-unauthenticated unowned/greenbelt creation path had no
  // throttle at all -- an unbounded, anonymous way to flood the landlets
  // table. Synthetic cf-connecting-ip per the sign-post/purchase rate-limit
  // tests' own approach.
  it('rate-limits repeated unauthenticated unowned landlet creations from the same client', async () => {
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/landlets', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          landletId: `unowned-create-rate-limit-${i}`, name: `Attempt ${i}`, areaM2: 4, status: 'greenbelt',
        }),
      });
      expect(attempt.response.status).toBe(201);
    }
    const limited = await api('/landlets', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        landletId: 'unowned-create-rate-limit-final', name: 'One too many', areaM2: 4, status: 'greenbelt',
      }),
    });
    expect(limited.response.status).toBe(429);
  });

  // #1794: the DELETE branch below is the third anonymous, unowned-only
  // landlet mutation in this handler (alongside the create/#964 and
  // unowned-patch/#1476 branches just above) and never got the same guard.
  // Each DELETE actually consumes its target row, so this seeds 21 distinct
  // unowned landlets up front (via the admin session, which doesn't count
  // against this bucket) rather than reusing a single one the way the
  // unowned-patch test above does.
  it('rate-limits repeated unauthenticated DELETEs of distinct unowned landlets from the same client', async () => {
    for (let i = 0; i < 21; i++) {
      await createGreenbeltLandlet(`unowned-delete-rate-limit-${i}`);
    }
    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };

    let lastStatus;
    for (let i = 0; i < 21; i++) {
      const attempt = await api(`/landlets/unowned-delete-rate-limit-${i}`, { method: 'DELETE', headers });
      lastStatus = attempt.response.status;
    }
    expect(lastStatus).toBe(429);
  });

  // #799: the self-owned branch of POST /api/landlets grants the exact same
  // fully-buildable outcome as POST .../claim (requireOwnedLandlet only
  // ever checks owner_builder_id, never status) — but until this fix it
  // enforced none of that endpoint's invariants. This is the "owner implies
  // claimed" half: an owner set together with any other status would dodge
  // recomputeLandCap's own `status = 'claimed'` filter while still passing
  // every downstream ownership check, i.e. free, permanently uncounted land.
  it('rejects creating an owned landlet with a non-claimed status via POST', async () => {
    const builder = await signupBuilder('self-claim-status-mismatch-builder');
    const rejected = await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'self-claim-status-mismatch-landlet', name: 'Should never exist', areaM2: 1000,
        status: 'greenbelt', ownerBuilderId: builder.builderId,
      }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body).toEqual({ error: 'An owned landlet must have status "claimed"' });

    const stored = await env.DB.prepare(
      'SELECT 1 AS found FROM landlets WHERE landlet_id = ?',
    ).bind('self-claim-status-mismatch-landlet').first();
    expect(stored).toBeNull();
  });

  // #799: the "at most one claimed landlet per builder" half of the same
  // invariant — mirrors POST .../claim's own NOT EXISTS guard a few dozen
  // lines up, which this creation path granted the same outcome as but
  // never actually enforced.
  it('rejects a second self-claimed landlet via POST from a builder who already owns one', async () => {
    const builder = await signupBuilder('self-claim-double-builder');
    const first = await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'self-claim-double-first', name: 'First', areaM2: 1000,
        status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9000, y: 0 },
      }),
    }));
    expect(first.response.status).toBe(201);

    const second = await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'self-claim-double-second', name: 'Second', areaM2: 1000,
        status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9100, y: 0 },
      }),
    }));
    expect(second.response.status).toBe(409);
    expect(second.body).toEqual({ error: 'You already own a claimed landlet' });

    const stored = await env.DB.prepare(
      'SELECT 1 AS found FROM landlets WHERE landlet_id = ?',
    ).bind('self-claim-double-second').first();
    expect(stored).toBeNull();
  });

  // #825: the self-claim branch used to trust the client's areaM2 outright.
  // Since the real buildable footprint always comes from the fixed
  // LANDLET_AREA_M2 constant (assertInstanceXYWithinLandlet), not this row's
  // own area_m2, a tiny attacker-chosen areaM2 got the same real footprint
  // while contributing ~0 to ownedAreaM2 and making every subsequent level
  // add (levelCapConsumedM2 multiplies against area_m2) functionally free —
  // unlimited vertical construction for near-zero land-cap cost.
  it('ignores a self-claimed landlet\'s client-supplied areaM2, forcing the real fixed footprint area', async () => {
    const builder = await signupBuilder('self-claim-area-spoof-builder');
    const created = await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'self-claim-area-spoof-landlet', name: 'Tiny on paper', areaM2: 0.0001,
        status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9400, y: 0 },
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.landlet.areaM2).toBe(1000);

    const stored = await env.DB.prepare(
      'SELECT area_m2 FROM landlets WHERE landlet_id = ?',
    ).bind('self-claim-area-spoof-landlet').first();
    expect(stored.area_m2).toBe(1000);

    // ownedAreaM2 reflects the real footprint, not the spoofed value.
    const me = await api('/builders/me', builder.session());
    expect(me.body.builder.ownedAreaM2).toBe(1000);
  });

  // #1766: same free-Class-2+ gap #1703 fixed on the sibling
  // POST .../claim endpoint -- areaM2 is already forced to the fixed
  // free-starter constant (test just above), but nothing stopped a caller
  // from setting landClass itself to claim a "larger" landlet class for
  // free, with no auction at all.
  it('rejects a self-claimed landlet with a non-Class-1 landClass via POST', async () => {
    const builder = await signupBuilder('self-claim-class-spoof-builder');
    const rejected = await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'self-claim-class-spoof-landlet', name: 'Should never exist', areaM2: 1000,
        status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9500, y: 0 }, landClass: 5,
      }),
    }));
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/larger than the free starter size/);

    const stored = await env.DB.prepare(
      'SELECT 1 AS found FROM landlets WHERE landlet_id = ?',
    ).bind('self-claim-class-spoof-landlet').first();
    expect(stored).toBeNull();
  });

  // #799: unlike every other repeatable write in this file, this path
  // (fully caller-controlled, no real greenbelt/world-generation backing it)
  // had no rate limit at all — a builder could flood the table even though
  // each individual claimed row is itself rejected past their first, since
  // that rejection is a normal 409, not a hard stop.
  it('rate-limits repeated self-claim creations from the same builder', async () => {
    const builder = await signupBuilder('self-claim-rate-limit-builder');
    for (let i = 0; i < 20; i++) {
      // Each attempt is deliberately a fresh landlet id for a builder that
      // already owns a claimed landlet, so every one *would* 409 on the
      // ownership invariant — the rate limit must still trigger before that
      // check ever gets returned as this specific error, i.e. must be
      // checked first, or this loop would never actually reach 429.
      if (i === 0) {
        const seed = await api('/landlets', builder.session({
          method: 'POST',
          body: JSON.stringify({
            landletId: 'self-claim-rate-limit-seed', name: 'Seed', areaM2: 1000,
            status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9200, y: 0 },
          }),
        }));
        expect(seed.response.status).toBe(201);
        continue;
      }
      const attempt = await api('/landlets', builder.session({
        method: 'POST',
        body: JSON.stringify({
          landletId: `self-claim-rate-limit-${i}`, name: `Attempt ${i}`, areaM2: 1000,
          status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9200 + i, y: 0 },
        }),
      }));
      expect(attempt.response.status).toBe(409);
    }
    const limited = await api('/landlets', builder.session({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'self-claim-rate-limit-final', name: 'One too many', areaM2: 1000,
        status: 'claimed', ownerBuilderId: builder.builderId, center: { x: 9300, y: 0 },
      }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #952: the real POST .../claim endpoint just above was cited (by #799's
  // own title and the LANDLET_SELF_CLAIM_CREATE_RATE_LIMIT_MAX comment
  // above) as already having a rate limit -- it never actually did. Same
  // "already owns a claimed landlet is a normal 409, not a hard stop" shape
  // as the self-claim-creation test above, just against real greenbelt
  // landlets instead of caller-fabricated ones.
  it('rate-limits repeated claim attempts from the same builder', async () => {
    const builder = await signupBuilder('claim-rate-limit-builder');
    for (let i = 0; i < 20; i++) {
      await createGreenbeltLandlet(`claim-rate-limit-landlet-${i}`);
      const attempt = await api(`/landlets/claim-rate-limit-landlet-${i}/claim`, builder.session({ method: 'POST' }));
      expect(attempt.response.status).toBe(i === 0 ? 200 : 409);
    }
    await createGreenbeltLandlet('claim-rate-limit-landlet-final');
    const limited = await api('/landlets/claim-rate-limit-landlet-final/claim', builder.session({ method: 'POST' }));
    expect(limited.response.status).toBe(429);
  });

  // #1703: the free self-claim path never checked landlet_class against
  // anything -- docs/SPEC.md's own "one free 1,000 m² lándlet, Class 2+
  // only via auction" rule means a Class 2+ greenbelt landlet (reachable
  // via an admin generate-ring call using distribution: 'power-law') must
  // never be grantable for free, regardless of the claiming builder's own
  // land cap.
  it('rejects claiming a Class 2+ greenbelt landlet for free', async () => {
    const builder = await signupBuilder('class-2-claim-builder');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'class-2-claim-landlet', name: 'Test Class 2 Landlet',
        areaM2: 5000, landClass: 2, status: 'greenbelt',
      }),
    }));

    const attempt = await api('/landlets/class-2-claim-landlet/claim', builder.session({ method: 'POST' }));
    expect(attempt.response.status).toBe(409);
    expect(attempt.body.error).toMatch(/larger than the free starter size/);

    const landlet = await env.DB.prepare('SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?')
      .bind('class-2-claim-landlet').first();
    expect(landlet.status).toBe('greenbelt');
    expect(landlet.owner_builder_id).toBeNull();
  });
});

// #1177: owner-requested admin tool for reassigning an already-claimed
// landlet's owner by hand -- the only other paths that ever change
// owner_builder_id are self-claim, an auction win, or a builder-deletion
// release, and the generic PUT/PATCH above deliberately can never touch it.
describe('Admin landlet ownership reassignment (#1177)', () => {
  it('reassigns an already-claimed landlet to a different builder, logging the action', async () => {
    const original = await signupBuilder('reassign-original-owner');
    const target = await signupBuilder('reassign-target-owner');
    await createGreenbeltLandlet('reassign-happy-path-landlet');
    await api('/landlets/reassign-happy-path-landlet/claim', original.session({ method: 'POST' }));

    const reassigned = await api('/landlets/reassign-happy-path-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(reassigned.response.status).toBe(200);
    expect(reassigned.body.landlet).toMatchObject({
      landletId: 'reassign-happy-path-landlet', status: 'claimed', ownerBuilderId: target.builderId,
    });

    const log = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('reassign_landlet_owner', 'reassign-happy-path-landlet').first();
    expect(JSON.parse(log.detail_json)).toEqual({
      fromBuilderId: original.builderId, toBuilderId: target.builderId,
    });

    // The original owner can no longer self-claim another landlet using
    // this one's now-vacated slot's worth of "already owns a claimed
    // landlet" state -- i.e. they're genuinely divested, not still counted.
    await createGreenbeltLandlet('reassign-original-can-claim-again-landlet');
    const reclaim = await api('/landlets/reassign-original-can-claim-again-landlet/claim', original.session({ method: 'POST' }));
    expect(reclaim.response.status).toBe(200);
  });

  // #1494: reassign-owner is the only ownership-change path in the codebase
  // that didn't notify either affected builder, unlike resolveAuction's
  // auctionWinnerNotifications/notifyOfNewBid.
  it('notifies both the previous and new owner of the reassignment', async () => {
    const original = await signupBuilder('reassign-notify-original-owner');
    const target = await signupBuilder('reassign-notify-target-owner');
    await createGreenbeltLandlet('reassign-notify-landlet');
    await api('/landlets/reassign-notify-landlet/claim', original.session({ method: 'POST' }));

    const reassigned = await api('/landlets/reassign-notify-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(reassigned.response.status).toBe(200);

    const { results: originalNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(original.builderId).all();
    expect(originalNotifications.some((n) => /reassigned to another builder/.test(n.message))).toBe(true);

    const { results: targetNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(target.builderId).all();
    expect(targetNotifications.some((n) => /reassigned to you/.test(n.message))).toBe(true);
  });

  it('requires a real admin session', async () => {
    const owner = await signupBuilder('reassign-auth-owner');
    const target = await signupBuilder('reassign-auth-target');
    await createGreenbeltLandlet('reassign-auth-landlet');
    await api('/landlets/reassign-auth-landlet/claim', owner.session({ method: 'POST' }));

    const asOwner = await api('/landlets/reassign-auth-landlet/reassign-owner', owner.session({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(asOwner.response.status).toBe(403);
  });

  it('rejects a landlet that is not currently claimed', async () => {
    const target = await signupBuilder('reassign-unclaimed-target');
    await createGreenbeltLandlet('reassign-unclaimed-landlet');

    const result = await api('/landlets/reassign-unclaimed-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(result.response.status).toBe(409);
  });

  it('404s on a landlet that does not exist', async () => {
    const target = await signupBuilder('reassign-missing-target');
    const result = await api('/landlets/does-not-exist/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(result.response.status).toBe(404);
  });

  it('404s on a target builder that does not exist', async () => {
    const owner = await signupBuilder('reassign-missing-builder-owner');
    await createGreenbeltLandlet('reassign-missing-builder-landlet');
    await api('/landlets/reassign-missing-builder-landlet/claim', owner.session({ method: 'POST' }));

    const result = await api('/landlets/reassign-missing-builder-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: 'does-not-exist' }),
    }));
    expect(result.response.status).toBe(404);
  });

  it('rejects reassigning to the current owner', async () => {
    const owner = await signupBuilder('reassign-same-owner');
    await createGreenbeltLandlet('reassign-same-owner-landlet');
    await api('/landlets/reassign-same-owner-landlet/claim', owner.session({ method: 'POST' }));

    const result = await api('/landlets/reassign-same-owner-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: owner.builderId }),
    }));
    expect(result.response.status).toBe(409);
  });

  // Same one-claimed-landlet-per-builder invariant POST .../claim enforces
  // -- an admin can move ownership around, but not past this, since
  // nothing else in this file is built to handle a builder legitimately
  // owning two claimed landlets at once (see this endpoint's own comment).
  it('rejects reassigning to a builder who already owns a claimed landlet', async () => {
    const owner = await signupBuilder('reassign-invariant-owner');
    const alreadyOwning = await signupBuilder('reassign-invariant-already-owning');
    await createGreenbeltLandlet('reassign-invariant-source-landlet');
    await api('/landlets/reassign-invariant-source-landlet/claim', owner.session({ method: 'POST' }));
    await createGreenbeltLandlet('reassign-invariant-other-landlet');
    await api('/landlets/reassign-invariant-other-landlet/claim', alreadyOwning.session({ method: 'POST' }));

    const result = await api('/landlets/reassign-invariant-source-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: alreadyOwning.builderId }),
    }));
    expect(result.response.status).toBe(409);

    // Nothing actually changed on a rejected attempt.
    const stillOwner = await api('/landlets/reassign-invariant-source-landlet');
    expect(stillOwner.body.landlet.ownerBuilderId).toBe(owner.builderId);
  });

  // #1281 (owner decision, 2026-10-13): "land cap is a hard rule, full
  // stop -- no admin override, ever, including via manual reassignment."
  // A fresh builder's default land_cap_m2 is 1000 (migrations/0050) -- a
  // landlet bigger than that, with the target otherwise owning nothing,
  // is the simplest way to exceed cap without also tripping the
  // one-claimed-landlet invariant tested just above.
  it('rejects reassigning a landlet that would put the target over their own land cap', async () => {
    const owner = await signupBuilder('reassign-land-cap-owner');
    const target = await signupBuilder('reassign-land-cap-target');
    await api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({
        landletId: 'reassign-land-cap-source-landlet', name: 'Test reassign-land-cap-source-landlet',
        areaM2: 2000, status: 'greenbelt',
      }),
    }));
    await api('/landlets/reassign-land-cap-source-landlet/claim', owner.session({ method: 'POST' }));

    const result = await api('/landlets/reassign-land-cap-source-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(result.response.status).toBe(409);
    expect(result.body.error).toMatch(/land cap/i);

    // Nothing actually changed on a rejected attempt.
    const stillOwner = await api('/landlets/reassign-land-cap-source-landlet');
    expect(stillOwner.body.landlet.ownerBuilderId).toBe(owner.builderId);
    const log = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('reassign_landlet_owner', 'reassign-land-cap-source-landlet').first();
    expect(log).toBeNull();
  });

  // The reassigned landlet's own cap_consumed_m2 (from vertical construction
  // under the *previous* owner) must never count against the new owner's
  // cap check -- the cleanup batch always deletes landlet_levels for this
  // landlet as part of the same write (see the cleanup tests below), so by
  // the time anyone could be charged for those levels, they're already gone.
  it('does not count the previous owner\'s levels on the transferred landlet against the new owner\'s cap', async () => {
    const owner = await signupBuilder('reassign-land-cap-levels-owner');
    const target = await signupBuilder('reassign-land-cap-levels-target');
    await createGreenbeltLandlet('reassign-land-cap-levels-landlet');
    await api('/landlets/reassign-land-cap-levels-landlet/claim', owner.session({ method: 'POST' }));
    // Seeded directly rather than via POST .../levels, same reasoning the
    // cleanup tests above give -- this isn't exercising the level-add gate.
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('reassign-land-cap-levels-level', 'reassign-land-cap-levels-landlet', 1, 5000).run();

    const result = await api('/landlets/reassign-land-cap-levels-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(result.response.status).toBe(200);
    expect(result.body.landlet.ownerBuilderId).toBe(target.builderId);
  });

  // #1711 (owner decision, 2026-10-13): "surface the conflict to the admin
  // at reassignment time instead of letting it resolve silently later."
  // Without this, resolveAuction would later transfer the landlet again
  // (or release it to greenbelt) out from under whoever the admin just
  // handed it to, while still crediting the stale previous owner.
  async function fundHiggles(builder, amountCents = 100_000_000) {
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(amountCents, builder.builderId).run();
  }

  it('blocks reassignment with a structured 409 when the landlet has an active auction with no bids', async () => {
    const owner = await signupBuilder('reassign-auction-conflict-no-bids-owner');
    const target = await signupBuilder('reassign-auction-conflict-no-bids-target');
    await createGreenbeltLandlet('reassign-auction-conflict-no-bids-landlet');
    await api('/landlets/reassign-auction-conflict-no-bids-landlet/claim', owner.session({ method: 'POST' }));
    const started = await api('/landlets/reassign-auction-conflict-no-bids-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 500 }),
    }));
    expect(started.response.status).toBe(201);

    const result = await api('/landlets/reassign-auction-conflict-no-bids-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(result.response.status).toBe(409);
    expect(result.body.error).toMatch(/active auction/i);
    expect(result.body.activeAuction).toMatchObject({
      auctionId: started.body.auction.auctionId, startingBidCents: 500, highBidCents: null, bidderCount: 0,
    });

    // Nothing actually changed on a blocked attempt.
    const stillOwner = await api('/landlets/reassign-auction-conflict-no-bids-landlet');
    expect(stillOwner.body.landlet.ownerBuilderId).toBe(owner.builderId);
    const auction = await env.DB.prepare('SELECT status FROM auctions WHERE auction_id = ?')
      .bind(started.body.auction.auctionId).first();
    expect(auction.status).toBe('active');
  });

  it('reports the current high bid and bidder count in the conflict when the auction has real bids', async () => {
    const owner = await signupBuilder('reassign-auction-conflict-bids-owner');
    const target = await signupBuilder('reassign-auction-conflict-bids-target');
    const bidder = await signupBuilder('reassign-auction-conflict-bids-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('reassign-auction-conflict-bids-landlet');
    await api('/landlets/reassign-auction-conflict-bids-landlet/claim', owner.session({ method: 'POST' }));
    const started = await api('/landlets/reassign-auction-conflict-bids-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 700 }),
    }));

    const result = await api('/landlets/reassign-auction-conflict-bids-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(result.response.status).toBe(409);
    expect(result.body.activeAuction).toMatchObject({ highBidCents: 700, bidderCount: 1 });
  });

  it('cancels the active auction and reassigns in one step when cancelActiveAuction is true', async () => {
    const owner = await signupBuilder('reassign-auction-cancel-owner');
    const target = await signupBuilder('reassign-auction-cancel-target');
    const bidder = await signupBuilder('reassign-auction-cancel-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandlet('reassign-auction-cancel-landlet');
    await api('/landlets/reassign-auction-cancel-landlet/claim', owner.session({ method: 'POST' }));
    const started = await api('/landlets/reassign-auction-cancel-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 700 }),
    }));

    const result = await api('/landlets/reassign-auction-cancel-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId, cancelActiveAuction: true }),
    }));
    expect(result.response.status).toBe(200);
    expect(result.body.landlet.ownerBuilderId).toBe(target.builderId);

    const auction = await env.DB.prepare('SELECT status, winning_bid_id FROM auctions WHERE auction_id = ?')
      .bind(auctionId).first();
    expect(auction.status).toBe('ended');
    expect(auction.winning_bid_id).toBeNull();

    // No currency was ever actually debited at bid-placement time
    // (handleAuctionBids only holds a live-computed amount, debited for
    // real only at resolution), so cancelling has nothing to refund --
    // just the courtesy notification below that the bid no longer stands.
    const { results: bidderNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(bidder.builderId).all();
    expect(bidderNotifications.some((n) => /bid.*cancelled/i.test(n.message))).toBe(true);

    const { results: ownerNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(owner.builderId).all();
    expect(ownerNotifications.some((n) => /auction.*cancelled/i.test(n.message))).toBe(true);

    const log = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('reassign_landlet_owner', 'reassign-auction-cancel-landlet').first();
    expect(JSON.parse(log.detail_json)).toMatchObject({ cancelledAuctionId: auctionId });
  });

  // #1955: the new owner may have placed a losing-so-far bid on the exact
  // auction being cancelled before the admin handed them the land outright
  // -- without excluding them from cancelledAuctionBidderIds, they'd get a
  // "your bid was cancelled, no winner" notification directly contradicting
  // the "it's yours now" one, about the same landlet.
  it('does not send the new owner a "bid cancelled" notification when they bid on the auction they are being handed', async () => {
    const owner = await signupBuilder('reassign-auction-cancel-self-bid-owner');
    const target = await signupBuilder('reassign-auction-cancel-self-bid-target');
    await fundHiggles(target);
    await createGreenbeltLandlet('reassign-auction-cancel-self-bid-landlet');
    await api('/landlets/reassign-auction-cancel-self-bid-landlet/claim', owner.session({ method: 'POST' }));
    const started = await api('/landlets/reassign-auction-cancel-self-bid-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({}),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, target.session({
      method: 'POST', body: JSON.stringify({ amountCents: 700 }),
    }));

    const result = await api('/landlets/reassign-auction-cancel-self-bid-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId, cancelActiveAuction: true }),
    }));
    expect(result.response.status).toBe(200);
    expect(result.body.landlet.ownerBuilderId).toBe(target.builderId);

    const { results: targetNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(target.builderId).all();
    expect(targetNotifications.some((n) => /reassigned to you by an admin/i.test(n.message))).toBe(true);
    expect(targetNotifications.some((n) => /bid.*cancelled/i.test(n.message))).toBe(false);
  });

  it('cancelActiveAuction is a harmless no-op when there is no active auction to cancel', async () => {
    const owner = await signupBuilder('reassign-auction-cancel-noop-owner');
    const target = await signupBuilder('reassign-auction-cancel-noop-target');
    await createGreenbeltLandlet('reassign-auction-cancel-noop-landlet');
    await api('/landlets/reassign-auction-cancel-noop-landlet/claim', owner.session({ method: 'POST' }));

    const result = await api('/landlets/reassign-auction-cancel-noop-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId, cancelActiveAuction: true }),
    }));
    expect(result.response.status).toBe(200);
    expect(result.body.landlet.ownerBuilderId).toBe(target.builderId);

    const { results: ownerNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(owner.builderId).all();
    // The plain "reassigned" message, not the auction-cancellation variant.
    expect(ownerNotifications.some((n) => /reassigned to another builder by an admin\.$/.test(n.message))).toBe(true);
  });

  // #1705: the guarded ownership-transfer UPDATE and the build-content
  // cleanup deletes used to be batched together in one db.batch() call --
  // D1 runs every statement in a batch regardless of an earlier one's row
  // count, so a rejected reassignment (the invariant guard above failing to
  // match) still permanently wiped the existing owner's build content, even
  // though the response correctly reported the transfer itself as rejected.
  it('does not delete the existing owner\'s build content when the reassignment itself is rejected', async () => {
    const owner = await signupBuilder('reassign-rejected-cleanup-owner');
    const alreadyOwning = await signupBuilder('reassign-rejected-cleanup-already-owning');
    await createGreenbeltLandlet('reassign-rejected-cleanup-source-landlet');
    await api('/landlets/reassign-rejected-cleanup-source-landlet/claim', owner.session({ method: 'POST' }));
    await createGreenbeltLandlet('reassign-rejected-cleanup-other-landlet');
    await api('/landlets/reassign-rejected-cleanup-other-landlet/claim', alreadyOwning.session({ method: 'POST' }));

    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'reassign-rejected-cleanup-instance', landletId: 'reassign-rejected-cleanup-source-landlet', templateId: 'placeholder-tree', x: 1, y: 1,
      }),
    }));
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('reassign-rejected-cleanup-level', 'reassign-rejected-cleanup-source-landlet', 1, 1000).run();
    await env.DB.prepare(`
      INSERT INTO landlet_versions (version_id, landlet_id, version_number, name) VALUES (?, ?, ?, ?)
    `).bind('reassign-rejected-cleanup-version', 'reassign-rejected-cleanup-source-landlet', 1, 'Version 1').run();

    const result = await api('/landlets/reassign-rejected-cleanup-source-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: alreadyOwning.builderId }),
    }));
    expect(result.response.status).toBe(409);

    const instances = await env.DB.prepare('SELECT * FROM placed_instances WHERE landlet_id = ?')
      .bind('reassign-rejected-cleanup-source-landlet').all();
    const levels = await env.DB.prepare('SELECT * FROM landlet_levels WHERE landlet_id = ?')
      .bind('reassign-rejected-cleanup-source-landlet').all();
    const versions = await env.DB.prepare('SELECT * FROM landlet_versions WHERE landlet_id = ?')
      .bind('reassign-rejected-cleanup-source-landlet').all();
    expect(instances.results).toHaveLength(1);
    expect(levels.results).toHaveLength(1);
    expect(versions.results).toHaveLength(1);

    const log = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('reassign_landlet_owner', 'reassign-rejected-cleanup-source-landlet').first();
    expect(log).toBeNull();
  });

  // #1280: every other ownership-change path (builder deletion,
  // resolveAuction's winner-transfer and $0/no-bid-release branches) clears
  // placed_instances/landlet_versions/landlet_levels so a new owner never
  // inherits the previous owner's build content -- reassign-owner never did.
  it('clears placed instances, version history, and levels when reassigning a built-on landlet', async () => {
    const original = await signupBuilder('reassign-cleanup-original-owner');
    const target = await signupBuilder('reassign-cleanup-target-owner');
    await createGreenbeltLandlet('reassign-cleanup-landlet');
    await api('/landlets/reassign-cleanup-landlet/claim', original.session({ method: 'POST' }));

    await api('/instances', original.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'reassign-cleanup-instance', landletId: 'reassign-cleanup-landlet', templateId: 'placeholder-tree', x: 1, y: 1,
      }),
    }));
    // Seeded directly rather than via POST .../levels -- this test isn't
    // exercising the land-cap gate, same reasoning the "Landlet levels"
    // describe block's own seedLevelDirectly helper gives.
    await env.DB.prepare(`
      INSERT INTO landlet_levels (level_id, landlet_id, level_index, cap_consumed_m2) VALUES (?, ?, ?, ?)
    `).bind('reassign-cleanup-level', 'reassign-cleanup-landlet', 1, 1000).run();
    await env.DB.prepare(`
      INSERT INTO landlet_versions (version_id, landlet_id, version_number, name) VALUES (?, ?, ?, ?)
    `).bind('reassign-cleanup-version', 'reassign-cleanup-landlet', 1, 'Version 1').run();
    // #2508: sold_out_markers never got added to this reassign-owner cleanup
    // when #2068 introduced the table -- seeded directly here the same way
    // landlet_levels/landlet_versions are above, since no API path produces
    // a marker without a real stock-sellout sweep.
    await env.DB.prepare(`
      INSERT INTO sold_out_markers (marker_id, landlet_id, x_m, y_m, z_m, template_id, template_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind('reassign-cleanup-marker', 'reassign-cleanup-landlet', 1, 1, 0, 'placeholder-tree', 'Placeholder Tree').run();

    const reassigned = await api('/landlets/reassign-cleanup-landlet/reassign-owner', adminSession({
      method: 'POST', body: JSON.stringify({ ownerBuilderId: target.builderId }),
    }));
    expect(reassigned.response.status).toBe(200);
    expect(reassigned.body.landlet.ownerBuilderId).toBe(target.builderId);

    const instances = await env.DB.prepare('SELECT * FROM placed_instances WHERE landlet_id = ?')
      .bind('reassign-cleanup-landlet').all();
    const levels = await env.DB.prepare('SELECT * FROM landlet_levels WHERE landlet_id = ?')
      .bind('reassign-cleanup-landlet').all();
    const versions = await env.DB.prepare('SELECT * FROM landlet_versions WHERE landlet_id = ?')
      .bind('reassign-cleanup-landlet').all();
    const markers = await env.DB.prepare('SELECT * FROM sold_out_markers WHERE landlet_id = ?')
      .bind('reassign-cleanup-landlet').all();
    expect(instances.results).toEqual([]);
    expect(levels.results).toEqual([]);
    expect(versions.results).toEqual([]);
    expect(markers.results).toEqual([]);

    // The level's cap_consumed_m2 no longer counts toward the new owner's
    // land cap, now that it's been cleared as part of the same reassignment
    // -- recomputeLandCap(db, newOwnerBuilderId) ran as part of handling
    // the reassignment itself, not just lazily on this later read.
    const newOwner = await api(`/builders?ids=${target.builderId}`);
    expect(newOwner.body.builders[0].ownedAreaM2).toBe(1000);
  });
});
