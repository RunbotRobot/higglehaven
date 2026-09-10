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
});

describe('Community signs', () => {
  // A single claimed landlet, shared by every test below, to host the
  // instances they place — placing/toggling/deleting an instance now
  // requires session-authenticated ownership of the landlet it sits on
  // (see requireOwnedLandlet's own comment), so every mutation here goes
  // through this landlet's owning builder's session. Posting to (but not
  // moderating) a sign stays unauthenticated by design, so those calls are
  // left as plain, session-less requests.
  let signsLandlet;
  let signsBuilder;

  beforeAll(async () => {
    signsBuilder = await signupBuilder('community-signs-builder');
    await createGreenbeltLandlet('community-signs-landlet');
    const claimed = await api('/landlets/community-signs-landlet/claim', signsBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    signsLandlet = 'community-signs-landlet';
  });

  it('toggles isCommunitySign on a placed instance and round-trips it', async () => {
    const created = await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-toggle-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.instance.isCommunitySign).toBe(false);

    const toggled = await api('/instances/sign-toggle-instance', signsBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: true }),
    }));
    expect(toggled.response.status).toBe(200);
    expect(toggled.body.instance.isCommunitySign).toBe(true);

    const fetched = await api('/instances/sign-toggle-instance');
    expect(fetched.body.instance.isCommunitySign).toBe(true);
  });

  it('rejects a post on an instance not marked as a community sign', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'not-a-sign-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 2,
        y: 2,
      }),
    }));

    const rejected = await api('/instances/not-a-sign-instance/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Hello!' }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community sign/);
  });

  it('creates, lists, and moderates posts on a community sign', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-with-posts',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 3,
        y: 3,
        isCommunitySign: true,
      }),
    }));

    const emptyList = await api('/instances/sign-with-posts/posts');
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.posts).toEqual([]);

    const missingText = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper' }),
    });
    expect(missingText.response.status).toBe(400);

    const tooLong = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'x'.repeat(281) }),
    });
    expect(tooLong.response.status).toBe(400);

    // Found via backlog audit (#337): authorLabel had no length cap at all.
    const authorLabelTooLong = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'x'.repeat(101), text: 'Hello!' }),
    });
    expect(authorLabelTooLong.response.status).toBe(400);

    const posted = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Great little shop!' }),
    });
    expect(posted.response.status).toBe(201);
    expect(posted.body.post).toMatchObject({
      instanceId: 'sign-with-posts',
      authorLabel: 'A Shopper',
      text: 'Great little shop!',
    });
    expect(posted.body.post.postId).toMatch(/^post-/);

    const listed = await api('/instances/sign-with-posts/posts');
    expect(listed.body.posts).toHaveLength(1);
    expect(listed.body.posts[0].postId).toBe(posted.body.post.postId);

    // Moderation (DELETE) is gated to the sign's hosting landlet's owner.
    const unauthenticatedDelete = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, { method: 'DELETE' });
    expect(unauthenticatedDelete.response.status).toBe(401);

    const deleted = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, signsBuilder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api('/instances/sign-with-posts/posts');
    expect(listedAfterDelete.body.posts).toEqual([]);

    const deleteMissing = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, signsBuilder.session({ method: 'DELETE' }));
    expect(deleteMissing.response.status).toBe(404);
  });

  it('cascades post deletion when the sign instance itself is deleted', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-to-delete',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 4,
        y: 4,
        isCommunitySign: true,
      }),
    }));
    await api('/instances/sign-to-delete/posts', {
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'A Shopper', text: 'Nice place' }),
    });
    await api('/instances/sign-to-delete', signsBuilder.session({ method: 'DELETE' }));

    const afterDelete = await api('/instances/sign-to-delete/posts');
    expect(afterDelete.response.status).toBe(404);
  });

  // Found via backlog audit (#337): unlike every other public, repeatable
  // mutation in this file, posting to a community sign requires no
  // session and had no rate limit at all. Synthetic cf-connecting-ip per
  // the purchase rate-limit test's own approach, so this test's bucket
  // doesn't collide with any other sign-post test above.
  it('rate-limits repeated posts from the same client', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-rate-limit-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 5,
        y: 5,
        isCommunitySign: true,
      }),
    }));

    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api('/instances/sign-rate-limit-instance/posts', {
        method: 'POST', headers, body: JSON.stringify({ authorLabel: 'A Shopper', text: `Post ${i}` }),
      });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/instances/sign-rate-limit-instance/posts', {
      method: 'POST', headers, body: JSON.stringify({ authorLabel: 'A Shopper', text: 'One too many' }),
    });
    expect(limited.response.status).toBe(429);
  });

  // Found via backlog audit (#356): the list above was `ORDER BY created_at`
  // with no `DESC` — ascending, so once a sign passed 200 posts, `LIMIT 200`
  // always kept the *oldest* 200, permanently hiding every post made after
  // that point (the newest ones always fell outside the window). Explicit
  // created_at values, rather than relying on insertion order/timing, make
  // "which 200 survive" deterministic to assert on.
  it('reports the true post count and keeps the newest 200 (in ascending order) past the list\'s own cap', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-past-cap-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 6,
        y: 6,
        isCommunitySign: true,
      }),
    }));
    const statements = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare(`
        INSERT INTO sign_posts (post_id, instance_id, author_label, text, created_at) VALUES (?, 'sign-past-cap-instance', 'A Shopper', ?, ?)
      `).bind(`sign-past-cap-${i}`, `Post ${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
    await env.DB.batch(statements);

    const list = await api('/instances/sign-past-cap-instance/posts');
    expect(list.body.posts).toHaveLength(200);
    expect(list.body.totalCount).toBe(205);
    // The surviving window is the newest 200 (post 5 through post 204), not
    // the oldest 200 (post 0 through post 199) the pre-#356 query kept —
    // and still returned oldest-first within that window, since
    // rebuildSignSprites (src/main.js) depends on that ordering to grab the
    // most recent posts via .slice(-SIGN_MAX_VISIBLE_POSTS).
    expect(list.body.posts[0].postId).toBe('sign-past-cap-5');
    expect(list.body.posts[199].postId).toBe('sign-past-cap-204');
  });
});

describe('Community calendar', () => {
  // Same reasoning as the Community signs describe block above: one shared
  // claimed landlet + its owning builder's session for every instance
  // mutation, since placing/toggling/deleting an instance now requires
  // session-authenticated landlet ownership.
  let calendarLandlet;
  let calendarBuilder;

  beforeAll(async () => {
    calendarBuilder = await signupBuilder('community-calendar-builder');
    await createGreenbeltLandlet('community-calendar-landlet');
    const claimed = await api('/landlets/community-calendar-landlet/claim', calendarBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    calendarLandlet = 'community-calendar-landlet';
  });

  it('toggles isCommunityCalendar on a placed instance and round-trips it', async () => {
    const created = await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-toggle-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 5,
        y: 5,
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.instance.isCommunityCalendar).toBe(false);

    const toggled = await api('/instances/calendar-toggle-instance', calendarBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunityCalendar: true }),
    }));
    expect(toggled.response.status).toBe(200);
    expect(toggled.body.instance.isCommunityCalendar).toBe(true);

    const fetched = await api('/instances/calendar-toggle-instance');
    expect(fetched.body.instance.isCommunityCalendar).toBe(true);
  });

  it('is independent of isCommunitySign on the same instance', async () => {
    const created = await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'both-flags-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 6,
        y: 6,
        isCommunitySign: true,
        isCommunityCalendar: true,
      }),
    }));
    expect(created.body.instance.isCommunitySign).toBe(true);
    expect(created.body.instance.isCommunityCalendar).toBe(true);

    const unsetSignOnly = await api('/instances/both-flags-instance', calendarBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: false }),
    }));
    expect(unsetSignOnly.body.instance.isCommunitySign).toBe(false);
    expect(unsetSignOnly.body.instance.isCommunityCalendar).toBe(true);
  });

  it('rejects an event on an instance not marked as a community calendar', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'not-a-calendar-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 7,
        y: 7,
      }),
    }));

    const rejected = await api('/instances/not-a-calendar-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!' }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community calendar/);
  });

  it('creates, lists, and moderates events on a community calendar', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-with-events',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 8,
        y: 8,
        isCommunityCalendar: true,
      }),
    }));

    const emptyList = await api('/instances/calendar-with-events/events');
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.events).toEqual([]);

    // docs/SPEC.md §6: calendar events are builder-authored, unlike sign
    // posts — POST requires a session logged in as the hosting landlet's
    // own owner, unlike GET/the sign-posts POST above.
    const unauthenticated = await api('/instances/calendar-with-events/events', {
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!' }),
    });
    expect(unauthenticated.response.status).toBe(401);

    const otherBuilder = await signupBuilder('community-calendar-other-builder');
    const wrongBuilder = await api('/instances/calendar-with-events/events', otherBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!' }),
    }));
    expect(wrongBuilder.response.status).toBe(403);

    const missingText = await api('/instances/calendar-with-events/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(missingText.response.status).toBe(400);

    const tooLong = await api('/instances/calendar-with-events/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(281) }),
    }));
    expect(tooLong.response.status).toBe(400);

    // authorLabel is not client-supplied — it's derived from the session
    // builder's own label, even if a client tries to send a different one
    // (impersonation is exactly the bug this gate closes).
    const posted = await api('/instances/calendar-with-events/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ authorLabel: 'Someone Else Entirely', text: 'Bonfire night, Friday 8pm!' }),
    }));
    expect(posted.response.status).toBe(201);
    expect(posted.body.event).toMatchObject({
      instanceId: 'calendar-with-events',
      authorLabel: calendarBuilder.builder.label,
      text: 'Bonfire night, Friday 8pm!',
    });
    expect(posted.body.event.eventId).toMatch(/^event-/);

    const listed = await api('/instances/calendar-with-events/events');
    expect(listed.body.events).toHaveLength(1);
    expect(listed.body.events[0].eventId).toBe(posted.body.event.eventId);

    // Moderation (DELETE) is gated to the calendar's hosting landlet's owner.
    const unauthenticatedDelete = await api(`/instances/calendar-with-events/events/${posted.body.event.eventId}`, { method: 'DELETE' });
    expect(unauthenticatedDelete.response.status).toBe(401);

    const deleted = await api(`/instances/calendar-with-events/events/${posted.body.event.eventId}`, calendarBuilder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api('/instances/calendar-with-events/events');
    expect(listedAfterDelete.body.events).toEqual([]);

    const deleteMissing = await api(`/instances/calendar-with-events/events/${posted.body.event.eventId}`, calendarBuilder.session({ method: 'DELETE' }));
    expect(deleteMissing.response.status).toBe(404);
  });

  it('cascades event deletion when the calendar instance itself is deleted', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-to-delete',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 9,
        y: 9,
        isCommunityCalendar: true,
      }),
    }));
    await api('/instances/calendar-to-delete/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Market day' }),
    }));
    await api('/instances/calendar-to-delete', calendarBuilder.session({ method: 'DELETE' }));

    const afterDelete = await api('/instances/calendar-to-delete/events');
    expect(afterDelete.response.status).toBe(404);
  });

  it('accepts an optional scheduledAt and validates it', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-scheduled-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 10,
        y: 10,
        isCommunityCalendar: true,
      }),
    }));

    const plain = await api('/instances/calendar-scheduled-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Just a note' }),
    }));
    expect(plain.body.event.scheduledAt).toBeNull();
    expect(plain.body.event.triggeredAt).toBeNull();

    const invalid = await api('/instances/calendar-scheduled-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bad date', scheduledAt: 'not a date' }),
    }));
    expect(invalid.response.status).toBe(400);

    const scheduled = await api('/instances/calendar-scheduled-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire!', scheduledAt: '2026-08-26T20:00:00.000Z' }),
    }));
    expect(scheduled.response.status).toBe(201);
    expect(scheduled.body.event.scheduledAt).toBe('2026-08-26T20:00:00.000Z');
    expect(scheduled.body.event.triggeredAt).toBeNull();
  });

  // Same ascending-window/no-count gap as sign posts' own "reports the true
  // post count..." test above (#356), fixed the same way.
  it('reports the true event count and keeps the newest 200 (in ascending order) past the list\'s own cap', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-past-cap-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 12,
        y: 12,
        isCommunityCalendar: true,
      }),
    }));
    const statements = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare(`
        INSERT INTO calendar_events (event_id, instance_id, author_label, text, created_at) VALUES (?, 'calendar-past-cap-instance', 'Someone', ?, ?)
      `).bind(`calendar-past-cap-${i}`, `Event ${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
    await env.DB.batch(statements);

    const list = await api('/instances/calendar-past-cap-instance/events');
    expect(list.body.events).toHaveLength(200);
    expect(list.body.totalCount).toBe(205);
    expect(list.body.events[0].eventId).toBe('calendar-past-cap-5');
    expect(list.body.events[199].eventId).toBe('calendar-past-cap-204');
  });

  it('only triggers the creative-tool effect once it is actually due, and only once ever', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-trigger-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 11,
        y: 11,
        isCommunityCalendar: true,
      }),
    }));

    const future = await api('/instances/calendar-trigger-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Future event', scheduledAt: '2099-01-01T00:00:00.000Z' }),
    }));
    const futureEventId = future.body.event.eventId;
    const notDueYet = await api(`/instances/calendar-trigger-instance/events/${futureEventId}/trigger`, { method: 'POST' });
    expect(notDueYet.response.status).toBe(200);
    expect(notDueYet.body.triggered).toBe(false);
    expect(notDueYet.body.event.triggeredAt).toBeNull();

    const noSchedule = await api('/instances/calendar-trigger-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Just a note' }),
    }));
    const noScheduleTrigger = await api(`/instances/calendar-trigger-instance/events/${noSchedule.body.event.eventId}/trigger`, { method: 'POST' });
    expect(noScheduleTrigger.body.triggered).toBe(false);

    // Force it into the past directly via the DB, the same test-only
    // escape hatch used throughout this file (see the Auctions describe
    // block's own comment) rather than waiting a real moment or mocking
    // Date globally.
    await env.DB.prepare(`UPDATE calendar_events SET scheduled_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?`).bind(futureEventId).run();

    const firstTrigger = await api(`/instances/calendar-trigger-instance/events/${futureEventId}/trigger`, { method: 'POST' });
    expect(firstTrigger.response.status).toBe(200);
    expect(firstTrigger.body.triggered).toBe(true);
    expect(firstTrigger.body.event.triggeredAt).not.toBeNull();

    // A second call — e.g. a later visitor's Shop-mode session noticing
    // the same due event — is a harmless no-op, not a second effect.
    const secondTrigger = await api(`/instances/calendar-trigger-instance/events/${futureEventId}/trigger`, { method: 'POST' });
    expect(secondTrigger.response.status).toBe(200);
    expect(secondTrigger.body.triggered).toBe(false);
    expect(secondTrigger.body.event.triggeredAt).toBe(firstTrigger.body.event.triggeredAt);

    const triggerOnMissing = await api('/instances/calendar-trigger-instance/events/event-does-not-exist/trigger', { method: 'POST' });
    expect(triggerOnMissing.response.status).toBe(404);
  });

  // #270: two callers hitting the endpoint sequentially (the test above)
  // can't exercise the actual race — by the time the second call runs, the
  // early `event.triggered_at` check already short-circuits it before it
  // ever reaches the UPDATE. Real concurrent calls both pass that check
  // first, so this is the only way to catch a regression back to deciding
  // `triggered` from a re-SELECT instead of the UPDATE's own row count.
  it('reports triggered:true to exactly one caller when two requests race the same due event', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-race-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 12,
        y: 12,
        isCommunityCalendar: true,
      }),
    }));
    const created = await api('/instances/calendar-race-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Race event', scheduledAt: '2099-01-01T00:00:00.000Z' }),
    }));
    const eventId = created.body.event.eventId;
    await env.DB.prepare(`UPDATE calendar_events SET scheduled_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?`).bind(eventId).run();

    const [first, second] = await Promise.all([
      api(`/instances/calendar-race-instance/events/${eventId}/trigger`, { method: 'POST' }),
      api(`/instances/calendar-race-instance/events/${eventId}/trigger`, { method: 'POST' }),
    ]);
    const triggeredFlags = [first.body.triggered, second.body.triggered];
    expect(triggeredFlags.filter(Boolean)).toHaveLength(1);
  });

  // Found via backlog audit (#609): unlike the structurally near-identical
  // sign-post POST ("rate-limits repeated posts from the same client" above,
  // #337) and friend requests (FRIEND_REQUEST_RATE_LIMIT_MAX), posting a
  // calendar event had no checkRateLimit call at all. A dedicated
  // builder+landlet, not calendarBuilder/calendarLandlet, so this test's own
  // bucket doesn't collide with the other calendar tests' own event posts.
  it('rate-limits repeated event postings from the same builder', async () => {
    const rateLimitBuilder = await signupBuilder('calendar-rate-limit-builder');
    await createGreenbeltLandlet('calendar-rate-limit-landlet');
    await api('/landlets/calendar-rate-limit-landlet/claim', rateLimitBuilder.session({ method: 'POST' }));
    await api('/instances', rateLimitBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-rate-limit-instance',
        landletId: 'calendar-rate-limit-landlet',
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
        isCommunityCalendar: true,
      }),
    }));

    for (let i = 0; i < 20; i++) {
      const attempt = await api('/instances/calendar-rate-limit-instance/events', rateLimitBuilder.session({
        method: 'POST', body: JSON.stringify({ text: `Event ${i}` }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/instances/calendar-rate-limit-instance/events', rateLimitBuilder.session({
      method: 'POST', body: JSON.stringify({ text: 'One too many' }),
    }));
    expect(limited.response.status).toBe(429);
  });
});

describe('Extensibility (crop floor)', () => {
  it('rejects a non-object metadata.extensible', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-not-an-object',
        name: 'Bad extensible shape',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: 'x' },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/metadata\.extensible must be an object/);
  });

  it('rejects an unrecognized axis key', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-bad-axis',
        name: 'Bad extensible axis',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: { w: { minM: 1 } } },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/metadata\.extensible key "w" must be one of/);
  });

  // The actual bug (#271): a bypassed-frontend request that sets a
  // non-numeric/missing/negative minM used to sail straight through with
  // no validation at all, defeating assertCropWithinTemplateBounds's crop
  // floor at read time (JS's numeric comparison makes `anything < NaN` and
  // `anything < undefined` both false).
  it('rejects a missing, non-numeric, NaN, zero, or negative metadata.extensible.x.minM', async () => {
    let n = 0;
    for (const minM of [undefined, 'not-a-number', NaN, 0, -1]) {
      n += 1;
      const rejected = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: `extensible-bad-minm-${n}`,
          name: 'Bad extensible minM',
          color: '#111111',
          dimensions: { width: 2, depth: 2, height: 2 },
          metadata: { extensible: { x: minM === undefined ? {} : { minM } } },
        }),
      });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toMatch(/metadata\.extensible\.x\.minM must be a positive number/);
    }
  });

  it('rejects a minM at or above the template\'s own dimension for that axis', async () => {
    const atMax = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-minm-at-max',
        name: 'minM equals width',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: { x: { minM: 2 } } },
      }),
    });
    expect(atMax.response.status).toBe(400);
    expect(atMax.body.error).toMatch(/metadata\.extensible\.x\.minM must be less than this template's own width/);

    const overMax = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-minm-over-max',
        name: 'minM exceeds width',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: { x: { minM: 3 } } },
      }),
    });
    expect(overMax.response.status).toBe(400);
  });

  it('accepts a valid multi-axis metadata.extensible and round-trips it through GET and PATCH', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-valid-template',
        name: 'Extensible along x and y',
        color: '#111111',
        dimensions: { width: 4, depth: 3, height: 1 },
        metadata: { extensible: { x: { minM: 1 }, y: { minM: 0.5 } } },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.extensible).toEqual({ x: { minM: 1 }, y: { minM: 0.5 } });

    const fetched = await api('/catalog/extensible-valid-template');
    expect(fetched.body.template.metadata.extensible).toEqual({ x: { minM: 1 }, y: { minM: 0.5 } });

    // Clearing it (an all-axes-unchecked save, per src/main.js's own "full
    // replace, not merge" contract) removes the key entirely, same as the
    // sibling flags above.
    const cleared = await api('/catalog/extensible-valid-template', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.extensible).toBeUndefined();
  });

  // Found via backlog audit (#338): shrinking a template's width (or
  // raising its extensible.x.minM) after an instance already has a valid
  // crop set used to brick that instance -- any later PATCH re-validated
  // the *carried-over* crop against the template's *current* bounds, even
  // when the request itself never touched crop or templateId.
  it('does not re-validate an unchanged crop value against a template shrunk after the crop was set', async () => {
    const builder = await signupBuilder('crop-revalidation-builder');
    await createGreenbeltLandlet('crop-revalidation-landlet');
    await api('/landlets/crop-revalidation-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'crop-revalidation-template',
        name: 'Shrinkable extensible product',
        color: '#111111',
        dimensions: { width: 4, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 1 } } },
      }),
    });

    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'crop-revalidation-instance',
        landletId: 'crop-revalidation-landlet',
        templateId: 'crop-revalidation-template',
        x: 1, y: 1,
        crop: { x: 2 },
      }),
    }));
    expect(placed.response.status).toBe(201);

    // Seller shrinks the template — the now-stale crop.x=2 no longer fits
    // (width 4 -> 1.5), but nothing re-validates existing instances yet.
    const shrunk = await api('/catalog/crop-revalidation-template', {
      method: 'PATCH',
      body: JSON.stringify({ dimensions: { width: 1.5, depth: 1, height: 1 } }),
    });
    expect(shrunk.response.status).toBe(200);

    // An unrelated PATCH (just moving it) must still succeed even though it
    // resends the same unchanged crop.x=2 -- matching src/main.js's
    // syncUpdate, which always round-trips the mesh's full current state
    // (crop included) on every edit, not just a sparse diff. A presence-only
    // check ("did the body include crop?") would wrongly re-reject this.
    const moved = await api('/instances/crop-revalidation-instance', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ x: 5, y: 5, crop: { x: 2 } }),
    }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.instance.crop).toEqual({ x: 2 });
    expect(moved.body.instance).toMatchObject({ x: 5, y: 5 });

    // But actually changing the crop value now correctly 400s -- the caller
    // IS asserting a new crop/template pairing that must hold today. 1.6 is
    // above the shrunk template's own width (1.5), so it's out of bounds
    // regardless of this fix.
    const realCropChange = await api('/instances/crop-revalidation-instance', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ crop: { x: 1.6 } }),
    }));
    expect(realCropChange.response.status).toBe(400);

    // Switching templateId is re-validated even with the same crop value,
    // since it's now measured against a different template's bounds.
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'crop-revalidation-other-template',
        name: 'Another extensible product',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 0.5 } } },
      }),
    });
    const templateSwap = await api('/instances/crop-revalidation-instance', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ templateId: 'crop-revalidation-other-template', crop: { x: 2 } }),
    }));
    expect(templateSwap.response.status).toBe(400);
  });

  // #597: same fix as directly above, but for PUT /instances/batch, which
  // never got it -- src/api.js's upsertInstancesRemote uses this endpoint
  // for a multi-item group move or an undo/redo snapshot restore, both of
  // which resend every affected instance's full current state (crop
  // included), untouched ones alongside whatever the request actually
  // meant to change. Unconditionally re-validating crop there would brick
  // the *entire batch* the moment it included an instance whose template
  // was shrunk after its crop was already set -- the same bricking #338
  // fixed for the single-instance endpoint just above.
  it('does not re-validate an unchanged crop value in a batch that also moves an unrelated instance', async () => {
    const builder = await signupBuilder('batch-crop-revalidation-builder');
    await createGreenbeltLandlet('batch-crop-revalidation-landlet');
    await api('/landlets/batch-crop-revalidation-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'batch-crop-revalidation-template',
        name: 'Shrinkable extensible product',
        color: '#111111',
        dimensions: { width: 4, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 1 } } },
      }),
    });

    const placed = await api('/instances/batch', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-crop-revalidation-instance',
          landletId: 'batch-crop-revalidation-landlet',
          templateId: 'batch-crop-revalidation-template',
          x: 1, y: 1,
          crop: { x: 2 },
        }],
      }),
    }));
    expect(placed.response.status).toBe(201);

    // Shrink the template — the stale crop.x=2 no longer fits (width 4 -> 1.5).
    const shrunk = await api('/catalog/batch-crop-revalidation-template', {
      method: 'PATCH',
      body: JSON.stringify({ dimensions: { width: 1.5, depth: 1, height: 1 } }),
    });
    expect(shrunk.response.status).toBe(200);

    // A group move that resends this instance's full current state (crop
    // included, unchanged) must still succeed, same as the single-instance
    // case above — a presence-only check would wrongly re-reject it.
    const moved = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-crop-revalidation-instance',
          landletId: 'batch-crop-revalidation-landlet',
          templateId: 'batch-crop-revalidation-template',
          x: 5, y: 5,
          crop: { x: 2 },
        }],
      }),
    }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.instances[0].crop).toEqual({ x: 2 });
    expect(moved.body.instances[0]).toMatchObject({ x: 5, y: 5 });

    // But actually changing the crop value in a batch still correctly 400s
    // — 1.6 is above the shrunk template's own width (1.5).
    const realCropChange = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-crop-revalidation-instance',
          landletId: 'batch-crop-revalidation-landlet',
          templateId: 'batch-crop-revalidation-template',
          x: 5, y: 5,
          crop: { x: 1.6 },
        }],
      }),
    }));
    expect(realCropChange.response.status).toBe(400);
  });
});

describe('Land cap', () => {
  async function createBuilder(label) {
    const res = await api('/builders', { method: 'POST', body: JSON.stringify({ label }) });
    return res.body.builder.builderId;
  }

  async function createGreenbeltLandletWithArea(landletId, areaM2) {
    return api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
    }));
  }

  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  // #629: bidding now also requires the bidder to actually hold enough
  // higgles_balance_cents to cover the bid — independent of the land-cap
  // gating these tests exist to exercise. Fund bidders past their (small)
  // bid amount so a rejection here is unambiguously about land cap, not
  // balance (see worker/index.js's handleAuctionBids/resolveAuction).
  async function fundHiggles(builder, amountCents = 100_000_000) {
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(amountCents, builder.builderId).run();
  }

  async function startAuction(landletId, seller) {
    return api(`/landlets/${landletId}/auction`, seller.session({
      method: 'POST',
      body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
  }

  function landCapOf(listResponse, builderId) {
    return listResponse.body.builders.find((b) => b.builderId === builderId).landCapM2;
  }

  it('defaults every new builder to a 1000 m² land cap', async () => {
    const builderId = await createBuilder('Land Cap Default Builder');
    expect(landCapOf(await api('/builders'), builderId)).toBe(1000);
  });

  // #489 (owner-confirmed): this used to be deliberately unenforced — see
  // that issue and worker/index.js's own handleAuctionBids comment for why
  // ("real checkout now exists" was the trigger the original comment
  // named to revisit this). A bid is only ever a *ground* landlet
  // changing hands (resolveAuction deletes the sold landlet's levels
  // before transferring it), so what's checked is the bidder's own
  // current owned area plus the auctioned landlet's area_m2 against their
  // cap — a fresh bidder here owns nothing yet, so a 5000m² landlet alone
  // already exceeds their default 1000m² cap.
  it('blocks a bid that would take the bidder over their land cap', async () => {
    const seller = await signupBuilder('land-cap-seller-a');
    const bidder = await signupBuilder('land-cap-bidder-a');
    await fundHiggles(bidder);
    await createGreenbeltLandletWithArea('land-cap-big-landlet', 5000);
    await claim('land-cap-big-landlet', seller);
    const started = await startAuction('land-cap-big-landlet', seller);
    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(409);
    expect(bid.body.error).toMatch(/land cap/i);
  });

  it('allows a bid that stays within the bidder\'s land cap', async () => {
    const seller = await signupBuilder('land-cap-seller-b');
    const bidder = await signupBuilder('land-cap-bidder-b');
    await fundHiggles(bidder);
    await createGreenbeltLandletWithArea('land-cap-small-landlet', 900);
    await claim('land-cap-small-landlet', seller);
    const started = await startAuction('land-cap-small-landlet', seller);
    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(201);
  });

  // Same one-unit display-rounding buffer as the level-add gate (owner
  // feedback — see worker/index.js's land-cap comment block), pinned down
  // on the bidding side too: a fresh bidder's default cap is 1000m², so a
  // 1001m² landlet is within the buffer and a 1002m² one is not.
  it('gives the auction-bid land cap gate the same one-unit display-rounding buffer', async () => {
    const sellerWithin = await signupBuilder('land-cap-buffer-seller-within');
    const bidderWithin = await signupBuilder('land-cap-buffer-bidder-within');
    await fundHiggles(bidderWithin);
    await createGreenbeltLandletWithArea('land-cap-buffer-within-landlet', 1001);
    await claim('land-cap-buffer-within-landlet', sellerWithin);
    const startedWithin = await startAuction('land-cap-buffer-within-landlet', sellerWithin);
    const withinBid = await api(`/auctions/${startedWithin.body.auction.auctionId}/bids`, bidderWithin.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(withinBid.response.status).toBe(201);

    const sellerBeyond = await signupBuilder('land-cap-buffer-seller-beyond');
    const bidderBeyond = await signupBuilder('land-cap-buffer-bidder-beyond');
    await fundHiggles(bidderBeyond);
    await createGreenbeltLandletWithArea('land-cap-buffer-beyond-landlet', 1002);
    await claim('land-cap-buffer-beyond-landlet', sellerBeyond);
    const startedBeyond = await startAuction('land-cap-buffer-beyond-landlet', sellerBeyond);
    const beyondBid = await api(`/auctions/${startedBeyond.body.auction.auctionId}/bids`, bidderBeyond.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(beyondBid.response.status).toBe(409);
  });

  it('grows a builder\'s land cap from trailing higgles earnings, normalized per 1000 m² owned', async () => {
    const builderId = await createBuilder('Land Cap Formula Builder');
    // $40 of trailing earnings, normalized against zero owned (floored to
    // the 1000 m² baseline), at 100 m² per dollar per 1000 m² owned =>
    // +4000 m² -> candidate cap 5000.
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-formula-earning', builderId, 4000).run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);
  });

  it('ratchets — a cap increase never reverts even after the earnings that produced it age out of the trailing window', async () => {
    const builderId = await createBuilder('Land Cap Ratchet Builder');
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-ratchet-earning', builderId, 4000).run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);

    // Age the earning out of the 30-day trailing window, then force another
    // recompute (any GET /builders does this) — the cap must NOT drop back
    // down even though the earnings that grew it are now stale, matching
    // docs/SPEC.md §3's "ratcheting: once increased, never decreases."
    await env.DB.prepare(`
      UPDATE higgles_earnings_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?
    `).bind('land-cap-ratchet-earning').run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);
  });

  it('credits a real per-event earnings ledger entry when an auction actually sells', async () => {
    const seller = await signupBuilder('land-cap-ledger-seller');
    const bidder = await signupBuilder('land-cap-ledger-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandletWithArea('land-cap-ledger-landlet', 1000);
    await claim('land-cap-ledger-landlet', seller);
    const started = await startAuction('land-cap-ledger-landlet', seller);
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();
    await api(`/auctions/${auctionId}`); // GET resolves a due auction lazily

    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(seller.builderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(500);
  });

  // #629 (owner-confirmed): a bid holds land cap until the bidder is
  // outbid or the auction closes, so leading on one auction now counts
  // against what a second bid elsewhere is allowed to commit to — closing
  // the gap where a builder could win more auctions than their cap could
  // ever actually cover.
  it("counts a bidder's currently-leading bid on another active auction against their land cap for a new bid", async () => {
    const sellerA = await signupBuilder('land-cap-hold-seller-a');
    const sellerB = await signupBuilder('land-cap-hold-seller-b');
    const bidder = await signupBuilder('land-cap-hold-bidder');
    await fundHiggles(bidder);
    // A fresh builder's cap is 1000 m² — leading on a 700 m² auction plus
    // a second 700 m² bid would be 1400 m², over cap, even though neither
    // bid alone would be.
    await createGreenbeltLandletWithArea('land-cap-hold-landlet-a', 700);
    await createGreenbeltLandletWithArea('land-cap-hold-landlet-b', 700);
    await claim('land-cap-hold-landlet-a', sellerA);
    await claim('land-cap-hold-landlet-b', sellerB);
    const auctionA = await startAuction('land-cap-hold-landlet-a', sellerA);
    const auctionB = await startAuction('land-cap-hold-landlet-b', sellerB);

    const firstBid = await api(`/auctions/${auctionA.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(firstBid.response.status).toBe(201);

    const secondBid = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(secondBid.response.status).toBe(409);
    expect(secondBid.body.error).toMatch(/land cap/i);

    // Being outbid releases the hold — the same bid now succeeds once
    // someone else takes over the lead on the first auction.
    const outbidder = await signupBuilder('land-cap-hold-outbidder');
    await fundHiggles(outbidder);
    const outbid = await api(`/auctions/${auctionA.body.auction.auctionId}/bids`, outbidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 600 }),
    }));
    expect(outbid.response.status).toBe(201);

    const thirdBid = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(thirdBid.response.status).toBe(201);
  });

  it('lets a builder claim their one free starter lándlet regardless of the land cap', async () => {
    // The claim endpoint's own NOT EXISTS guard already limits a builder to
    // exactly one claimed lándlet at a time regardless of land cap, so a
    // fresh builder's default 1000 m² cap claiming a 1000 m² starter
    // lándlet is unaffected by this feature at all.
    const builder = await signupBuilder('land-cap-claim-builder');
    await createGreenbeltLandletWithArea('land-cap-starter-landlet', 1000);
    const claimed = await claim('land-cap-starter-landlet', builder);
    expect(claimed.response.status).toBe(200);
    expect(claimed.body.landlet.ownerBuilderId).toBe(builder.builderId);
  });

  // #489 made land cap a real gate, so anything (a test fixture, an e2e
  // suite) that needs a builder to already have cap headroom now needs a
  // legitimate way to grant it — there's no shortcut through the normal
  // player-facing API, on purpose (a real earnings event is the only thing
  // that's ever supposed to grow a cap). Admin-gated for the same reason
  // POST /api/landlets is: an anonymous caller must not be able to credit
  // themselves real land-cap headroom.
  it('grants land cap headroom via a real earnings event, admin-only', async () => {
    const builder = await createBuilder('Land Cap Grant Builder');

    const unauthenticated = await api(`/builders/${builder}/land-cap-grants`, {
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    });
    expect(unauthenticated.response.status).toBe(401);

    const nonAdmin = await api(`/builders/${builder}/land-cap-grants`, (await signupBuilder('land-cap-grant-non-admin')).session({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(nonAdmin.response.status).toBe(403);

    const granted = await api(`/builders/${builder}/land-cap-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(granted.response.status).toBe(201);
    expect(granted.body.landCapM2).toBeGreaterThan(1000);
    expect(landCapOf(await api('/builders'), builder)).toBe(granted.body.landCapM2);

    // It's a real earnings event, same ledger auction sales credit — not a
    // side-channel that bypasses it.
    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(builder).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(100000);

    const missingBuilder = await api('/builders/does-not-exist/land-cap-grants', adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(missingBuilder.response.status).toBe(404);
  });

  // #629: bidding now also requires the bidder to hold enough
  // higgles_balance_cents to cover their bid — deliberately independent of
  // land-cap-grants above, which only ever touches the earnings ledger
  // (cap growth), never balance. A test fixture needing a builder to
  // actually *afford* a bid needs this instead.
  it('grants higgles balance directly, admin-only, independent of land-cap-grants', async () => {
    const builder = await createBuilder('Higgles Grant Builder');

    const unauthenticated = await api(`/builders/${builder}/higgles-grants`, {
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    });
    expect(unauthenticated.response.status).toBe(401);

    const nonAdmin = await api(`/builders/${builder}/higgles-grants`, (await signupBuilder('higgles-grant-non-admin')).session({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(nonAdmin.response.status).toBe(403);

    const granted = await api(`/builders/${builder}/higgles-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(granted.response.status).toBe(201);
    expect(granted.body.higglesBalanceCents).toBe(100000);

    // Additive, not a flat set — a second grant stacks onto the first.
    const grantedAgain = await api(`/builders/${builder}/higgles-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 50000 }),
    }));
    expect(grantedAgain.response.status).toBe(201);
    expect(grantedAgain.body.higglesBalanceCents).toBe(150000);

    // Unlike land-cap-grants, this never touches the earnings ledger — it's
    // a pure balance top-up, not a stand-in for real income.
    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(builder).all();
    expect(results).toHaveLength(0);
    expect(landCapOf(await api('/builders'), builder)).toBe(1000);

    const missingBuilder = await api('/builders/does-not-exist/higgles-grants', adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(missingBuilder.response.status).toBe(404);
  });
});

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

    const instances = await api('/instances?landletId=levels-remove-instances-landlet');
    expect(instances.body.instances.map((i) => i.instanceId)).toEqual(['levels-remove-instances-ground']);
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
  });

  // #636 (last sub-issue of #631): applying a saved layout's instances onto
  // a target landlet as brand-new placed_instances rows.
  describe('Pasting saved-layout instances onto a landlet (#636)', () => {
    // Mirrors the "Listing and deleting" describe block's own saveALayout
    // helper above, but also hands back the saved instance's own
    // source_instance_id (needed as this endpoint's own instanceIds body
    // field) and the owner's second, still-empty claimed landlet to paste
    // onto (a builder can hold two simultaneously-claimed landlets per
    // #199/#249 — see renderStartSection's own comment in src/main.js).
    async function saveALayoutWithTarget(label) {
      const owner = await signupBuilder(`${label}-owner`);
      const sourceLandletId = `${label}-source`;
      const targetLandletId = `${label}-target`;
      await createGreenbeltLandletWithArea(sourceLandletId, 1000);
      await claim(sourceLandletId, owner);
      await growLandCapHeadroom(owner.builderId);
      await api(`/landlets/${sourceLandletId}/levels`, owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));
      const placed = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId: `${label}-upper`,
          landletId: sourceLandletId,
          templateId: 'placeholder-tree',
          x: 2, y: 3, z: LEVEL_HEIGHT_M * 1.5,
          rotationZ: 1.25,
        }),
      }));
      expect(placed.response.status).toBe(201);
      const removed = await api(`/landlets/${sourceLandletId}/levels/1`, owner.session({ method: 'DELETE' }));
      expect(removed.response.status).toBe(200);
      const { results } = await env.DB.prepare('SELECT * FROM saved_level_layouts WHERE builder_id = ?')
        .bind(owner.builderId).all();
      const savedLayoutId = results[0].saved_layout_id;
      const { results: savedInstances } = await env.DB.prepare(
        'SELECT source_instance_id FROM saved_layout_instances WHERE saved_layout_id = ?',
      ).bind(savedLayoutId).all();

      await createGreenbeltLandletWithArea(targetLandletId, 1000);
      // Bypasses the real one-at-a-time /claim flow purely for this test's
      // own setup convenience, same as the pagination test above.
      await env.DB.prepare(`
        UPDATE landlets SET status = 'claimed', owner_builder_id = ?,
          claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ?
      `).bind(owner.builderId, targetLandletId).run();

      return {
        owner, savedLayoutId, targetLandletId, sourceInstanceId: savedInstances[0].source_instance_id,
      };
    }

    it('requires a session to paste', async () => {
      const { savedLayoutId, targetLandletId, sourceInstanceId } = await saveALayoutWithTarget('paste-noauth');
      const got = await api(`/saved-layouts/${savedLayoutId}/paste`, {
        method: 'POST', body: JSON.stringify({ instanceIds: [sourceInstanceId], landletId: targetLandletId }),
      });
      expect(got.response.status).toBe(401);
    });

    it("rejects pasting from another builder's saved layout", async () => {
      const { savedLayoutId, targetLandletId, sourceInstanceId } = await saveALayoutWithTarget('paste-notmine');
      const stranger = await signupBuilder('paste-notmine-stranger');
      const got = await api(`/saved-layouts/${savedLayoutId}/paste`, stranger.session({
        method: 'POST', body: JSON.stringify({ instanceIds: [sourceInstanceId], landletId: targetLandletId }),
      }));
      expect(got.response.status).toBe(403);
    });

    it('404s pasting a saved layout that does not exist', async () => {
      const builder = await signupBuilder('paste-missing-layout');
      const got = await api('/saved-layouts/does-not-exist/paste', builder.session({
        method: 'POST', body: JSON.stringify({ instanceIds: ['anything'], landletId: 'starter-landlet' }),
      }));
      expect(got.response.status).toBe(404);
    });

    it('rejects an empty instanceIds array', async () => {
      const { owner, savedLayoutId, targetLandletId } = await saveALayoutWithTarget('paste-empty-ids');
      const got = await api(`/saved-layouts/${savedLayoutId}/paste`, owner.session({
        method: 'POST', body: JSON.stringify({ instanceIds: [], landletId: targetLandletId }),
      }));
      expect(got.response.status).toBe(400);
    });

    it("rejects an instanceId that doesn't belong to this saved layout", async () => {
      const { owner, savedLayoutId, targetLandletId } = await saveALayoutWithTarget('paste-bad-id');
      const got = await api(`/saved-layouts/${savedLayoutId}/paste`, owner.session({
        method: 'POST', body: JSON.stringify({ instanceIds: ['not-in-this-layout'], landletId: targetLandletId }),
      }));
      expect(got.response.status).toBe(400);
    });

    it('rejects pasting onto a landlet the builder does not own', async () => {
      const { owner, savedLayoutId, sourceInstanceId } = await saveALayoutWithTarget('paste-not-owned');
      await createGreenbeltLandletWithArea('paste-not-owned-elsewhere', 1000);
      const got = await api(`/saved-layouts/${savedLayoutId}/paste`, owner.session({
        method: 'POST', body: JSON.stringify({ instanceIds: [sourceInstanceId], landletId: 'paste-not-owned-elsewhere' }),
      }));
      expect(got.response.status).toBe(403);
    });

    it("rejects pasting where the target landlet's current levels don't reach the saved z", async () => {
      // The saved instance sits at LEVEL_HEIGHT_M * 1.5 (its source landlet
      // had a level added before removal) — the freshly-claimed target
      // above never gained one, so its own implicit ground-level-only
      // range can't fit it, mirroring a normal instance create's own
      // assertInstanceZWithinLevels rejection.
      const { owner, savedLayoutId, targetLandletId, sourceInstanceId } = await saveALayoutWithTarget('paste-z-oob');
      const got = await api(`/saved-layouts/${savedLayoutId}/paste`, owner.session({
        method: 'POST', body: JSON.stringify({ instanceIds: [sourceInstanceId], landletId: targetLandletId }),
      }));
      expect(got.response.status).toBe(400);
    });

    it('pastes selected instances onto a target landlet as new placed_instances rows, leaving the saved layout intact', async () => {
      const {
        owner, savedLayoutId, targetLandletId, sourceInstanceId,
      } = await saveALayoutWithTarget('paste-real');
      // Give the target the same headroom (a level up) the z-check above
      // shows is otherwise required.
      await api(`/landlets/${targetLandletId}/levels`, owner.session({
        method: 'POST', body: JSON.stringify({ direction: 'up' }),
      }));

      const pasted = await api(`/saved-layouts/${savedLayoutId}/paste`, owner.session({
        method: 'POST', body: JSON.stringify({ instanceIds: [sourceInstanceId], landletId: targetLandletId }),
      }));
      expect(pasted.response.status).toBe(201);
      expect(pasted.body.instances).toHaveLength(1);
      const [created] = pasted.body.instances;
      expect(created.instanceId).not.toBe(sourceInstanceId); // fresh id, not reused
      expect(created.landletId).toBe(targetLandletId);
      expect(created.templateId).toBe('placeholder-tree');
      expect(created.x).toBe(2);
      expect(created.y).toBe(3);
      expect(created.z).toBe(LEVEL_HEIGHT_M * 1.5);
      expect(created.rotationZ).toBe(1.25);

      const onTarget = await api(`/instances?landletId=${targetLandletId}`);
      expect(onTarget.body.instances.map((i) => i.instanceId)).toContain(created.instanceId);

      // The saved layout itself is untouched — still fetchable, still
      // holding its own original snapshot row, so the same selection (or a
      // different one) can be pasted again later.
      const stillThere = await api(`/saved-layouts/${savedLayoutId}`, owner.session());
      expect(stillThere.response.status).toBe(200);
      expect(stillThere.body.savedLayout.instances).toHaveLength(1);
      expect(stillThere.body.savedLayout.instances[0].instanceId).toBe(sourceInstanceId);
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
    const afterAdd = (await api('/builders')).body.builders.find((b) => b.builderId === owner.builderId).landCapM2;
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

    const listed = (await api('/builders')).body.builders.find((b) => b.builderId === owner.builderId);
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
});
