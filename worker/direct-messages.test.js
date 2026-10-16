// #1637 (resolves #1002): direct messages between two id_verified builders
// who are already friends — see migrations/0120_direct_messages.sql and
// handleDirectMessages in worker/index.js. Mirrors the Friendships describe
// block in worker/profiles.test.js for the request/accept setup, and the
// GET/unread-count/mark-read shape worker/index.js's own notifications
// handler already establishes.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// signupBuilder's own signup() stamps trust_tier = 'credit_card' directly
// (Stripe/Didit are never configured in this suite — see signup's own
// comment) — DMs need the stronger 'id_verified' bar specifically, so this
// bumps a step further the same direct-DB-stamp way.
async function signupIdVerifiedBuilder(label) {
  const builder = await signupBuilder(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)")
    .bind(builder.builderId).run();
  return builder;
}

async function becomeFriends(a, b) {
  const sent = await api('/friendships', a.session({
    method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
  }));
  await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
    method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
  }));
}

describe('Direct messages (#1637)', () => {
  it('rejects a send from a builder who is not id_verified', async () => {
    const alice = await signupBuilder('dm-unverified-alice'); // only credit_card
    const bob = await signupIdVerifiedBuilder('dm-unverified-bob');
    await becomeFriends(alice, bob);

    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'hi' }),
    }));
    expect(rejected.response.status).toBe(403);
  });

  it('rejects a send to a recipient who is not id_verified', async () => {
    const alice = await signupIdVerifiedBuilder('dm-recipient-unverified-alice');
    const bob = await signupBuilder('dm-recipient-unverified-bob'); // only credit_card
    await becomeFriends(alice, bob);

    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'hi' }),
    }));
    expect(rejected.response.status).toBe(403);
  });

  it('rejects a send between two id_verified builders who are not friends', async () => {
    const alice = await signupIdVerifiedBuilder('dm-strangers-alice');
    const bob = await signupIdVerifiedBuilder('dm-strangers-bob');

    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'hi' }),
    }));
    expect(rejected.response.status).toBe(403);
  });

  it('rejects sending to yourself', async () => {
    const alice = await signupIdVerifiedBuilder('dm-self-alice');
    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: alice.builderId, text: 'hi' }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a recipientBuilderId that does not exist', async () => {
    const alice = await signupIdVerifiedBuilder('dm-missing-recipient-alice');
    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: 'builder-does-not-exist', text: 'hi' }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects text over 280 characters', async () => {
    const alice = await signupIdVerifiedBuilder('dm-toolong-alice');
    const bob = await signupIdVerifiedBuilder('dm-toolong-bob');
    await becomeFriends(alice, bob);

    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'x'.repeat(281) }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('sends, fires a notification, appears on both sides, and mark-read clears the unread count', async () => {
    const alice = await signupIdVerifiedBuilder('dm-flow-alice');
    const bob = await signupIdVerifiedBuilder('dm-flow-bob');
    await becomeFriends(alice, bob);

    const sent = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'Hey Bob!' }),
    }));
    expect(sent.response.status).toBe(201);
    expect(sent.body.message).toMatchObject({
      senderBuilderId: alice.builderId,
      recipientBuilderId: bob.builderId,
      text: 'Hey Bob!',
      readAt: null,
    });

    // Found via backlog audit on the friend-request equivalent (#319) — a
    // new message needs the same passive way to reach the recipient.
    const bobNotices = await api('/notifications', bob.session());
    expect(bobNotices.body.notifications.some(
      (n) => n.message === 'dm-flow-alice sent you a message.')).toBe(true);

    // Visible to both sides of the pair, same message either way it's
    // fetched.
    const aliceThread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(aliceThread.body.messages).toHaveLength(1);
    const bobThread = await api(`/direct-messages?withBuilderId=${alice.builderId}`, bob.session());
    expect(bobThread.body.messages).toHaveLength(1);
    expect(bobThread.body.messages[0].text).toBe('Hey Bob!');

    const bobUnreadBefore = await api('/direct-messages/unread-count', bob.session());
    expect(bobUnreadBefore.body.count).toBe(1);
    // Alice (the sender) has nothing unread of her own.
    const aliceUnread = await api('/direct-messages/unread-count', alice.session());
    expect(aliceUnread.body.count).toBe(0);

    const markRead = await api('/direct-messages/mark-read', bob.session({
      method: 'POST', body: JSON.stringify({ withBuilderId: alice.builderId }),
    }));
    expect(markRead.response.status).toBe(200);

    const bobUnreadAfter = await api('/direct-messages/unread-count', bob.session());
    expect(bobUnreadAfter.body.count).toBe(0);

    const bobThreadAfter = await api(`/direct-messages?withBuilderId=${alice.builderId}`, bob.session());
    expect(bobThreadAfter.body.messages[0].readAt).not.toBeNull();
  });

  it('still shows message history after the friendship ends, but no longer allows a new send', async () => {
    const alice = await signupIdVerifiedBuilder('dm-unfriend-alice');
    const bob = await signupIdVerifiedBuilder('dm-unfriend-bob');
    await becomeFriends(alice, bob);

    const sent = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'before unfriending' }),
    }));
    expect(sent.response.status).toBe(201);

    const friendships = await api('/friendships', alice.session());
    const friendshipId = friendships.body.friendships[0].friendshipId;
    const unfriended = await api(`/friendships/${friendshipId}`, alice.session({ method: 'DELETE' }));
    expect(unfriended.response.status).toBe(200);

    // History survives — same reasoning email/chat history survives an
    // unfriend, per handleDirectMessages' own GET comment.
    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.body.messages).toHaveLength(1);

    // But a new send is gated on a currently-accepted friendship.
    const rejected = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'after unfriending' }),
    }));
    expect(rejected.response.status).toBe(403);
  });

  // #1802: assertAcceptedFriendship's own point-in-time check and the
  // later INSERT are two separate round trips -- a concurrent unfriend
  // landing in that gap used to still let the message through. Same
  // db.prepare monkey-patch race-injection idiom worker/stripe-connect.test.js
  // uses, injecting the unfriend right as the real request's own INSERT is
  // about to run (after the eager check has already passed).
  it('rejects a send when the recipient unfriends the sender in the gap between the eager check and the write', async () => {
    const alice = await signupIdVerifiedBuilder('dm-race-alice');
    const bob = await signupIdVerifiedBuilder('dm-race-bob');
    await becomeFriends(alice, bob);
    const friendships = await api('/friendships', alice.session());
    const friendshipId = friendships.body.friendships[0].friendshipId;

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO direct_messages')) {
        armed = false;
        originalPrepare('DELETE FROM friendships WHERE friendship_id = ?').bind(friendshipId).run();
      }
      return originalPrepare(sql);
    };
    let result;
    try {
      result = await api('/direct-messages', alice.session({
        method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'raced message' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(result.response.status).toBe(403);

    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.body.messages).toHaveLength(0);
  });

  // #1690: sender_builder_id/recipient_builder_id used to be a real FK with
  // ON DELETE CASCADE (migrations/0120) -- DELETE /api/builders/:id
  // ("Reset your builder profile", an ordinary self-service action, not
  // full account deletion) destroyed every direct_messages row either
  // party appeared in, including the surviving party's own copy of
  // messages that had nothing to do with the deleting party's action.
  // migrations/0122 drops the FK entirely (same shape purchases.seller_id
  // already uses) so this now survives, exactly like the unfriend case
  // just above.
  it('still shows message history on the surviving party\'s side after the other builder resets their profile', async () => {
    const alice = await signupIdVerifiedBuilder('dm-selfdelete-alice');
    const bob = await signupIdVerifiedBuilder('dm-selfdelete-bob');
    await becomeFriends(alice, bob);

    const aliceToBob = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'from alice' }),
    }));
    expect(aliceToBob.response.status).toBe(201);
    const bobToAlice = await api('/direct-messages', bob.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: alice.builderId, text: 'from bob' }),
    }));
    expect(bobToAlice.response.status).toBe(201);

    const deleted = await api(`/builders/${bob.builderId}`, bob.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    // Alice never acted -- her side of the thread (both messages she sent
    // and received) must still be there, keyed by the same withBuilderId
    // as before deletion.
    const aliceThread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(aliceThread.body.messages).toHaveLength(2);
    expect(aliceThread.body.messages.map((m) => m.text).sort()).toEqual(['from alice', 'from bob']);
  });

  // #1719: the frontend (sendDirectMessage in src/api.js) sends a stable
  // idempotencyKey it keeps reusing until a send actually succeeds --
  // exactly the "network blip, then a retry with the same key" scenario
  // writePurchaseRow's own idempotency check (#473) already handles for
  // purchases.
  it('does not deliver the same text twice when the same idempotencyKey is retried', async () => {
    const alice = await signupIdVerifiedBuilder('dm-idempotency-alice');
    const bob = await signupIdVerifiedBuilder('dm-idempotency-bob');
    await becomeFriends(alice, bob);

    const first = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'hello', idempotencyKey: 'retry-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'hello', idempotencyKey: 'retry-test-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.message.messageId).toBe(first.body.message.messageId);

    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.body.messages).toHaveLength(1);
    const bobUnread = await api('/direct-messages/unread-count', bob.session());
    expect(bobUnread.body.count).toBe(1); // the retry's own notification must not have fired a second time

    // A different idempotencyKey (or none at all) is a genuinely separate
    // message, still delivered normally — this isn't a dedup-everything
    // guard, only same-key retries.
    const separate = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'a second message' }),
    }));
    expect(separate.response.status).toBe(201);
    expect(separate.body.message.messageId).not.toBe(first.body.message.messageId);
    const threadAfter = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(threadAfter.body.messages).toHaveLength(2);
  });

  // #974 (the purchase-flow equivalent) already fixed this same class of
  // bug for a stale localStorage-cached key reused by a second account on
  // the same browser -- directMessageIdempotencyKey folds in both builder
  // ids for the same reason purchaseIdempotencyKey does.
  it('does not let two different senders collide on the same client-supplied idempotencyKey', async () => {
    const alice = await signupIdVerifiedBuilder('dm-idempotency-cross-sender-alice');
    const bob = await signupIdVerifiedBuilder('dm-idempotency-cross-sender-bob');
    const carol = await signupIdVerifiedBuilder('dm-idempotency-cross-sender-carol');
    await becomeFriends(alice, bob);
    await becomeFriends(carol, bob);

    const sharedKey = 'shared-stale-key';
    const fromAlice = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'from alice', idempotencyKey: sharedKey }),
    }));
    expect(fromAlice.response.status).toBe(201);

    const fromCarol = await api('/direct-messages', carol.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'from carol', idempotencyKey: sharedKey }),
    }));
    expect(fromCarol.response.status).toBe(201);
    expect(fromCarol.body.message.messageId).not.toBe(fromAlice.body.message.messageId);
    expect(fromCarol.body.message.text).toBe('from carol');

    const bobUnread = await api('/direct-messages/unread-count', bob.session());
    expect(bobUnread.body.count).toBe(2);
  });

  // #1750: directMessageIdempotencyKey is only cleared client-side on a
  // successful send (src/main.js's compose handler) -- a dropped response
  // after the first message already landed, followed by a genuinely
  // different second message to the same recipient within the TTL, reuses
  // the same stale key. That must still deliver the second message rather
  // than silently returning the first one's row as if it were a legitimate
  // retry hit.
  it('does deliver a second, different message even when it reuses the same idempotencyKey as an earlier one', async () => {
    const alice = await signupIdVerifiedBuilder('dm-idempotency-stale-key-alice');
    const bob = await signupIdVerifiedBuilder('dm-idempotency-stale-key-bob');
    await becomeFriends(alice, bob);

    const staleKey = 'stale-key-reused-for-different-text';
    const first = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'message A', idempotencyKey: staleKey }),
    }));
    expect(first.response.status).toBe(201);

    const second = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'message B', idempotencyKey: staleKey }),
    }));
    expect(second.response.status).toBe(201);
    expect(second.body.message.text).toBe('message B');
    expect(second.body.message.messageId).not.toBe(first.body.message.messageId);

    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.body.messages).toHaveLength(2);
    expect(thread.body.messages.map((m) => m.text).sort()).toEqual(['message A', 'message B']);
    const bobUnread = await api('/direct-messages/unread-count', bob.session());
    expect(bobUnread.body.count).toBe(2); // both messages notified -- the second was never treated as a dedup hit
  });

  // #2260: mark-read is auto-fired by the client on every render of an open
  // DM thread (on open, and again after every send) -- not just on a
  // deliberate click the way notification mark-read's own 20/15min limit
  // is. Exercises comfortably past the old 20-call ceiling to confirm the
  // bucket was actually raised, not just renamed.
  it('does not rate-limit mark-read under ordinary repeated-render chat usage', async () => {
    const alice = await signupIdVerifiedBuilder('dm-mark-read-rate-limit-alice');
    const bob = await signupIdVerifiedBuilder('dm-mark-read-rate-limit-bob');
    await becomeFriends(alice, bob);

    for (let i = 0; i < 100; i++) {
      const attempt = await api('/direct-messages/mark-read', bob.session({
        method: 'POST', body: JSON.stringify({ withBuilderId: alice.builderId }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
  });

  // #2326: GET /direct-messages is documented and implemented as cursor-
  // paginated the same way as GET /friendships (worker/profiles.test.js's
  // own "paginates GET /friendships with a descending cursor" test below),
  // but had no equivalent test exercising the real cursor/index path --
  // e2e/dm-load-more.test.mjs mocks the backend entirely, well under
  // either rate limit (20/15min) like the friendships test does.
  it('paginates GET /direct-messages with a descending cursor', async () => {
    const alice = await signupIdVerifiedBuilder('dm-page-alice');
    const bob = await signupIdVerifiedBuilder('dm-page-bob');
    await becomeFriends(alice, bob);

    for (const text of ['page message 1', 'page message 2', 'page message 3']) {
      await api('/direct-messages', alice.session({
        method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text }),
      }));
    }

    const whole = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(whole.body.nextCursor).toBeNull();
    expect(whole.body.messages).toHaveLength(3);

    const paged = [];
    let cursor;
    for (;;) {
      const query = new URLSearchParams({ withBuilderId: bob.builderId, limit: '1' });
      if (cursor) query.set('cursor', cursor);
      const page = await api(`/direct-messages?${query}`, alice.session());
      expect(page.response.status).toBe(200);
      expect(page.body.messages.length).toBeLessThanOrEqual(1);
      paged.push(...page.body.messages);
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    expect(paged.map((m) => m.messageId)).toEqual(whole.body.messages.map((m) => m.messageId));
  });

  // #2326: same "schema-only change, check the index exists" shape as
  // worker/profiles.test.js's own friendships index test -- confirms the
  // composite sort-covering indexes from migrations/0120_direct_messages.sql
  // actually exist, since direct_messages' GET query is this table's own
  // `(sender_builder_id = ? AND recipient_builder_id = ?) OR (...)
  // ... ORDER BY created_at DESC, message_id DESC` just like friendships'.
  it('indexes direct_messages on each side of the sender/recipient OR, covering the sort', async () => {
    const indexes = (await env.DB.prepare('PRAGMA index_list(direct_messages)').all()).results;
    expect(indexes.some((idx) => idx.name === 'idx_direct_messages_sender')).toBe(true);
    expect(indexes.some((idx) => idx.name === 'idx_direct_messages_recipient')).toBe(true);
  });
});
