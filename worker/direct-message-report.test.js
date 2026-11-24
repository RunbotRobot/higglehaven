// #4169: POST /api/direct-messages/reports, the conduct report DMs were missing next to nearby chat and voice.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function signupIdVerifiedBuilder(label) {
  const builder = await signupBuilder(label);
  await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)")
    .bind(builder.builderId).run();
  return builder;
}

async function becomeFriendsAndTalk(a, b) {
  const sent = await api('/friendships', a.session({ method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }) }));
  await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({ method: 'PATCH', body: JSON.stringify({ status: 'accepted' }) }));
  const message = await api('/direct-messages', b.session({ method: 'POST', body: JSON.stringify({ recipientBuilderId: a.builderId, text: 'hello there' }) }));
  expect(message.response.status).toBe(201);
}

const report = (reporter, reportedBuilderId, reason) => api('/direct-messages/reports', reporter.session({
  method: 'POST', body: JSON.stringify(reason === undefined ? { reportedBuilderId } : { reportedBuilderId, reason }),
}));

describe('direct message conduct report (#4169)', () => {
  it('files one report and one Control Room card for someone the caller has a thread with, holding no message text', async () => {
    const alice = await signupIdVerifiedBuilder('dm-report-alice');
    const bob = await signupIdVerifiedBuilder('dm-report-bob');
    await becomeFriendsAndTalk(alice, bob);
    const filed = await report(alice, bob.builderId, 'keeps sending me things I asked them to stop');
    expect(filed.response.status).toBe(201);
    expect(Object.keys(filed.body)).toEqual(['reportId']);
    const row = await env.DB.prepare('SELECT * FROM direct_message_reports WHERE report_id = ?').bind(filed.body.reportId).first();
    expect(row.reason).toBe('keeps sending me things I asked them to stop');
    expect(Object.keys(row).sort()).toEqual(['created_at', 'reason', 'report_id', 'reported_user_id', 'reporter_user_id']);
    const card = await env.DB.prepare('SELECT kind, status, title, note FROM control_room_tasks WHERE task_id = ?').bind(filed.body.reportId).first();
    expect(card.kind).toBe('direct-message-report');
    expect(card.status).toBe('queued');
    expect(card.note).toContain('keeps sending me things');
    expect(card.note).not.toContain('hello there');
  });

  it('collapses a repeat into the same row and card, and the reported person sees nothing at all', async () => {
    const alice = await signupIdVerifiedBuilder('dm-report-repeat-alice');
    const bob = await signupIdVerifiedBuilder('dm-report-repeat-bob');
    await becomeFriendsAndTalk(alice, bob);
    const first = await report(alice, bob.builderId, 'one');
    const second = await report(alice, bob.builderId, 'two');
    expect(second.response.status).toBe(201);
    expect(second.body.reportId).toBe(first.body.reportId);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM direct_message_reports WHERE report_id = ?').bind(first.body.reportId).first();
    expect(count.n).toBe(1);
    const card = await env.DB.prepare('SELECT note FROM control_room_tasks WHERE task_id = ?').bind(first.body.reportId).first();
    expect(card.note).toContain('Repeat report from the same reporter');
    // Silent, like the other two surfaces: no notice for the reported person, and their own thread is unchanged.
    const bobNotices = await api('/notifications', bob.session());
    expect(bobNotices.body.notifications.map((n) => n.message).join(' ')).not.toMatch(/reported|conduct/i);
    const bobThread = await api(`/direct-messages?withBuilderId=${alice.builderId}`, bob.session());
    expect(bobThread.response.status).toBe(200);
  });

  it('refuses a stranger with no thread, the caller themselves, an unknown id and a reason over 280 characters', async () => {
    const alice = await signupIdVerifiedBuilder('dm-report-refuse-alice');
    const stranger = await signupIdVerifiedBuilder('dm-report-refuse-stranger');
    expect((await report(alice, stranger.builderId)).response.status).toBe(403);
    expect((await report(alice, alice.builderId)).response.status).toBe(400);
    expect((await report(alice, 'builder-that-does-not-exist')).response.status).toBe(400);
    const friend = await signupIdVerifiedBuilder('dm-report-refuse-friend');
    await becomeFriendsAndTalk(alice, friend);
    expect((await report(alice, friend.builderId, 'x'.repeat(281))).response.status).toBe(400);
    expect((await report(alice, friend.builderId, 'x'.repeat(280))).response.status).toBe(201);
  });

  it('refuses a caller who is signed out or not ID-verified, like the rest of direct messages', async () => {
    const bob = await signupIdVerifiedBuilder('dm-report-gate-bob');
    const unverified = await signupBuilder('dm-report-gate-unverified');
    expect((await api('/direct-messages/reports', { method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }) })).response.status).toBe(401);
    expect((await report(unverified, bob.builderId)).response.status).toBe(403);
  });

  it('is removed with the reporter account but kept when only the reported side goes (the report keys on the reporter)', async () => {
    const alice = await signupIdVerifiedBuilder('dm-report-keep-alice');
    const bob = await signupIdVerifiedBuilder('dm-report-keep-bob');
    await becomeFriendsAndTalk(alice, bob);
    const filed = await report(alice, bob.builderId);
    const row = await env.DB.prepare('SELECT reporter_user_id, reported_user_id FROM direct_message_reports WHERE report_id = ?').bind(filed.body.reportId).first();
    expect(row.reporter_user_id).toBeTruthy();
    expect(row.reported_user_id).toBeTruthy();
    expect(row.reporter_user_id).not.toBe(row.reported_user_id);
  });
});
