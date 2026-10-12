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

  // #1747: unlike every other idempotency key in this file, this one wraps
  // a freely-editable text field -- dmComposeInput's text is deliberately
  // left in place on error, so a user can edit it before retrying within
  // the key's TTL. The dedup check must compare text, not just the key,
  // or an edited resend would silently deliver the stale original instead.
  it('delivers an edited retry as a new message instead of the stale cached text', async () => {
    const alice = await signupIdVerifiedBuilder('dm-idempotency-edited-alice');
    const bob = await signupIdVerifiedBuilder('dm-idempotency-edited-bob');
    await becomeFriends(alice, bob);

    const first = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'call me at 555-1234', idempotencyKey: 'edited-retry-key' }),
    }));
    expect(first.response.status).toBe(201);

    const edited = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'ignore that, call 555-9999', idempotencyKey: 'edited-retry-key' }),
    }));
    expect(edited.response.status).toBe(201);
    expect(edited.body.message.messageId).not.toBe(first.body.message.messageId);
    expect(edited.body.message.text).toBe('ignore that, call 555-9999');

    const thread = await api(`/direct-messages?withBuilderId=${bob.builderId}`, alice.session());
    expect(thread.body.messages).toHaveLength(2);
    expect(thread.body.messages.map((m) => m.text).sort()).toEqual(['call me at 555-1234', 'ignore that, call 555-9999']);

    // The original text's own idempotency key is still honored for its
    // own, unedited retry.
    const unedited = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'call me at 555-1234', idempotencyKey: 'edited-retry-key' }),
    }));
    expect(unedited.response.status).toBe(200);
    expect(unedited.body.message.messageId).toBe(first.body.message.messageId);
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
});
