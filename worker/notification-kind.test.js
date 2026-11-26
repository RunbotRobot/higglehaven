// #4498: a notification carries a `kind` saying where a tap on it goes; notices with nothing to open carry none.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { fireNotification, fireNotifications } from './lib/notifications.js';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('notification kind (#4498)', () => {
  it('stores and returns a kind, and null when none is given', async () => {
    const builder = await signupBuilder('notification-kind-builder');
    await fireNotification(env.DB, builder.builderId, 'Someone sent you a message.', null, 'messages');
    await fireNotification(env.DB, builder.builderId, 'A plain notice.');
    await fireNotifications(env.DB, [{ builderId: builder.builderId, message: 'Batch with a kind.', kind: 'friends' }, { builderId: builder.builderId, message: 'Batch without.' }]);
    const listed = await api('/notifications', builder.session());
    expect(listed.response.status).toBe(200);
    const byMessage = Object.fromEntries(listed.body.notifications.map((n) => [n.message, n.kind]));
    expect(byMessage).toEqual({
      'Someone sent you a message.': 'messages',
      'A plain notice.': null,
      'Batch with a kind.': 'friends',
      'Batch without.': null,
    });
  });

  it('a friend request notifies the recipient with kind friends', async () => {
    const alice = await signupBuilder('notification-kind-alice');
    const bob = await signupBuilder('notification-kind-bob');
    const requested = await api('/friendships', alice.session({ method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId }) }));
    expect([200, 201]).toContain(requested.response.status);
    const listed = await api('/notifications', bob.session());
    const notice = listed.body.notifications.find((n) => /friend request/.test(n.message));
    expect(notice?.kind).toBe('friends');
  });
});
