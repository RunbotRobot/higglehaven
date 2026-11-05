// #3041 (sub-issue 2/3 of #3031): evidence preservation for an
// admin-recorded NCMEC report (worker/lib/ncmec-evidence.js, migrations/0187).
// Owner decision 2026-11-05: preserve only for reported items, admin-only,
// excluded from every deletion/cleanup path, auto-purged at one year. The
// emphasis is on what must never happen: evidence lost to an account/content
// deletion or an R2 sweep, evidence reachable by the reported account or the
// public, content retained when it did not exist at report time, and the
// purge touching the immutable report record.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { cascadeDeleteAccount } from './index.js';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';
import { cleanupUnreferencedModels, scheduledModelCleanup } from './lib/models.js';
import {
  EVIDENCE_R2_PREFIX, NCMEC_EVIDENCE_RETENTION_MS, isNcmecEvidenceKey, purgeExpiredNcmecEvidence,
} from './lib/ncmec-evidence.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function makeSuspension(admin, label) {
  const target = await signupBuilder(label);
  const suspended = await api('/auth/suspend-account', admin.session({
    method: 'POST',
    body: JSON.stringify({ email: target.email, reason: 'test suspension for preserved-content checks' }),
  }));
  expect(suspended.response.status).toBe(200);
  return { target, suspensionId: suspended.body.suspension.suspensionId, userId: suspended.body.suspension.userId };
}

// A live product whose model lives in R2, as a report's content reference.
async function makeProductWithObject(marker) {
  const productId = `product-${crypto.randomUUID()}`;
  const key = `models/${marker}-${crypto.randomUUID()}.glb`;
  await env.MODELS.put(key, new TextEncoder().encode(`bytes-${marker}`), {
    httpMetadata: { contentType: 'model/gltf-binary' },
  });
  await env.DB.prepare(`
    INSERT INTO products (product_id, name, color, width_m, depth_m, height_m, model_url)
    VALUES (?, ?, 'red', 1, 1, 1, ?)
  `).bind(productId, `Product ${marker}`, `/uploads/${key}`).run();
  return { productId, key };
}

function report(admin, body) {
  return api('/ncmec-reports', admin.session({ method: 'POST', body: JSON.stringify(body) }));
}

async function reportSuspensionWithProduct(label) {
  const admin = await signupAdmin(`${label}-admin`);
  const suspension = await makeSuspension(admin, `${label}-target`);
  const product = await makeProductWithObject(label);
  const created = await report(admin, {
    decisionType: 'account_suspension',
    suspensionId: suspension.suspensionId,
    contentRefs: [{ sourceTable: 'products', sourceId: product.productId }],
  });
  expect(created.response.status).toBe(201);
  const reportId = created.body.report.reportId;
  const evidenceKey = `${EVIDENCE_R2_PREFIX}${reportId}/${product.key}`;
  return { admin, suspension, product, reportId, evidenceKey };
}

async function evidenceRow(reportId) {
  return env.DB.prepare('SELECT * FROM ncmec_evidence WHERE report_id = ?').bind(reportId).first();
}

describe('evidence capture at report time (#3041)', () => {
  it('stores account, upload metadata and the live content row, and copies the R2 object', async () => {
    const { admin, product, reportId, evidenceKey } = await reportSuspensionWithProduct('ev-capture');
    const fetched = await api(`/ncmec-reports/${reportId}/evidence`, admin.session());
    expect(fetched.response.status).toBe(200);
    const { evidence } = fetched.body;
    expect(evidence.reportId).toBe(reportId);
    expect(evidence.account.user.email).toMatch(/^ev-capture-target-/);
    expect(evidence.account.user).not.toHaveProperty('password_hash');
    expect(evidence.account.user).not.toHaveProperty('tax_id_encrypted');
    expect(evidence.account.builder.builder_id).toBeTruthy();
    const entry = evidence.content[0];
    expect(entry.status).toBe('preserved');
    expect(entry.row.product_id).toBe(product.productId);
    expect(entry.r2Keys).toEqual([{ sourceKey: product.key, evidenceKey }]);
    const copy = await env.MODELS.get(evidenceKey);
    expect(await copy.text()).toBe('bytes-ev-capture');
  });

  it('records "not retained" plainly for content already gone at report time', async () => {
    const admin = await signupAdmin('ev-gone-admin');
    const target = await signupBuilder('ev-gone-target');
    const me = await api('/auth/me', target.session());
    const sourceId = `post-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO moderation_removal_snapshots (snapshot_id, source_table, source_id, removed_category, snapshot_json)
      VALUES (?, 'sign_posts', ?, 'sexual_content', NULL)
    `).bind(`modsnap-${crypto.randomUUID()}`, sourceId).run();
    const created = await report(admin, {
      decisionType: 'content_removal', sourceTable: 'sign_posts', sourceId, reportedUserId: me.body.user.userId,
    });
    expect(created.response.status).toBe(201);
    const row = await evidenceRow(created.body.report.reportId);
    const content = JSON.parse(row.content_json);
    expect(content[0].status).toBe('not_retained');
    expect(content[0].reason).toMatch(/no longer existed/);
    // The sexual_content keep-nothing rule is intact: no content anywhere.
    expect(content[0].row).toBeUndefined();
    expect(content[0].removalSnapshots[0].snapshot_json).toBeNull();
  });

  it('is admin-only, and nothing reaches the reported account or its export', async () => {
    const { suspension, reportId } = await reportSuspensionWithProduct('ev-private');
    expect((await api(`/ncmec-reports/${reportId}/evidence`)).response.status).toBe(401);
    expect((await api(`/ncmec-reports/${reportId}/evidence`, suspension.target.session())).response.status).toBe(403);
    const notices = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE message LIKE '%ncmec%'",
    ).first();
    expect(notices.n).toBe(0);
    const exportResponse = await api('/auth/export-data', suspension.target.session());
    expect(JSON.stringify(exportResponse.body ?? {})).not.toMatch(/ncmec/i);
  });

  it('leaves no stray R2 copies when the report is a duplicate', async () => {
    const { admin, suspension, product, reportId } = await reportSuspensionWithProduct('ev-dup');
    const again = await report(admin, {
      decisionType: 'account_suspension',
      suspensionId: suspension.suspensionId,
      contentRefs: [{ sourceTable: 'products', sourceId: product.productId }],
    });
    expect(again.response.status).toBe(409);
    const listed = await env.MODELS.list({ prefix: EVIDENCE_R2_PREFIX });
    const keys = listed.objects.map((o) => o.key).filter((k) => k.includes(product.key));
    expect(keys).toEqual([`${EVIDENCE_R2_PREFIX}${reportId}/${product.key}`]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM ncmec_evidence WHERE reported_user_id = ?')
      .bind(suspension.userId).first();
    expect(count.n).toBe(1);
  });

  it('rows are immutable', async () => {
    const { reportId } = await reportSuspensionWithProduct('ev-immutable');
    await expect(env.DB.prepare('UPDATE ncmec_evidence SET account_json = ? WHERE report_id = ?')
      .bind('{}', reportId).run()).rejects.toThrow(/immutable/);
  });
});

describe('every deletion and cleanup path leaves evidence alone (#3041)', () => {
  it('survives deletion of the reported account (cascadeDeleteAccount)', async () => {
    const { suspension, reportId, evidenceKey } = await reportSuspensionWithProduct('ev-acct-del');
    // The real deletion routine (also what the expired-suspension cron calls).
    await cascadeDeleteAccount(env.DB, suspension.userId);
    const gone = await env.DB.prepare('SELECT deleted_at FROM users WHERE user_id = ?').bind(suspension.userId).first();
    expect(gone.deleted_at).not.toBeNull();
    expect(await evidenceRow(reportId)).not.toBeNull();
    expect(await env.MODELS.head(evidenceKey)).not.toBeNull();
  });

  it('survives deletion of the source content row', async () => {
    const { product, reportId, evidenceKey } = await reportSuspensionWithProduct('ev-content-del');
    await env.DB.prepare('DELETE FROM products WHERE product_id = ?').bind(product.productId).run();
    expect(await evidenceRow(reportId)).not.toBeNull();
    expect(await env.MODELS.head(evidenceKey)).not.toBeNull();
  });

  it('survives the R2 orphan sweep, even with the source deleted and no age grace', async () => {
    const { product, evidenceKey } = await reportSuspensionWithProduct('ev-sweep');
    await env.DB.prepare('DELETE FROM products WHERE product_id = ?').bind(product.productId).run();
    const orphanKey = `models/orphan-${crypto.randomUUID()}.glb`;
    await env.MODELS.put(orphanKey, new TextEncoder().encode('orphan'));
    const result = await cleanupUnreferencedModels(env, { maxDeletes: 1000, dryRun: false, minAgeMs: 0 });
    expect(result.targetModelUrls ?? []).not.toContain(`/uploads/${evidenceKey}`);
    expect(await env.MODELS.head(orphanKey)).toBeNull();
    expect(await env.MODELS.head(evidenceKey)).not.toBeNull();
    // The unattended cron path too.
    await scheduledModelCleanup(env);
    expect(await env.MODELS.head(evidenceKey)).not.toBeNull();
  });

  it('is not served, probed, listed or deletable through the public asset routes', async () => {
    const { admin, evidenceKey } = await reportSuspensionWithProduct('ev-routes');
    const path = `/uploads/${evidenceKey}`;
    const get = await worker.fetch(new Request(`https://higglehaven.test${path}`), env, { waitUntil() {}, passThroughOnException() {} });
    expect(get.status).toBe(404);
    const del = await worker.fetch(new Request(`https://higglehaven.test${path}`, {
      method: 'DELETE', headers: { cookie: admin.session().headers.cookie },
    }), env, { waitUntil() {}, passThroughOnException() {} });
    expect(del.status).toBe(404);
    expect(await env.MODELS.head(evidenceKey)).not.toBeNull();
    const listing = await api('/models', admin.session());
    expect(JSON.stringify(listing.body)).not.toContain(EVIDENCE_R2_PREFIX);
  });

  it('survives the scheduled() cron as a whole', async () => {
    const { reportId, evidenceKey } = await reportSuspensionWithProduct('ev-cron');
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const pending = [];
    ctx.waitUntil = (p) => pending.push(p);
    await worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env, ctx);
    await Promise.allSettled(pending);
    expect(await evidenceRow(reportId)).not.toBeNull();
    expect(await env.MODELS.head(evidenceKey)).not.toBeNull();
  });

  it('isNcmecEvidenceKey matches only the evidence prefix', () => {
    expect(isNcmecEvidenceKey(`${EVIDENCE_R2_PREFIX}r/models/x.glb`)).toBe(true);
    expect(isNcmecEvidenceKey('models/x.glb')).toBe(false);
    expect(isNcmecEvidenceKey(undefined)).toBe(false);
  });
});

describe('retention purge (#3041)', () => {
  async function insertEvidence(label, capturedAt) {
    const reportId = `ncmec-report-${label}-${crypto.randomUUID()}`;
    const evidenceKey = `${EVIDENCE_R2_PREFIX}${reportId}/models/${label}.glb`;
    await env.MODELS.put(evidenceKey, new TextEncoder().encode(label));
    await env.DB.prepare(`
      INSERT INTO ncmec_evidence (evidence_id, report_id, reported_user_id, account_json, content_json, captured_at)
      VALUES (?, ?, 'u', '{}', ?, ?)
    `).bind(
      `ncmec-evidence-${crypto.randomUUID()}`, reportId,
      JSON.stringify([{ status: 'preserved', r2Keys: [{ sourceKey: 'models/x', evidenceKey }] }]), capturedAt,
    ).run();
    return { reportId, evidenceKey };
  }

  it('purges only evidence past the retention constant, with one audit row each, leaving the report record', async () => {
    const real = await reportSuspensionWithProduct('ev-purge-real');
    const expired = await insertEvidence('expired', new Date(Date.now() - NCMEC_EVIDENCE_RETENTION_MS - 60_000).toISOString());
    const recent = await insertEvidence('recent', new Date(Date.now() - NCMEC_EVIDENCE_RETENTION_MS + 3_600_000).toISOString());

    const result = await purgeExpiredNcmecEvidence(env);
    expect(result.purged).toBe(1);

    expect(await evidenceRow(expired.reportId)).toBeNull();
    expect(await env.MODELS.head(expired.evidenceKey)).toBeNull();
    expect(await evidenceRow(recent.reportId)).not.toBeNull();
    expect(await env.MODELS.head(recent.evidenceKey)).not.toBeNull();
    expect(await evidenceRow(real.reportId)).not.toBeNull();

    const logs = await env.DB.prepare(
      "SELECT target_id, detail_json FROM admin_action_log WHERE action_type = 'ncmec_evidence_purge' AND target_id = ?",
    ).bind(expired.reportId).all();
    expect(logs.results).toHaveLength(1);
    expect(JSON.parse(logs.results[0].detail_json).r2ObjectsDeleted).toBe(1);

    // Idempotent: a second run has nothing left to do and logs nothing more.
    expect((await purgeExpiredNcmecEvidence(env)).purged).toBe(0);
  });

  it('never touches the immutable ncmec_reports record', async () => {
    const { reportId } = await reportSuspensionWithProduct('ev-purge-report');
    const later = Date.now() + NCMEC_EVIDENCE_RETENTION_MS + 86_400_000;
    await purgeExpiredNcmecEvidence(env, later, 1000);
    expect(await evidenceRow(reportId)).toBeNull();
    const kept = await env.DB.prepare('SELECT report_id FROM ncmec_reports WHERE report_id = ?').bind(reportId).first();
    expect(kept).not.toBeNull();
  });

  it('retention is a single constant of one year', () => {
    expect(NCMEC_EVIDENCE_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});
