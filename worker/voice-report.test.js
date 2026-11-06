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
    const userIdOf = async (person) => (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(person.builderId).first()).user_id;
    expect(row).toMatchObject({
      reporter_user_id: await userIdOf(alice), reported_user_id: await userIdOf(bob),
      reporter_builder_id: alice.builderId, reported_builder_id: bob.builderId, reason: 'Said something inappropriate',
    });

    const taskId = `voice-report-${created.body.reportId.slice('voice-report-'.length)}`;
    const task = await env.DB.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
    expect(task).toMatchObject({ kind: 'voice-report', status: 'queued' });
    expect(task.note).toContain(bob.builderId);
    expect(task.note).toContain('Said something inappropriate');
  });

  // #2953: interaction evidence is an admin-side triage annotation only --
  // never a gate on filing (a probabilistic signal must not change what a
  // legitimate reporter can do) and never echoed back to the reporter.
  describe('interaction evidence annotation (#2953)', () => {
    async function noteFor(reportId) {
      const taskId = `voice-report-${reportId.slice('voice-report-'.length)}`;
      return (await env.DB.prepare('SELECT note FROM control_room_tasks WHERE task_id = ?').bind(taskId).first()).note;
    }

    it('still files a report from someone with no recorded interaction, and says so on the card', async () => {
      const alice = await signupIdVerifiedBuilder('voice-report-evidence-none-alice');
      const bob = await signupIdVerifiedBuilder('voice-report-evidence-none-bob');
      const created = await api('/voice/report', alice.session({
        method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
      }));
      expect(created.response.status).toBe(201);
      const note = await noteFor(created.body.reportId);
      expect(note).toContain('Shared voice signaling still on record: no');
      expect(note).toContain('Both in the same landlet right now: no');
      expect(note).toContain('"no" is weak evidence');
      // Invisible to the reporter: the response carries nothing but the id.
      expect(Object.keys(created.body)).toEqual(['reportId']);
    });

    it('records shared signaling and co-presence when both exist', async () => {
      const alice = await signupIdVerifiedBuilder('voice-report-evidence-yes-alice');
      const bob = await signupIdVerifiedBuilder('voice-report-evidence-yes-bob');
      await env.DB.prepare(`
        INSERT INTO voice_signaling_messages (message_id, from_user_id, to_user_id, landlet_id, kind, payload)
        VALUES (?, (SELECT user_id FROM builders WHERE builder_id = ?), (SELECT user_id FROM builders WHERE builder_id = ?), 'landlet-evidence', 'offer', '{}')
      `).bind(`voice-signal-${crypto.randomUUID()}`, bob.builderId, alice.builderId).run();
      const now = new Date().toISOString();
      for (const builder of [alice, bob]) {
        await env.DB.prepare(`
          INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
          VALUES ((SELECT user_id FROM builders WHERE builder_id = ?), 'landlet-evidence', 0, 0, 0, 0, 0, ?)
        `).bind(builder.builderId, now).run();
      }
      const created = await api('/voice/report', alice.session({
        method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
      }));
      expect(created.response.status).toBe(201);
      const note = await noteFor(created.body.reportId);
      expect(note).toContain('Shared voice signaling still on record: yes');
      expect(note).toContain('Both in the same landlet right now: yes');
    });

    it('does not count stale presence as co-presence', async () => {
      const alice = await signupIdVerifiedBuilder('voice-report-evidence-stale-alice');
      const bob = await signupIdVerifiedBuilder('voice-report-evidence-stale-bob');
      const longAgo = new Date(Date.now() - 60_000).toISOString();
      for (const builder of [alice, bob]) {
        await env.DB.prepare(`
          INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
          VALUES ((SELECT user_id FROM builders WHERE builder_id = ?), 'landlet-evidence-stale', 0, 0, 0, 0, 0, ?)
        `).bind(builder.builderId, longAgo).run();
      }
      const created = await api('/voice/report', alice.session({
        method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId }),
      }));
      expect(created.response.status).toBe(201);
      expect(await noteFor(created.body.reportId)).toContain('Both in the same landlet right now: no');
    });
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

  // #3121: the reported party can reset their own builder profile
  // (DELETE /api/builders/:id), which used to cascade away every report
  // against them and leave the card pointing at a builder id that no longer
  // resolves. The report now survives, attributable to the user account.
  it('keeps a voice conduct report, attributable to the reported account, after the reported builder resets their profile (#3121)', async () => {
    const alice = await signupIdVerifiedBuilder('voice-report-reset-alice');
    const bob = await signupIdVerifiedBuilder('voice-report-reset-bob');
    const bobUserId = (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(bob.builderId).first()).user_id;
    const created = await api('/voice/report', alice.session({
      method: 'POST', body: JSON.stringify({ reportedBuilderId: bob.builderId, reason: 'Abusive' }),
    }));
    expect(created.response.status).toBe(201);

    const deleted = await api(`/builders/${bob.builderId}`, bob.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM voice_conduct_reports WHERE report_id = ?')
      .bind(created.body.reportId).first();
    expect(row).toMatchObject({ reported_builder_id: null, reported_user_id: bobUserId, reason: 'Abusive' });

    const taskId = `voice-report-${created.body.reportId.slice('voice-report-'.length)}`;
    const task = await env.DB.prepare('SELECT note FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
    expect(task.note).toContain(`Reported account: ${bobUserId}`);
  });
});
