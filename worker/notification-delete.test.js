// #3280: a user can delete one of their own notifications (the row is removed,
// not flagged). Owner-only, and a second delete is a plain 404.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { fireNotification } from './lib/notifications.js';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function notificationIdsFor(builder) {
  const { body } = await api('/notifications', builder.session());
  return body.notifications.map((n) => n.notificationId);
}

describe('DELETE /api/notifications/:id (#3280)', () => {
  it('removes the caller\'s own notification, leaves their others, and the unread count follows', async () => {
    const alice = await signupBuilder('notif-delete-alice');
    await fireNotification(env.DB, alice.builderId, 'first notice');
    await fireNotification(env.DB, alice.builderId, 'second notice');
    const before = await notificationIdsFor(alice);
    expect(before).toHaveLength(2);

    const { response, body } = await api(`/notifications/${before[0]}`, alice.session({ method: 'DELETE' }));
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });

    const after = await notificationIdsFor(alice);
    expect(after).toEqual([before[1]]);
    const count = await api('/notifications/unread-count', alice.session());
    expect(count.body.count).toBe(1);

    const row = await env.DB.prepare('SELECT 1 AS present FROM notifications WHERE notification_id = ?').bind(before[0]).first();
    expect(row).toBeNull();
  });

  it('refuses to delete someone else\'s notification, and leaves it in place', async () => {
    const alice = await signupBuilder('notif-delete-owner');
    const mallory = await signupBuilder('notif-delete-other');
    await fireNotification(env.DB, alice.builderId, 'private notice');
    const [id] = await notificationIdsFor(alice);

    const { response } = await api(`/notifications/${id}`, mallory.session({ method: 'DELETE' }));
    expect(response.status).toBe(403);
    expect(await notificationIdsFor(alice)).toEqual([id]);
  });

  it('answers 404 for a notification that is already gone, and needs a session', async () => {
    const alice = await signupBuilder('notif-delete-twice');
    await fireNotification(env.DB, alice.builderId, 'one notice');
    const [id] = await notificationIdsFor(alice);
    expect((await api(`/notifications/${id}`, alice.session({ method: 'DELETE' }))).response.status).toBe(200);
    expect((await api(`/notifications/${id}`, alice.session({ method: 'DELETE' }))).response.status).toBe(404);
    expect((await api('/notifications/not-a-real-id', { method: 'DELETE' })).response.status).toBe(404);
  });
});
