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

  // #1022: same gap as community signs' own unflag/reflag test above --
  // calendar_events rows were never cleared on unflag, so a later reflag of
  // the same instance silently resurrected old events.
  it('clears old calendar events when unflagged, so a later reflag does not resurrect them', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-unflag-reflag-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 7,
        y: 7,
        isCommunityCalendar: true,
      }),
    }));
    const posted = await api('/instances/calendar-unflag-reflag-instance/events', calendarBuilder.session({
      method: 'POST', body: JSON.stringify({ text: 'Market day Saturday!' }),
    }));
    expect(posted.response.status).toBe(201);

    const unflagged = await api('/instances/calendar-unflag-reflag-instance', calendarBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunityCalendar: false }),
    }));
    expect(unflagged.response.status).toBe(200);
    expect(unflagged.body.instance.isCommunityCalendar).toBe(false);

    const reflagged = await api('/instances/calendar-unflag-reflag-instance', calendarBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunityCalendar: true }),
    }));
    expect(reflagged.response.status).toBe(200);
    expect(reflagged.body.instance.isCommunityCalendar).toBe(true);

    const list = await api('/instances/calendar-unflag-reflag-instance/events');
    expect(list.body.events).toHaveLength(0);
  });

  // #1675: same #1022 cleanup as the single-instance test just above, but
  // for PUT /instances/batch -- see the sibling community-signs batch test
  // above for the full reasoning.
  it('clears old calendar events when unflagged via a batch update, so a later reflag does not resurrect them', async () => {
    await api('/instances/batch', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{
          instanceId: 'calendar-batch-unflag-reflag-instance',
          landletId: calendarLandlet,
          templateId: 'placeholder-tree',
          x: 8,
          y: 8,
          isCommunityCalendar: true,
        }],
      }),
    }));
    const posted = await api('/instances/calendar-batch-unflag-reflag-instance/events', calendarBuilder.session({
      method: 'POST', body: JSON.stringify({ text: 'Batch-path event' }),
    }));
    expect(posted.response.status).toBe(201);

    const unflagged = await api('/instances/batch', calendarBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'calendar-batch-unflag-reflag-instance',
          landletId: calendarLandlet,
          templateId: 'placeholder-tree',
          x: 8,
          y: 8,
          isCommunityCalendar: false,
        }],
      }),
    }));
    expect(unflagged.response.status).toBe(200);
    expect(unflagged.body.instances[0].isCommunityCalendar).toBe(false);

    const reflagged = await api('/instances/batch', calendarBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'calendar-batch-unflag-reflag-instance',
          landletId: calendarLandlet,
          templateId: 'placeholder-tree',
          x: 8,
          y: 8,
          isCommunityCalendar: true,
        }],
      }),
    }));
    expect(reflagged.response.status).toBe(200);
    expect(reflagged.body.instances[0].isCommunityCalendar).toBe(true);

    const list = await api('/instances/calendar-batch-unflag-reflag-instance/events');
    expect(list.body.events).toHaveLength(0);
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

  // #1327: same gap as the sign-post POST race above -- the
  // is_community_calendar check is a point-in-time read, with checkRateLimit
  // a real awaited write after it (and before the INSERT), unlike this
  // handler's own DELETE sibling which already folds its own re-check into
  // the write (#929/#960).
  it('rejects an event if the instance was unflagged between the initial check and the insert', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-post-flag-race-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 8,
        y: 8,
        isCommunityCalendar: true,
      }),
    }));

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE placed_instances SET is_community_calendar = 0 WHERE instance_id = ?')
          .bind('calendar-post-flag-race-instance').run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api('/instances/calendar-post-flag-race-instance/events', calendarBuilder.session({
        method: 'POST',
        body: JSON.stringify({ text: 'Too late' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community calendar/);

    const stored = await env.DB.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE instance_id = ?')
      .bind('calendar-post-flag-race-instance').first();
    expect(stored.count).toBe(0);
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

  // #781: an admin can remove any calendar event outright, regardless of who
  // owns the hosting landlet -- same reasoning and shape as the sign-posts
  // admin override above.
  it('lets an admin delete any calendar event outright, even when the hosting landlet owner is uninvolved', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-admin-override-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 9, y: 9, isCommunityCalendar: true,
      }),
    }));
    const posted = await api('/instances/calendar-admin-override-instance/events', calendarBuilder.session({
      method: 'POST', body: JSON.stringify({ text: 'Abusive/policy-violating text goes here.' }),
    }));
    expect(posted.response.status).toBe(201);
    const eventId = posted.body.event.eventId;

    // #2388: the admin-override delete now requires a removal category.
    const missingCategory = await api(`/instances/calendar-admin-override-instance/events/${eventId}`, adminSession({ method: 'DELETE' }));
    expect(missingCategory.response.status).toBe(415);

    const deleted = await api(`/instances/calendar-admin-override-instance/events/${eventId}`, adminSession({
      method: 'DELETE', body: JSON.stringify({ category: 'harassment' }),
    }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const snapshot = await env.DB.prepare(
      'SELECT * FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?',
    ).bind('calendar_events', eventId).first();
    expect(snapshot).not.toBeNull();
    expect(snapshot.removed_category).toBe('harassment');
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({ text: 'Abusive/policy-violating text goes here.' });

    const listed = await api('/instances/calendar-admin-override-instance/events');
    expect(listed.body.events).toEqual([]);

    const adminUserId = (await api('/auth/me', adminSession())).body.user.userId;
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('delete_calendar_event_override', eventId).first();
    expect(logRow).not.toBeNull();
    expect(logRow.admin_user_id).toBe(adminUserId);
    expect(logRow.target_type).toBe('calendar_event');
  });

  // #1716: a retried POST (a dropped response, not a double-click) used to
  // create a second, fully duplicate calendar_events row for the same
  // logical event — same "lost response looks like it never reached the
  // server" idempotency-key protection as the purchase flow's own #473 fix.
  it('does not create a duplicate event when the same idempotencyKey is retried', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-idempotency-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 9,
        y: 9,
        isCommunityCalendar: true,
      }),
    }));

    const first = await api('/instances/calendar-idempotency-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!', idempotencyKey: 'retry-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api('/instances/calendar-idempotency-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!', idempotencyKey: 'retry-test-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.event.eventId).toBe(first.body.event.eventId);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE instance_id = ?')
      .bind('calendar-idempotency-instance').first();
    expect(count.n).toBe(1);

    // A different idempotencyKey (or none at all) is a genuinely separate
    // event, still created normally — this isn't a dedup-everything guard,
    // only same-key retries.
    const separate = await api('/instances/calendar-idempotency-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'A second, different event' }),
    }));
    expect(separate.response.status).toBe(201);
    expect(separate.body.event.eventId).not.toBe(first.body.event.eventId);
    const countAfterSeparate = await env.DB.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE instance_id = ?')
      .bind('calendar-idempotency-instance').first();
    expect(countAfterSeparate.n).toBe(2);
  });

  // #1751: calendarEventIdempotencyKey caches one key per instanceId for a
  // TTL, not per attempt -- reusing a stale key for a genuinely different
  // second event (instead of a true retry of the same one) used to silently
  // return the FIRST event's content as if it were the new post, dropping
  // the second event entirely with no error.
  it('creates a genuinely new event, not a silent dupe of the stale one, when the same idempotencyKey is reused for different content', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-idempotency-mismatch-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 9,
        y: 9,
        isCommunityCalendar: true,
      }),
    }));

    const first = await api('/instances/calendar-idempotency-mismatch-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Bonfire night, Friday 8pm!', idempotencyKey: 'mismatch-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    // Same cached key, but genuinely different text -- the stale key must
    // not cause this to be silently swallowed as the first event.
    const second = await api('/instances/calendar-idempotency-mismatch-instance/events', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Actually, market day instead!', idempotencyKey: 'mismatch-test-key' }),
    }));
    expect(second.response.status).toBe(201);
    expect(second.body.event.eventId).not.toBe(first.body.event.eventId);
    expect(second.body.event.text).toBe('Actually, market day instead!');

    const events = await api('/instances/calendar-idempotency-mismatch-instance/events');
    expect(events.body.events).toHaveLength(2);
    expect(events.body.events.map((e) => e.text)).toEqual(['Bonfire night, Friday 8pm!', 'Actually, market day instead!']);
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

  // #960: same race as the sign-post DELETE test in the "Community signs"
  // describe block above -- see its own comment. #1975 split deletion into
  // two independent paths (the event's own author, via user_id -- entirely
  // unaffected by landlet ownership -- and the landlet's current owner, for
  // moderation), so this needs a deleter who is the landlet's owner but NOT
  // the event's author to keep exercising the moderation path's own race
  // protection specifically (an author-authored delete no longer goes
  // through requireOwnedLandlet at all -- see the "Author self-edit/delete
  // (#1975)" describe block below for that path's own coverage).
  it('does not let a moderator delete a calendar event on a landlet that was transferred away from them mid-request', async () => {
    const author = await signupBuilder('calendar-delete-ownership-race-author');
    const moderator = await signupBuilder('calendar-delete-ownership-race-moderator');
    const thief = await signupBuilder('calendar-delete-ownership-race-thief');
    await createGreenbeltLandlet('calendar-delete-ownership-race-landlet');
    await api('/landlets/calendar-delete-ownership-race-landlet/claim', author.session({ method: 'POST' }));
    await api('/instances', author.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-delete-ownership-race-instance',
        landletId: 'calendar-delete-ownership-race-landlet',
        templateId: 'placeholder-tree',
        x: 1, y: 1, isCommunityCalendar: true,
      }),
    }));
    const posted = await api('/instances/calendar-delete-ownership-race-instance/events', author.session({
      method: 'POST', body: JSON.stringify({ text: 'Bonfire night!' }),
    }));
    const eventId = posted.body.event.eventId;

    // Transfer the landlet to the moderator -- they now own it (and will
    // attempt a moderation delete below) but are not the event's author,
    // so their own delete must go through requireOwnedLandlet, not the
    // author-direct path.
    await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
      .bind(moderator.builderId, 'calendar-delete-ownership-race-landlet').run();

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(thief.builderId, 'calendar-delete-ownership-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let deleted;
    try {
      deleted = await api(`/instances/calendar-delete-ownership-race-instance/events/${eventId}`, moderator.session({
        method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(deleted.response.status).toBe(409);

    const stillThere = await env.DB.prepare('SELECT 1 FROM calendar_events WHERE event_id = ?').bind(eventId).first();
    expect(stillThere).not.toBeNull();
  });

  // #1327: same #929/#960 race as the DELETE sibling just above, but for
  // POST -- requireOwnedLandlet is a point-in-time read, and checkRateLimit
  // is a real awaited write after it; without folding the ownership
  // re-check into the INSERT too, a landlet transferred away from this
  // builder in that gap could still let their event land on it.
  it('rejects an event on a landlet that was transferred to a new owner mid-request', async () => {
    const owner = await signupBuilder('calendar-post-ownership-race-owner');
    const newOwner = await signupBuilder('calendar-post-ownership-race-new-owner');
    await createGreenbeltLandlet('calendar-post-ownership-race-landlet');
    await api('/landlets/calendar-post-ownership-race-landlet/claim', owner.session({ method: 'POST' }));
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-post-ownership-race-instance',
        landletId: 'calendar-post-ownership-race-landlet',
        templateId: 'placeholder-tree',
        x: 1, y: 1, isCommunityCalendar: true,
      }),
    }));

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(newOwner.builderId, 'calendar-post-ownership-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api('/instances/calendar-post-ownership-race-instance/events', owner.session({
        method: 'POST',
        body: JSON.stringify({ text: 'Too late' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(409);
    expect(rejected.body.error).toMatch(/Landlet changed concurrently/);

    const stored = await env.DB.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE instance_id = ?')
      .bind('calendar-post-ownership-race-instance').first();
    expect(stored.count).toBe(0);
  });

  // #944: unlike its own POST sibling above, the DELETE branch had no rate
  // limit at all. Seeds 21 events directly via the DB (rather than via
  // POST, which is itself rate-limited to 20) so this test can actually
  // exercise 21 deletes without also hitting the create-side limit.
  it('rate-limits repeated event deletions from the same builder', async () => {
    const rateLimitBuilder = await signupBuilder('calendar-delete-rate-limit-builder');
    await createGreenbeltLandlet('calendar-delete-rate-limit-landlet');
    await api('/landlets/calendar-delete-rate-limit-landlet/claim', rateLimitBuilder.session({ method: 'POST' }));
    await api('/instances', rateLimitBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-delete-rate-limit-instance',
        landletId: 'calendar-delete-rate-limit-landlet',
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
        isCommunityCalendar: true,
      }),
    }));
    const eventIds = Array.from({ length: 21 }, (_, i) => `calendar-delete-rate-limit-event-${i}`);
    await env.DB.batch(eventIds.map((eventId) => env.DB.prepare(
      `INSERT INTO calendar_events (event_id, instance_id, author_label, text) VALUES (?, ?, ?, ?)`,
    ).bind(eventId, 'calendar-delete-rate-limit-instance', rateLimitBuilder.builder.label, 'An event')));

    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/instances/calendar-delete-rate-limit-instance/events/${eventIds[i]}`, rateLimitBuilder.session({
        method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
      }));
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api(`/instances/calendar-delete-rate-limit-instance/events/${eventIds[20]}`, rateLimitBuilder.session({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #1023: unlike every other public repeatable mutation in this file, the
  // /trigger branch had no rate limit at all. It's intentionally
  // unauthenticated (any client can race to fire a due event), so this is
  // bucketed by IP like the sign-post rate-limit test above, not by
  // builder. Seeds 21 already-due events directly via the DB so this test
  // exercises 21 triggers without needing 21 real scheduledAt round-trips.
  it('rate-limits repeated trigger calls from the same client', async () => {
    await api('/instances', calendarBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'calendar-trigger-rate-limit-instance',
        landletId: calendarLandlet,
        templateId: 'placeholder-tree',
        x: 13,
        y: 13,
        isCommunityCalendar: true,
      }),
    }));
    const eventIds = Array.from({ length: 21 }, (_, i) => `calendar-trigger-rate-limit-event-${i}`);
    await env.DB.batch(eventIds.map((eventId) => env.DB.prepare(
      `INSERT INTO calendar_events (event_id, instance_id, author_label, text, scheduled_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventId, 'calendar-trigger-rate-limit-instance', calendarBuilder.builder.label, 'An event', '2000-01-01T00:00:00.000Z')));

    const headers = { 'cf-connecting-ip': `test-${crypto.randomUUID()}` };
    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/instances/calendar-trigger-rate-limit-instance/events/${eventIds[i]}/trigger`, { method: 'POST', headers });
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/instances/calendar-trigger-rate-limit-instance/events/${eventIds[20]}/trigger`, { method: 'POST', headers });
    expect(limited.response.status).toBe(429);
  });

  // #1975: same pattern as product_reviews' own "Author self-edit/delete"
  // describe block -- an event's own author (tracked via the new user_id
  // column, migrations/0134) can edit/delete it directly, independent of
  // who currently owns the hosting landlet, unlike the pre-existing
  // moderation path (requireOwnedLandlet) which only ever worked for the
  // *current* owner.
  describe('Author self-edit/delete (#1975)', () => {
    async function setupCalendar(suffix) {
      const owner = await signupBuilder(`cal-au-${suffix}-owner`);
      await createGreenbeltLandlet(`cal-au-${suffix}-landlet`);
      await api(`/landlets/cal-au-${suffix}-landlet/claim`, owner.session({ method: 'POST' }));
      const instanceId = `cal-au-${suffix}-instance`;
      await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({
          instanceId, landletId: `cal-au-${suffix}-landlet`,
          templateId: 'placeholder-tree', x: 1, y: 1, isCommunityCalendar: true,
        }),
      }));
      return { owner, instanceId, landletId: `cal-au-${suffix}-landlet` };
    }

    async function postEvent(instanceId, builder, { text = 'An event', scheduledAt } = {}) {
      const posted = await api(`/instances/${instanceId}/events`, builder.session({
        method: 'POST', body: JSON.stringify({ text, scheduledAt }),
      }));
      expect(posted.response.status).toBe(201);
      return posted.body.event.eventId;
    }

    it('lets the event\'s own author edit it directly, even after the hosting landlet changes hands', async () => {
      const { owner, instanceId, landletId } = await setupCalendar('edit-after-transfer');
      const eventId = await postEvent(instanceId, owner, { text: 'Original text' });

      const newOwner = await signupBuilder('cal-au-edit-after-transfer-new-owner');
      await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
        .bind(newOwner.builderId, landletId).run();

      // The new landlet owner is not the event's author, so it 403s them --
      // there's no moderation equivalent for PATCH.
      const newOwnerRejected = await api(`/instances/${instanceId}/events/${eventId}`, newOwner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Hijacked' }),
      }));
      expect(newOwnerRejected.response.status).toBe(403);

      const edited = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Edited by the real author' }),
      }));
      expect(edited.response.status).toBe(200);
      expect(edited.body.event).toMatchObject({ text: 'Edited by the real author' });
    });

    it('rejects an edit from anyone other than the event\'s own author', async () => {
      const { owner, instanceId } = await setupCalendar('edit-cross-account');
      const eventId = await postEvent(instanceId, owner);
      const stranger = await signupBuilder('cal-au-edit-cross-account-stranger');

      const unauthenticated = await api(`/instances/${instanceId}/events/${eventId}`, {
        method: 'PATCH', body: JSON.stringify({ text: 'Nope' }),
      });
      expect(unauthenticated.response.status).toBe(401);

      const wrongAccount = await api(`/instances/${instanceId}/events/${eventId}`, stranger.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Nope' }),
      }));
      expect(wrongAccount.response.status).toBe(403);
    });

    // #2354: never crashes with a raw 500 when the author's own PATCH loses
    // a race to a concurrent admin-override DELETE (same shape as the
    // sign-posts race test above), fired together rather than awaited one
    // at a time.
    it('never crashes with a raw 500 when a PATCH loses a race to a concurrent admin delete', async () => {
      const { owner, instanceId } = await setupCalendar('patch-delete-race');
      const eventId = await postEvent(instanceId, owner, { text: 'Original text' });

      const [patchResult] = await Promise.all([
        api(`/instances/${instanceId}/events/${eventId}`, owner.session({
          method: 'PATCH', body: JSON.stringify({ text: 'Raced edit' }),
        })),
        api(`/instances/${instanceId}/events/${eventId}`, adminSession({
          method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
        })),
      ]);

      expect([200, 404, 409]).toContain(patchResult.response.status);
    });

    // #2429: same re-SELECT race #2354 fixed above for this handler's own
    // PATCH, never applied to this POST/create branch -- a concurrent admin
    // delete landing between the guarded INSERT committing and this
    // handler's own re-SELECT running used to crash with a raw 500 instead
    // of a clean 404. Wraps the INSERT statement's own run() (rather than
    // racing prepare() itself) so the DELETE only ever fires once the
    // INSERT has genuinely already landed.
    it('never crashes with a raw 500 when its own POST re-fetch loses a race to a concurrent delete', async () => {
      const { owner, instanceId } = await setupCalendar('post-refetch-delete-race');

      const originalPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = (sql) => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO calendar_events')) {
          const originalBind = stmt.bind.bind(stmt);
          stmt.bind = (...args) => {
            const bound = originalBind(...args);
            const originalRun = bound.run.bind(bound);
            bound.run = async () => {
              const result = await originalRun();
              await originalPrepare('DELETE FROM calendar_events WHERE instance_id = ?').bind(instanceId).run();
              return result;
            };
            return bound;
          };
        }
        return stmt;
      };
      let posted;
      try {
        posted = await api(`/instances/${instanceId}/events`, owner.session({
          method: 'POST', body: JSON.stringify({ text: 'Raced out from under me.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      // The real bug was an uncaught TypeError (raw 500) when the re-SELECT
      // after an already-successful INSERT found the row already gone.
      expect(posted.response.status).toBe(404);
    });

    it('keeps an omitted field as-is on edit, and lets scheduledAt be explicitly cleared', async () => {
      const { owner, instanceId } = await setupCalendar('edit-partial');
      const eventId = await postEvent(instanceId, owner, { text: 'Original', scheduledAt: '2099-01-01T00:00:00.000Z' });

      const textOnly = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Updated text' }),
      }));
      expect(textOnly.response.status).toBe(200);
      expect(textOnly.body.event).toMatchObject({ text: 'Updated text', scheduledAt: '2099-01-01T00:00:00.000Z' });

      const clearSchedule = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ scheduledAt: null }),
      }));
      expect(clearSchedule.response.status).toBe(200);
      expect(clearSchedule.body.event).toMatchObject({ text: 'Updated text', scheduledAt: null });
    });

    it('rejects an edit with text over 280 characters or an invalid scheduledAt', async () => {
      const { owner, instanceId } = await setupCalendar('edit-validation');
      const eventId = await postEvent(instanceId, owner);

      const tooLong = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'x'.repeat(281) }),
      }));
      expect(tooLong.response.status).toBe(400);

      const badDate = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ scheduledAt: 'not a date' }),
      }));
      expect(badDate.response.status).toBe(400);
    });

    // A changed scheduledAt is logically a different scheduled moment --
    // same "genuinely different event" distinction #1751's own idempotency-
    // key content-match already draws -- so it re-arms the one-shot
    // trigger. An edit that leaves scheduledAt unchanged must NOT reset an
    // already-fired trigger back to pending.
    it('re-arms the trigger when scheduledAt actually changes, but not when it stays the same', async () => {
      const { owner, instanceId } = await setupCalendar('edit-rearm-trigger');
      const eventId = await postEvent(instanceId, owner, { text: 'Due soon', scheduledAt: '2000-01-01T00:00:00.000Z' });
      const triggered = await api(`/instances/${instanceId}/events/${eventId}/trigger`, { method: 'POST' });
      expect(triggered.body.triggered).toBe(true);

      const sameSchedule = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Still due soon, just reworded' }),
      }));
      expect(sameSchedule.response.status).toBe(200);
      expect(sameSchedule.body.event.triggeredAt).not.toBeNull();

      const newSchedule = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ scheduledAt: '2000-06-01T00:00:00.000Z' }),
      }));
      expect(newSchedule.response.status).toBe(200);
      expect(newSchedule.body.event.triggeredAt).toBeNull();

      const retriggered = await api(`/instances/${instanceId}/events/${eventId}/trigger`, { method: 'POST' });
      expect(retriggered.body.triggered).toBe(true);
    });

    it('lets the event\'s own author delete it directly, even after the hosting landlet changes hands', async () => {
      const { owner, instanceId, landletId } = await setupCalendar('delete-after-transfer');
      const eventId = await postEvent(instanceId, owner);
      const stranger = await signupBuilder('cal-au-delete-after-transfer-stranger');

      const newOwner = await signupBuilder('cal-au-delete-after-transfer-new-owner');
      await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
        .bind(newOwner.builderId, landletId).run();

      const strangerRejected = await api(`/instances/${instanceId}/events/${eventId}`, stranger.session({ method: 'DELETE' }));
      expect(strangerRejected.response.status).toBe(403);

      const deleted = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);
      expect(deleted.body).toEqual({ deleted: true });

      const listed = await api(`/instances/${instanceId}/events`);
      expect(listed.body.events).toEqual([]);
    });

    // The pre-existing moderation path (requireOwnedLandlet) still works for
    // whoever currently owns the landlet, as a fallback when the original
    // author doesn't remove their own event -- unchanged by #1975.
    it('still lets the landlet\'s current owner moderate-delete an event the original author left behind', async () => {
      const { owner, instanceId, landletId } = await setupCalendar('moderation-fallback');
      const eventId = await postEvent(instanceId, owner);

      const newOwner = await signupBuilder('cal-au-moderation-fallback-new-owner');
      await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
        .bind(newOwner.builderId, landletId).run();

      const deleted = await api(`/instances/${instanceId}/events/${eventId}`, newOwner.session({
        method: 'DELETE', body: JSON.stringify({ category: 'other' }),
      }));
      expect(deleted.response.status).toBe(200);
    });

    // A pre-#1975 event (user_id IS NULL, seeded directly) has nobody on
    // record to own it -- the author-direct branches must never match it,
    // falling straight through to the existing moderation path exactly as
    // before.
    it('never lets a legacy event with no recorded author be claimed as anyone\'s own', async () => {
      const { owner, instanceId } = await setupCalendar('legacy-no-userid');
      const eventId = 'cal-au-legacy-no-userid-event';
      await env.DB.prepare(`
        INSERT INTO calendar_events (event_id, instance_id, author_label, text, user_id) VALUES (?, ?, 'Legacy Author', 'Pre-#1975 event.', NULL)
      `).bind(eventId, instanceId).run();
      const stranger = await signupBuilder('cal-au-legacy-no-userid-stranger');

      const editRejected = await api(`/instances/${instanceId}/events/${eventId}`, stranger.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Claimed!' }),
      }));
      expect(editRejected.response.status).toBe(403);

      const deleteRejectedByStranger = await api(`/instances/${instanceId}/events/${eventId}`, stranger.session({ method: 'DELETE' }));
      expect(deleteRejectedByStranger.response.status).toBe(403);

      const deletedByOwner = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'DELETE', body: JSON.stringify({ category: 'other' }),
      }));
      expect(deletedByOwner.response.status).toBe(200);
    });

    it('rate-limits repeated event edits from the same account', async () => {
      const { owner, instanceId } = await setupCalendar('edit-rate-limit');
      const eventId = await postEvent(instanceId, owner);

      for (let i = 0; i < 20; i++) {
        const attempt = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
          method: 'PATCH', body: JSON.stringify({ text: `Edit number ${i}` }),
        }));
        expect(attempt.response.status).not.toBe(429);
      }
      const limited = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'One too many' }),
      }));
      expect(limited.response.status).toBe(429);
    });

    // #1975: "Maybe we should keep a record of the original content
    // internally in case of disputes" -- every author-initiated edit/
    // delete should snapshot the pre-change row into
    // user_content_edit_history (migrations/0129) first.
    it('snapshots the pre-edit event into user_content_edit_history before applying an author edit', async () => {
      const { owner, instanceId } = await setupCalendar('history-edit');
      const eventId = await postEvent(instanceId, owner, { text: 'Before the edit.' });
      const ownerUserId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?')
        .bind(owner.builderId).first()).user_id;

      const edited = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
        method: 'PATCH', body: JSON.stringify({ text: 'After the edit.' }),
      }));
      expect(edited.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('calendar_events', eventId).all();
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({ action: 'edit', actor_user_id: ownerUserId });
      const snapshot = JSON.parse(history.results[0].snapshot_json);
      expect(snapshot).toMatchObject({ event_id: eventId, text: 'Before the edit.' });
    });

    it('snapshots the pre-delete event into user_content_edit_history before an author delete', async () => {
      const { owner, instanceId } = await setupCalendar('history-delete');
      const eventId = await postEvent(instanceId, owner, { text: 'About to be deleted.' });
      const ownerUserId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?')
        .bind(owner.builderId).first()).user_id;

      const deleted = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({ method: 'DELETE' }));
      expect(deleted.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('calendar_events', eventId).all();
      expect(history.results).toHaveLength(1);
      expect(history.results[0]).toMatchObject({ action: 'delete', actor_user_id: ownerUserId });
      const snapshot = JSON.parse(history.results[0].snapshot_json);
      expect(snapshot).toMatchObject({ event_id: eventId, text: 'About to be deleted.' });
    });

    // #2122: a lost concurrency race (another request deletes the event in
    // the real gap between the eager read and this handler's own
    // UPDATE/DELETE, same injection technique as the ownership-race POST
    // test above) must not leave a false snapshot behind for an edit/
    // delete that never actually took effect -- the request itself still
    // 409s either way.
    it('does not snapshot to user_content_edit_history when an author edit loses a concurrency race', async () => {
      const { owner, instanceId } = await setupCalendar('history-edit-lost-race');
      const eventId = await postEvent(instanceId, owner, { text: 'Before the race.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('UPDATE calendar_events SET text')) {
          armed = false;
          originalPrepare('DELETE FROM calendar_events WHERE event_id = ?').bind(eventId).run();
        }
        return originalPrepare(sql);
      };
      let edited;
      try {
        edited = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({
          method: 'PATCH', body: JSON.stringify({ text: 'After the race.' }),
        }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(edited.response.status).toBe(409);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('calendar_events', eventId).all();
      expect(history.results).toHaveLength(0);
    });

    it('does not snapshot to user_content_edit_history when an author delete loses a concurrency race', async () => {
      const { owner, instanceId } = await setupCalendar('history-delete-lost-race');
      const eventId = await postEvent(instanceId, owner, { text: 'Already gone.' });

      const originalPrepare = env.DB.prepare.bind(env.DB);
      let armed = true;
      env.DB.prepare = (sql) => {
        if (armed && sql.includes('DELETE FROM calendar_events WHERE event_id = ? AND user_id = ?')) {
          armed = false;
          originalPrepare('DELETE FROM calendar_events WHERE event_id = ?').bind(eventId).run();
        }
        return originalPrepare(sql);
      };
      let deleted;
      try {
        deleted = await api(`/instances/${instanceId}/events/${eventId}`, owner.session({ method: 'DELETE' }));
      } finally {
        env.DB.prepare = originalPrepare;
      }
      expect(deleted.response.status).toBe(409);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id = ?',
      ).bind('calendar_events', eventId).all();
      expect(history.results).toHaveLength(0);
    });

    // Moderation (admin override, or the current landlet owner removing an
    // event left behind by a former owner) is not the user editing/deleting
    // their own content -- the owner's own framing was specifically about
    // self-service, so these must not write to the history table.
    //
    // #2388: this is exactly the asymmetry that issue closed -- a
    // moderation delete now writes to moderation_removal_snapshots instead
    // (a separate, admin-only table, never user_content_edit_history), so
    // this test also confirms that write happens, not just that the old
    // table stays untouched.
    it('does not snapshot to user_content_edit_history on an admin or landlet-moderation delete', async () => {
      const { owner, instanceId, landletId } = await setupCalendar('history-moderation');
      const adminEventId = await postEvent(instanceId, owner, { text: 'Admin will remove this.' });
      const adminDeleted = await api(`/instances/${instanceId}/events/${adminEventId}`, adminSession({
        method: 'DELETE', body: JSON.stringify({ category: 'harassment' }),
      }));
      expect(adminDeleted.response.status).toBe(200);

      const moderationEventId = await postEvent(instanceId, owner, { text: 'New owner will remove this.' });
      const newOwner = await signupBuilder('cal-au-history-moderation-new-owner');
      await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
        .bind(newOwner.builderId, landletId).run();
      const moderationDeleted = await api(`/instances/${instanceId}/events/${moderationEventId}`, newOwner.session({
        method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
      }));
      expect(moderationDeleted.response.status).toBe(200);

      const history = await env.DB.prepare(
        'SELECT * FROM user_content_edit_history WHERE source_table = ? AND source_id IN (?, ?)',
      ).bind('calendar_events', adminEventId, moderationEventId).all();
      expect(history.results).toHaveLength(0);

      const snapshots = await env.DB.prepare(
        'SELECT * FROM moderation_removal_snapshots WHERE source_table = ? AND source_id IN (?, ?)',
      ).bind('calendar_events', adminEventId, moderationEventId).all();
      expect(snapshots.results).toHaveLength(2);
    });
  });
});
