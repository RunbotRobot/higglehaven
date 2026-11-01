// #2819 (sub-issue of #2780, itself sub-issue of #2777, proximity voice
// chat): POST /voice/report -- the report half of "per-shopper mute +
// report" (#2778's own resolution). Mute itself is purely local/client-
// side (src/shop/voiceChat.js) and never reaches the backend at all, so
// there's nothing to test here beyond this one endpoint. Mirrors
// voice-signal.test.js's own signupIdVerifiedBuilder helper (the
// id_verified bar this endpoint reuses verbatim).
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

describe('Voice conduct reports (#2819)', () => {
  it('requires a session', async () => {
    const anon = await api('/voice/report', {
      method: 'POST', body: JSON.stringify({ reportedBuilderId: 'x' }),
    });
    expect(anon.response.status).toBe(401);
  });

  it('rejects a reporter who is not id_verified', async () => {
    const alice = await signupBuilder('voice-report-unverified-alice');
    const bob = await signupIdVerifiedBuilder('voice-report-unverified-bob');
    const rejected = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
    }));
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.idVerificationRequired).toBe(true);
    // #2954: requireIdVerifiedSessionBuilder used to hardcode direct
    // messages' own error text for every caller, including this one.
    expect(rejected.body.error).toBe('ID verification is required to use voice chat.');
  });

  it('rejects reporting oneself', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-self-alice');
    const rejected = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: alice.builderId }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a reason over 280 characters', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-longreason-alice');
    const bob = await signupIdVerifiedBuilder('voice-report-longreason-bob');
    const rejected = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId, reason: 'x'.repeat(281) }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('rejects a reportedBuilderId that does not name a real builder', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-norecipient-alice');
    const rejected = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: 'nonexistent-builder' }),
    }));
    expect(rejected.response.status).toBe(400);
  });

  it('creates a report with an optional reason, lands a voice_conduct_reports row and a paired Control Room card in the same write', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-create-alice');
    const bob = await signupIdVerifiedBuilder('voice-report-create-bob');
    const created = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId, reason: 'Said something inappropriate' }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.reportId).toBeTruthy();

    const row = await env.DB.prepare('SELECT * FROM voice_conduct_reports WHERE report_id = ?')
      .bind(created.body.reportId).first();
    expect(row).toMatchObject({
      reporter_builder_id: alice.builderId, reported_builder_id: bob.builderId, reason: 'Said something inappropriate',
    });

    const taskId = `voice-report-${created.body.reportId.slice('voice-report-'.length)}`;
    const task = await env.DB.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
    expect(task).toMatchObject({ kind: 'voice-report', status: 'queued' });
    expect(task.note).toContain(bob.builderId);
    expect(task.note).toContain('Said something inappropriate');
  });

  it('creates a report with no reason', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-noreason-alice');
    const bob = await signupIdVerifiedBuilder('voice-report-noreason-bob');
    const created = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
    }));
    expect(created.response.status).toBe(201);
    const row = await env.DB.prepare('SELECT reason FROM voice_conduct_reports WHERE report_id = ?')
      .bind(created.body.reportId).first();
    expect(row.reason).toBeNull();
  });

  // Same pre-seeded-bucket approach voice-signal.test.js's own rate-limit
  // test uses to stay fast rather than looping real requests.
  it('rate-limits repeated reports from the same builder', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-rate-limit-alice');
    const bob = await signupIdVerifiedBuilder('voice-report-rate-limit-bob');

    const bucketKey = `voice-report-create:${alice.builderId}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 19 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
    }));
    expect(atLimit.response.status).toBe(201);

    const limited = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
    }));
    expect(limited.response.status).toBe(429);
  });
});
