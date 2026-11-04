import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

// A suspended admin keeps is_admin = 1 and a valid session (see
// requireCurrentUser's comment in worker/lib/auth.js); only code that goes
// through requireCurrentUser notices. These endpoints take the admin
// "override" branch from the non-throwing currentUser() instead.
let adminSession;
let suspendedAdmin;
let builder;
let shopper;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('susp-override-active-admin')).session;
  suspendedAdmin = await signupAdmin('susp-override-suspended-admin');
  builder = await signupBuilder('susp-override-builder');
  shopper = await signupBuilder('susp-override-shopper');
  const landletId = 'susp-override-landlet';
  await api('/landlets', adminSession({
    method: 'POST', body: JSON.stringify({ landletId, name: 'Override', areaM2: 1000, status: 'greenbelt' }),
  }));
  await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({
      instanceId: 'susp-override-sign', landletId, templateId: 'placeholder-tree', x: 1, y: 1, isCommunitySign: true,
    }),
  }));
  await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({
      instanceId: 'susp-override-calendar', landletId, templateId: 'placeholder-tree', x: 3, y: 3, isCommunityCalendar: true,
    }),
  }));
  const suspended = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email: suspendedAdmin.email, reason: 'test suspension' }),
  }));
  expect(suspended.response.status).toBe(200);
});

describe('A suspended admin loses the admin moderation-delete overrides', () => {
  it('cannot delete another user\'s sign post', async () => {
    const posted = await api('/instances/susp-override-sign/posts', shopper.session({
      method: 'POST', body: JSON.stringify({ text: 'A post a suspended admin must not be able to remove.' }),
    }));
    expect(posted.response.status).toBe(201);
    const postId = posted.body.post.postId;

    const attempt = await api(`/instances/susp-override-sign/posts/${postId}`, suspendedAdmin.session({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(attempt.response.status).toBeGreaterThanOrEqual(400);
    const stillThere = await env.DB.prepare('SELECT 1 FROM sign_posts WHERE post_id = ?').bind(postId).first();
    expect(stillThere).toBeTruthy();

    // An active admin still can.
    const byActiveAdmin = await api(`/instances/susp-override-sign/posts/${postId}`, adminSession({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(byActiveAdmin.response.status).toBe(200);
  });

  it('cannot delete another user\'s calendar event', async () => {
    const posted = await api('/instances/susp-override-calendar/events', builder.session({
      method: 'POST', body: JSON.stringify({ text: 'An event a suspended admin must not be able to remove.' }),
    }));
    expect(posted.response.status).toBe(201);
    const eventId = posted.body.event.eventId;

    const attempt = await api(`/instances/susp-override-calendar/events/${eventId}`, suspendedAdmin.session({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(attempt.response.status).toBeGreaterThanOrEqual(400);
    const stillThere = await env.DB.prepare('SELECT 1 FROM calendar_events WHERE event_id = ?').bind(eventId).first();
    expect(stillThere).toBeTruthy();

    const byActiveAdmin = await api(`/instances/susp-override-calendar/events/${eventId}`, adminSession({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(byActiveAdmin.response.status).toBe(200);
  });
});
