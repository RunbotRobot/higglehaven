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
    // untouched by any of this and still succeeds normally.
    expect([200, 409]).toContain(patched.response.status);

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

  it('does not block a bid that would exceed the bidder\'s cap — tracking only, not enforced', async () => {
    const seller = await signupBuilder('land-cap-seller-a');
    const bidder = await signupBuilder('land-cap-bidder-a');
    await createGreenbeltLandletWithArea('land-cap-big-landlet', 5000);
    await claim('land-cap-big-landlet', seller);
    const started = await startAuction('land-cap-big-landlet', seller);
    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(201);
  });

  it('grows a builder\'s land cap from trailing dáller earnings, normalized per 1000 m² owned', async () => {
    const builderId = await createBuilder('Land Cap Formula Builder');
    // $40 of trailing earnings, normalized against zero owned (floored to
    // the 1000 m² baseline), at 100 m² per dollar per 1000 m² owned =>
    // +4000 m² -> candidate cap 5000.
    await env.DB.prepare(`
      INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-formula-earning', builderId, 4000).run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);
  });

  it('ratchets — a cap increase never reverts even after the earnings that produced it age out of the trailing window', async () => {
    const builderId = await createBuilder('Land Cap Ratchet Builder');
    await env.DB.prepare(`
      INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-ratchet-earning', builderId, 4000).run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);

    // Age the earning out of the 30-day trailing window, then force another
    // recompute (any GET /builders does this) — the cap must NOT drop back
    // down even though the earnings that grew it are now stale, matching
    // docs/SPEC.md §3's "ratcheting: once increased, never decreases."
    await env.DB.prepare(`
      UPDATE daller_earnings_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?
    `).bind('land-cap-ratchet-earning').run();
    expect(landCapOf(await api('/builders'), builderId)).toBe(5000);
  });

  it('credits a real per-event earnings ledger entry when an auction actually sells', async () => {
    const seller = await signupBuilder('land-cap-ledger-seller');
    const bidder = await signupBuilder('land-cap-ledger-bidder');
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
      'SELECT * FROM daller_earnings_events WHERE builder_id = ?',
    ).bind(seller.builderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(500);
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

  it('adds sequential levels above and below ground, each costing the correct asymmetric cap', async () => {
    const owner = await signupBuilder('levels-sequential-owner');
    await createGreenbeltLandletWithArea('levels-sequential-landlet', 1000);
    await claim('levels-sequential-landlet', owner);

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

  it('folds level cap consumption into the owning builder\'s land cap growth formula', async () => {
    const owner = await signupBuilder('levels-cap-owner');
    await createGreenbeltLandletWithArea('levels-cap-landlet', 1000);
    await claim('levels-cap-landlet', owner);
    await api('/landlets/levels-cap-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    const levelCapM2 = expectedCapConsumedM2(1000, 1);

    // $40 trailing earnings, normalized against (1000 ground + the level's
    // own consumed area) instead of just 1000 — a strictly smaller land
    // cap increase than the plain "1000 m² owned" Land cap formula test
    // above gets from the same $40, proving the level's own area was
    // actually folded into the normalization.
    await env.DB.prepare(`
      INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
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
    await api('/landlets/levels-owned-area-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));
    const levelCapM2 = expectedCapConsumedM2(1000, 1);
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
    await api('/landlets/levels-delete-landlet/levels', owner.session({
      method: 'POST', body: JSON.stringify({ direction: 'up' }),
    }));

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
});
