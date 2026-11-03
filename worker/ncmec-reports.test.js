// #3040 (sub-issue 1/3 of #3031): the admin-initiated, insert-only NCMEC
// report record (worker/lib/ncmec-reports.js, migrations/0176). Legal-
// reporting code, so the emphasis is on what it must never do: mutate or
// drop a row, fire for a non-admin or suspended admin, report something
// that was never a confirmed decision, double-report one decision, or
// leak anything to the reported account.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, signupBuilder, signupAdmin, withSession, extractSessionCookie, signup,
} from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Each test gets its own admin: every POST (even a 400) counts against the
// per-admin rate limit, so sharing one would make the file order-dependent.
async function newAdmin(label) {
  return signupAdmin(label);
}

async function userIdOf(account) {
  const me = await api('/auth/me', account.session());
  return me.body.user.userId;
}

// A real, confirmed account_suspension decision made through the real
// admin endpoint, returning the ids the report references.
async function makeSuspension(admin, label) {
  const target = await signupBuilder(label);
  const suspended = await api('/auth/suspend-account', admin.session({
    method: 'POST',
    body: JSON.stringify({ email: target.email, reason: 'test suspension for NCMEC report' }),
  }));
  expect(suspended.response.status).toBe(200);
  return {
    target,
    suspensionId: suspended.body.suspension.suspensionId,
    userId: suspended.body.suspension.userId,
  };
}

// A confirmed content_removal decision. The removal endpoints themselves
// are covered by the land-community-* and reviews tests; here the snapshot
// row they write is inserted directly, since it is the only thing the
// report endpoint reads.
async function makeRemovalSnapshot(sourceTable, sourceId, category = 'sexual_content') {
  const snapshotId = `modsnap-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO moderation_removal_snapshots
      (snapshot_id, source_table, source_id, removed_category, snapshot_json, removed_by_user_id)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `).bind(snapshotId, sourceTable, sourceId, category).run();
  return snapshotId;
}

function post(admin, body) {
  return api('/ncmec-reports', admin.session({ method: 'POST', body: JSON.stringify(body) }));
}

describe('POST /ncmec-reports access (#3040)', () => {
  it('requires a session', async () => {
    const anon = await api('/ncmec-reports', {
      method: 'POST',
      body: JSON.stringify({ decisionType: 'account_suspension', suspensionId: 'x' }),
    });
    expect(anon.response.status).toBe(401);
  });

  it('requires admin -- a real but non-admin session is forbidden', async () => {
    const builder = await signupBuilder('ncmec-non-admin');
    const attempt = await post(builder, { decisionType: 'account_suspension', suspensionId: 'x' });
    expect(attempt.response.status).toBe(403);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ncmec_reports WHERE decision_id = ?')
      .bind('x').first();
    expect(count.n).toBe(0);
  });

  it('refuses a suspended admin even with a valid decision', async () => {
    const operational = await newAdmin('ncmec-operational-admin');
    const doomed = await newAdmin('ncmec-doomed-admin');
    const decision = await makeSuspension(operational, 'ncmec-suspended-admin-target');
    const suspendAdmin = await api('/auth/suspend-account', operational.session({
      method: 'POST',
      body: JSON.stringify({ email: doomed.email, reason: 'suspending an admin for the test' }),
    }));
    expect(suspendAdmin.response.status).toBe(200);
    const attempt = await post(doomed, {
      decisionType: 'account_suspension', suspensionId: decision.suspensionId,
    });
    expect(attempt.response.status).toBe(403);
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM ncmec_reports WHERE decision_id = ?',
    ).bind(decision.suspensionId).first();
    expect(rows.n).toBe(0);
  });

  it('rate-limits one admin and lets a different admin through', async () => {
    const limited = await newAdmin('ncmec-rate-limited-admin');
    for (let i = 0; i < 20; i += 1) {
      const bad = await post(limited, { decisionType: 'nonsense' });
      expect(bad.response.status).toBe(400);
    }
    const over = await post(limited, { decisionType: 'nonsense' });
    expect(over.response.status).toBe(429);
    const other = await newAdmin('ncmec-rate-limit-other-admin');
    const fine = await post(other, { decisionType: 'nonsense' });
    expect(fine.response.status).toBe(400);
  });
});

describe('POST /ncmec-reports from an account suspension (#3040)', () => {
  it('records the report, deriving the reported account from the suspension', async () => {
    const admin = await newAdmin('ncmec-create-admin');
    const decision = await makeSuspension(admin, 'ncmec-create-target');
    const result = await post(admin, {
      decisionType: 'account_suspension',
      suspensionId: decision.suspensionId,
      note: '  escalated per review  ',
      contentRefs: [{ sourceTable: 'sign_posts', sourceId: 'post-123' }],
    });
    expect(result.response.status).toBe(201);
    const { report } = result.body;
    expect(report.reportId).toMatch(/^ncmec-report-/);
    expect(report.decisionType).toBe('account_suspension');
    expect(report.decisionId).toBe(decision.suspensionId);
    expect(report.reportedUserId).toBe(decision.userId);
    expect(report.reportedByAdminId).toBe(await userIdOf(admin));
    expect(report.note).toBe('escalated per review');
    expect(report.contentRefs).toEqual([{ sourceTable: 'sign_posts', sourceId: 'post-123' }]);
    expect(report.createdAt).toBeTruthy();

    const stored = await env.DB.prepare('SELECT * FROM ncmec_reports WHERE report_id = ?')
      .bind(report.reportId).first();
    expect(stored.reported_user_id).toBe(decision.userId);
  });

  it('writes exactly one admin audit-log row for the report', async () => {
    const admin = await newAdmin('ncmec-log-admin');
    const decision = await makeSuspension(admin, 'ncmec-log-target');
    const result = await post(admin, {
      decisionType: 'account_suspension', suspensionId: decision.suspensionId,
    });
    expect(result.response.status).toBe(201);
    const { results } = await env.DB.prepare(
      "SELECT * FROM admin_action_log WHERE action_type = 'ncmec_report_create' AND target_id = ?",
    ).bind(decision.userId).all();
    expect(results).toHaveLength(1);
    expect(results[0].admin_user_id).toBe(await userIdOf(admin));
    expect(results[0].target_type).toBe('user');
    expect(JSON.parse(results[0].detail_json)).toEqual({
      reportId: result.body.report.reportId,
      decisionType: 'account_suspension',
      decisionId: decision.suspensionId,
    });
  });

  it('does not report a suspension that does not exist', async () => {
    const admin = await newAdmin('ncmec-missing-suspension-admin');
    const result = await post(admin, {
      decisionType: 'account_suspension', suspensionId: 'suspension-does-not-exist',
    });
    expect(result.response.status).toBe(404);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ncmec_reports WHERE decision_id = ?')
      .bind('suspension-does-not-exist').first();
    expect(count.n).toBe(0);
  });

  it('rejects a reportedUserId that does not match the suspension', async () => {
    const admin = await newAdmin('ncmec-mismatch-admin');
    const decision = await makeSuspension(admin, 'ncmec-mismatch-target');
    const bystander = await signupBuilder('ncmec-mismatch-bystander');
    const result = await post(admin, {
      decisionType: 'account_suspension',
      suspensionId: decision.suspensionId,
      reportedUserId: await userIdOf(bystander),
    });
    expect(result.response.status).toBe(400);
  });

  it('validates contentRefs', async () => {
    const admin = await newAdmin('ncmec-refs-admin');
    const decision = await makeSuspension(admin, 'ncmec-refs-target');
    const base = { decisionType: 'account_suspension', suspensionId: decision.suspensionId };
    const bad = [
      'not-an-array',
      [{ sourceTable: 'Sign Posts', sourceId: 'x' }],
      [{ sourceTable: 'sign_posts' }],
      [{ sourceTable: 'sign_posts', sourceId: 'x'.repeat(201) }],
      ['a string'],
      Array.from({ length: 21 }, (_, i) => ({ sourceTable: 'sign_posts', sourceId: `p${i}` })),
    ];
    for (const contentRefs of bad) {
      const result = await post(admin, { ...base, contentRefs });
      expect(result.response.status).toBe(400);
    }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ncmec_reports WHERE decision_id = ?')
      .bind(decision.suspensionId).first();
    expect(count.n).toBe(0);
  });

  it('validates decisionType and note', async () => {
    const admin = await newAdmin('ncmec-validate-admin');
    const decision = await makeSuspension(admin, 'ncmec-validate-target');
    const noType = await post(admin, { suspensionId: decision.suspensionId });
    expect(noType.response.status).toBe(400);
    const badType = await post(admin, { decisionType: 'flag_count', suspensionId: decision.suspensionId });
    expect(badType.response.status).toBe(400);
    const longNote = await post(admin, {
      decisionType: 'account_suspension', suspensionId: decision.suspensionId, note: 'n'.repeat(501),
    });
    expect(longNote.response.status).toBe(400);
    const nonStringNote = await post(admin, {
      decisionType: 'account_suspension', suspensionId: decision.suspensionId, note: 5,
    });
    expect(nonStringNote.response.status).toBe(400);
    const missingId = await post(admin, { decisionType: 'account_suspension' });
    expect(missingId.response.status).toBe(400);
  });

  it('refuses to report the same decision twice and logs only the first', async () => {
    const admin = await newAdmin('ncmec-dup-admin');
    const decision = await makeSuspension(admin, 'ncmec-dup-target');
    const body = { decisionType: 'account_suspension', suspensionId: decision.suspensionId };
    const first = await post(admin, body);
    expect(first.response.status).toBe(201);
    const second = await post(admin, { ...body, note: 'a different note this time' });
    expect(second.response.status).toBe(409);
    expect(second.body.reportId).toBe(first.body.report.reportId);

    const stored = await env.DB.prepare('SELECT * FROM ncmec_reports WHERE decision_id = ?')
      .bind(decision.suspensionId).all();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0].note).toBeNull();
    const logs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM admin_action_log WHERE action_type = 'ncmec_report_create' AND target_id = ?",
    ).bind(decision.userId).first();
    expect(logs.n).toBe(1);

    // A different admin hits the same wall: it is one report per decision,
    // not one per admin.
    const otherAdmin = await newAdmin('ncmec-dup-other-admin');
    const third = await post(otherAdmin, body);
    expect(third.response.status).toBe(409);
  });
});

describe('POST /ncmec-reports from a content removal (#3040)', () => {
  it('records the report against the removal snapshot with identifiers only', async () => {
    const admin = await newAdmin('ncmec-removal-admin');
    const reported = await signupBuilder('ncmec-removal-reported');
    const reportedUserId = await userIdOf(reported);
    const sourceId = `post-${crypto.randomUUID()}`;
    const snapshotId = await makeRemovalSnapshot('sign_posts', sourceId);

    const result = await post(admin, {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId, reportedUserId,
    });
    expect(result.response.status).toBe(201);
    expect(result.body.report.decisionType).toBe('content_removal');
    expect(result.body.report.decisionId).toBe(snapshotId);
    expect(result.body.report.reportedUserId).toBe(reportedUserId);
    expect(result.body.report.contentRefs).toEqual([{ sourceTable: 'sign_posts', sourceId }]);

    // Nothing but identifiers in the stored row: no content, no snapshot text.
    const stored = await env.DB.prepare('SELECT * FROM ncmec_reports WHERE report_id = ?')
      .bind(result.body.report.reportId).first();
    expect(Object.keys(stored).sort()).toEqual([
      'content_refs_json', 'created_at', 'decision_id', 'decision_type', 'note',
      'report_id', 'reported_by_admin_id', 'reported_user_id',
    ]);
  });

  it('uses the most recent removal when a source has more than one snapshot', async () => {
    const admin = await newAdmin('ncmec-removal-latest-admin');
    const reported = await signupBuilder('ncmec-removal-latest-reported');
    const sourceId = `post-${crypto.randomUUID()}`;
    await makeRemovalSnapshot('sign_posts', sourceId, 'spam');
    await env.DB.prepare(
      "UPDATE moderation_removal_snapshots SET removed_at = '2000-01-01T00:00:00.000Z' WHERE source_id = ?",
    ).bind(sourceId).run();
    const latest = await makeRemovalSnapshot('sign_posts', sourceId, 'sexual_content');
    const result = await post(admin, {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId,
      reportedUserId: await userIdOf(reported),
    });
    expect(result.response.status).toBe(201);
    expect(result.body.report.decisionId).toBe(latest);
  });

  it('does not report content that was never removed by a moderator', async () => {
    const admin = await newAdmin('ncmec-never-removed-admin');
    const reported = await signupBuilder('ncmec-never-removed-reported');
    const result = await post(admin, {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId: 'post-never-removed',
      reportedUserId: await userIdOf(reported),
    });
    expect(result.response.status).toBe(404);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ncmec_reports WHERE reported_user_id = ?')
      .bind(await userIdOf(reported)).first();
    expect(count.n).toBe(0);
  });

  it('requires a real reportedUserId and rejects contentRefs', async () => {
    const admin = await newAdmin('ncmec-removal-validate-admin');
    const sourceId = `post-${crypto.randomUUID()}`;
    await makeRemovalSnapshot('sign_posts', sourceId);
    const base = { decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId };
    const noUser = await post(admin, base);
    expect(noUser.response.status).toBe(400);
    const unknownUser = await post(admin, { ...base, reportedUserId: 'user-does-not-exist' });
    expect(unknownUser.response.status).toBe(404);
    const reported = await signupBuilder('ncmec-removal-validate-reported');
    const withRefs = await post(admin, {
      ...base, reportedUserId: await userIdOf(reported),
      contentRefs: [{ sourceTable: 'sign_posts', sourceId: 'other' }],
    });
    expect(withRefs.response.status).toBe(400);
    const badTable = await post(admin, {
      decisionType: 'content_removal', sourceTable: 'Not A Table', sourceId,
      reportedUserId: await userIdOf(reported),
    });
    expect(badTable.response.status).toBe(400);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ncmec_reports WHERE reported_user_id = ?')
      .bind(await userIdOf(reported)).first();
    expect(count.n).toBe(0);
  });

  it('refuses to report the same removal twice', async () => {
    const admin = await newAdmin('ncmec-removal-dup-admin');
    const reported = await signupBuilder('ncmec-removal-dup-reported');
    const sourceId = `post-${crypto.randomUUID()}`;
    await makeRemovalSnapshot('sign_posts', sourceId);
    const body = {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId,
      reportedUserId: await userIdOf(reported),
    };
    expect((await post(admin, body)).response.status).toBe(201);
    expect((await post(admin, body)).response.status).toBe(409);
  });
});

describe('ncmec_reports is insert-only (#3040)', () => {
  async function makeReport(label) {
    const admin = await newAdmin(label);
    const decision = await makeSuspension(admin, `${label}-target`);
    const result = await post(admin, {
      decisionType: 'account_suspension', suspensionId: decision.suspensionId, note: 'original note',
    });
    expect(result.response.status).toBe(201);
    return { admin, decision, report: result.body.report };
  }

  it('has no API route that can change or remove a report', async () => {
    const { admin, report } = await makeReport('ncmec-api-immutable');
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const byId = await api(`/ncmec-reports/${report.reportId}`, admin.session({
        method, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ note: 'tampered' }) }),
      }));
      expect(byId.response.status).toBe(404);
      const collection = await api('/ncmec-reports', admin.session({
        method, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ note: 'tampered' }) }),
      }));
      expect(collection.response.status).toBe(404);
    }
    const stored = await env.DB.prepare('SELECT * FROM ncmec_reports WHERE report_id = ?')
      .bind(report.reportId).first();
    expect(stored.note).toBe('original note');
  });

  it('aborts an UPDATE or DELETE at the database level', async () => {
    const { report } = await makeReport('ncmec-db-immutable');
    await expect(env.DB.prepare('UPDATE ncmec_reports SET note = ? WHERE report_id = ?')
      .bind('tampered', report.reportId).run()).rejects.toThrow(/immutable/);
    await expect(env.DB.prepare('UPDATE ncmec_reports SET reported_user_id = ? WHERE report_id = ?')
      .bind('someone-else', report.reportId).run()).rejects.toThrow(/immutable/);
    await expect(env.DB.prepare('DELETE FROM ncmec_reports WHERE report_id = ?')
      .bind(report.reportId).run()).rejects.toThrow(/immutable/);
    await expect(env.DB.prepare('DELETE FROM ncmec_reports').run()).rejects.toThrow(/immutable/);
    const stored = await env.DB.prepare('SELECT * FROM ncmec_reports WHERE report_id = ?')
      .bind(report.reportId).first();
    expect(stored.note).toBe('original note');
    expect(stored.reported_user_id).toBe(report.reportedUserId);
  });

  it('survives the reported account deleting itself', async () => {
    const admin = await newAdmin('ncmec-survive-admin');
    const password = 'a fine long password here';
    const email = `ncmec-survive-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, password, { username: 'ncmec-survive-reported' });
    const session = extractSessionCookie(signedUp.response);
    const me = await api('/auth/me', withSession(session));
    const reportedUserId = me.body.user.userId;
    const sourceId = `post-${crypto.randomUUID()}`;
    await makeRemovalSnapshot('sign_posts', sourceId);
    const created = await post(admin, {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId, reportedUserId,
    });
    expect(created.response.status).toBe(201);

    const deletion = await api('/auth/delete-account', withSession(session, {
      method: 'POST', body: JSON.stringify({ password }),
    }));
    expect(deletion.response.status).toBe(200);

    const list = await api(`/ncmec-reports?reportedUserId=${encodeURIComponent(reportedUserId)}`, admin.session());
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0].reportId).toBe(created.body.report.reportId);
  });
});

describe('GET /ncmec-reports (#3040)', () => {
  it('requires admin', async () => {
    const anon = await api('/ncmec-reports');
    expect(anon.response.status).toBe(401);
    const builder = await signupBuilder('ncmec-list-non-admin');
    const forbidden = await api('/ncmec-reports', builder.session());
    expect(forbidden.response.status).toBe(403);
  });

  it('lists newest first, filters by reported account, and validates limit', async () => {
    const admin = await newAdmin('ncmec-list-admin');
    const reported = await signupBuilder('ncmec-list-reported');
    const reportedUserId = await userIdOf(reported);
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const sourceId = `post-${crypto.randomUUID()}`;
      await makeRemovalSnapshot('sign_posts', sourceId);
      const created = await post(admin, {
        decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId, reportedUserId,
      });
      expect(created.response.status).toBe(201);
      ids.push(created.body.report.reportId);
    }
    const list = await api(`/ncmec-reports?reportedUserId=${encodeURIComponent(reportedUserId)}`, admin.session());
    expect(list.response.status).toBe(200);
    expect(list.body.reports.map((r) => r.reportId).sort()).toEqual([...ids].sort());
    const times = list.body.reports.map((r) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    const limited = await api(`/ncmec-reports?reportedUserId=${encodeURIComponent(reportedUserId)}&limit=2`, admin.session());
    expect(limited.body.reports).toHaveLength(2);
    const badLimit = await api('/ncmec-reports?limit=0', admin.session());
    expect(badLimit.response.status).toBe(400);
    const none = await api('/ncmec-reports?reportedUserId=nobody-at-all', admin.session());
    expect(none.body.reports).toEqual([]);
  });
});

describe('a report is invisible to the reported account (#3040)', () => {
  it('changes nothing the reported user can see or download', async () => {
    const admin = await newAdmin('ncmec-leak-admin');
    // Neutral label: the reported account's own username/email appear in
    // its export, so a label containing "ncmec" would defeat the assertion.
    const reported = await signupBuilder('leak-check-reported');
    const reportedUserId = await userIdOf(reported);
    const sourceId = `post-${crypto.randomUUID()}`;
    await makeRemovalSnapshot('sign_posts', sourceId);

    const meBefore = await api('/auth/me', reported.session());
    const noticesBefore = await api('/notifications', reported.session());

    const created = await post(admin, {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId, reportedUserId,
    });
    expect(created.response.status).toBe(201);

    // Still logged in and unsuspended, with no new notification.
    const meAfter = await api('/auth/me', reported.session());
    expect(meAfter.response.status).toBe(200);
    expect(meAfter.body).toEqual(meBefore.body);
    const noticesAfter = await api('/notifications', reported.session());
    expect(noticesAfter.body).toEqual(noticesBefore.body);
    const suspensions = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM account_suspensions WHERE user_id = ?',
    ).bind(reportedUserId).first();
    expect(suspensions.n).toBe(0);

    // The user's own data export never mentions the report.
    const exported = await api('/auth/export-data', reported.session());
    expect(exported.response.status).toBe(200);
    const exportText = JSON.stringify(exported.body).toLowerCase();
    expect(exportText).not.toContain('ncmec');
    expect(exportText).not.toContain(created.body.report.reportId.toLowerCase());
  });
});
