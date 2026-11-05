// #3041 (sub-issue 2/3 of #3031, docs/SPEC.md §6): evidence preservation for
// an admin-recorded NCMEC report. Owner decision 2026-11-05 (comment on
// #3041): preserve content ONLY for items an admin has recorded a report
// on, in a segregated admin-only store, excluded from every deletion and
// cleanup path, auto-purged at one year. The 2026-10-20 sexual_content
// keep-nothing rule (migrations/0168) is untouched for ordinary removals.
//
// Two halves, both keyed on a report (never on a removal or flag alone):
//   - D1: one ncmec_evidence row per report (migrations/0187), inserted in
//     the same atomic batch as the ncmec_reports row.
//   - R2: a copy of every still-present object the reported content rows
//     reference, under EVIDENCE_R2_PREFIX in the MODELS bucket. Every code
//     path that lists, serves or deletes that bucket skips the prefix
//     (isNcmecEvidenceKey is the single test they all use).
//
// Nothing here is reachable by the reported account: no route other than the
// requireAdmin one below reads this table, it is not in the data export, and
// no notification is ever sent from it.
import { json, HttpError } from './http.js';
import { requireAdmin } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import { stringValue } from './validation.js';

// The single retention constant. Counsel can change it without a schema
// change: the purge keys on captured_at against this value at run time.
// One year is the baseline in 18 U.S.C. § 2258A(h) as amended by the
// REPORT Act (2024).
export const NCMEC_EVIDENCE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const EVIDENCE_R2_PREFIX = 'ncmec-evidence/';

// True for any R2 key inside the evidence store. Every sweep, listing and
// delete over the MODELS bucket must call this and leave such keys alone.
export function isNcmecEvidenceKey(key) {
  return typeof key === 'string' && key.startsWith(EVIDENCE_R2_PREFIX);
}

// Content tables a report may reference, with their primary-key column.
// An allowlist, never request input spliced into SQL.
const CONTENT_TABLES = {
  sign_posts: 'post_id',
  calendar_events: 'event_id',
  product_reviews: 'review_id',
  catalog_templates: 'template_id',
  products: 'product_id',
  video_generation_jobs: 'job_id',
};

const UPLOAD_METADATA_LIMIT = 200;
const UPLOADS_PATH = /^\/uploads\/(.+)$/;

function collectUploadKeys(row) {
  const keys = new Set();
  for (const value of Object.values(row)) {
    if (typeof value !== 'string') continue;
    const match = UPLOADS_PATH.exec(value);
    if (match && !isNcmecEvidenceKey(match[1])) keys.add(match[1]);
  }
  return [...keys];
}

// Copies one object into the evidence prefix. Returns the destination key,
// or null if the source no longer exists. A copy that fails for any other
// reason throws: a report must not be recorded as preserved when it is not.
async function copyToEvidence(env, reportId, sourceKey) {
  const source = await env.MODELS.get(sourceKey);
  if (!source) return null;
  const destinationKey = `${EVIDENCE_R2_PREFIX}${reportId}/${sourceKey}`;
  await env.MODELS.put(destinationKey, source.body, { httpMetadata: source.httpMetadata });
  return destinationKey;
}

async function snapshotContentRef(env, reportId, ref, copiedKeys) {
  const pkColumn = CONTENT_TABLES[ref.sourceTable];
  const removalSnapshots = (await env.DB.prepare(`
    SELECT snapshot_id, removed_category, snapshot_json, removed_at
    FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?
    ORDER BY removed_at, snapshot_id
  `).bind(ref.sourceTable, ref.sourceId).all()).results;
  if (!pkColumn) {
    return {
      sourceTable: ref.sourceTable, sourceId: ref.sourceId, status: 'not_retained',
      reason: 'This kind of content is not one the evidence store can read; only identifiers were recorded.',
      removalSnapshots,
    };
  }
  const row = await env.DB.prepare(`SELECT * FROM ${ref.sourceTable} WHERE ${pkColumn} = ?`)
    .bind(ref.sourceId).first();
  if (!row) {
    return {
      sourceTable: ref.sourceTable, sourceId: ref.sourceId, status: 'not_retained',
      reason: 'The content no longer existed when the report was recorded (it was removed or deleted earlier), so it could not be preserved.',
      removalSnapshots,
    };
  }
  const r2Keys = [];
  const missingObjects = [];
  if (env.MODELS) {
    for (const sourceKey of collectUploadKeys(row)) {
      const destinationKey = await copyToEvidence(env, reportId, sourceKey);
      if (destinationKey) {
        copiedKeys.push(destinationKey);
        r2Keys.push({ sourceKey, evidenceKey: destinationKey });
      } else {
        missingObjects.push(sourceKey);
      }
    }
  }
  return {
    sourceTable: ref.sourceTable, sourceId: ref.sourceId, status: 'preserved', row, r2Keys, missingObjects,
    removalSnapshots,
  };
}

// Reads everything that should be preserved for a report, copying R2
// objects as it goes. Returns the ncmec_evidence insert statement plus the
// copied R2 keys so the caller can delete them again if the report row then
// turns out to be a duplicate. Never includes credentials or tax data.
export async function buildNcmecEvidence(env, { reportId, reportedUserId, contentRefs }) {
  const copiedKeys = [];
  try {
    const account = await env.DB.prepare(`
      SELECT user_id, email, username, email_verified_at, created_at, trust_tier, card_funding,
             age_attested_at, deleted_at
      FROM users WHERE user_id = ?
    `).bind(reportedUserId).first();
    const builder = await env.DB.prepare(
      'SELECT builder_id, label, created_at FROM builders WHERE user_id = ?',
    ).bind(reportedUserId).first();
    const seller = await env.DB.prepare(
      'SELECT seller_id, label, created_at FROM sellers WHERE user_id = ?',
    ).bind(reportedUserId).first();
    const templates = seller ? (await env.DB.prepare(`
      SELECT template_id, name, model_url, image_url, created_at FROM catalog_templates
      WHERE seller_id = ? ORDER BY created_at DESC LIMIT ?
    `).bind(seller.seller_id, UPLOAD_METADATA_LIMIT).all()).results : [];
    const videoJobs = builder ? (await env.DB.prepare(`
      SELECT job_id, status, model_url, created_at FROM video_generation_jobs
      WHERE builder_id = ? ORDER BY created_at DESC LIMIT ?
    `).bind(builder.builder_id, UPLOAD_METADATA_LIMIT).all()).results : [];

    const content = [];
    for (const ref of contentRefs) content.push(await snapshotContentRef(env, reportId, ref, copiedKeys));

    const statement = env.DB.prepare(`
      INSERT INTO ncmec_evidence (evidence_id, report_id, reported_user_id, account_json, uploads_json, content_json)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ncmec_reports WHERE report_id = ?)
    `).bind(
      `ncmec-evidence-${crypto.randomUUID()}`, reportId, reportedUserId,
      JSON.stringify({ user: account ?? null, builder: builder ?? null, seller: seller ?? null }),
      JSON.stringify({ catalogTemplates: templates, videoGenerationJobs: videoJobs }),
      JSON.stringify(content),
      reportId,
    );
    return { statement, copiedKeys };
  } catch (error) {
    await discardEvidenceObjects(env, copiedKeys);
    throw error;
  }
}

export async function discardEvidenceObjects(env, keys) {
  if (!env.MODELS || keys.length === 0) return;
  await env.MODELS.delete(keys).catch((error) => console.error('discardEvidenceObjects failed', error));
}

function evidenceFromRow(row) {
  return {
    evidenceId: row.evidence_id,
    reportId: row.report_id,
    reportedUserId: row.reported_user_id,
    account: JSON.parse(row.account_json),
    uploads: JSON.parse(row.uploads_json),
    content: JSON.parse(row.content_json),
    capturedAt: row.captured_at,
  };
}

// GET /api/ncmec-reports/:reportId/evidence -- admin-only, read-only.
export async function handleNcmecEvidenceGet(request, env, reportId) {
  await requireAdmin(request, env.DB);
  const row = await env.DB.prepare('SELECT * FROM ncmec_evidence WHERE report_id = ?')
    .bind(stringValue(reportId, 'reportId')).first();
  if (!row) throw new HttpError('No preserved evidence for that report', 404);
  return json({ evidence: evidenceFromRow(row) });
}

// Scheduled retention purge: deletes evidence older than the retention
// constant, R2 copies first (so a failed delete leaves the D1 row, and the
// list of keys, in place for the next run), then the D1 row and one
// admin_action_log row per purged report in a single batch.
export async function purgeExpiredNcmecEvidence(env, now = Date.now(), batchSize = 25) {
  const cutoff = new Date(now - NCMEC_EVIDENCE_RETENTION_MS).toISOString();
  const { results } = await env.DB.prepare(`
    SELECT evidence_id, report_id, reported_user_id, content_json, captured_at
    FROM ncmec_evidence WHERE captured_at < ? ORDER BY captured_at LIMIT ?
  `).bind(cutoff, batchSize).all();
  let purged = 0;
  for (const row of results) {
    const keys = JSON.parse(row.content_json)
      .flatMap((entry) => (entry.r2Keys ?? []).map((k) => k.evidenceKey))
      .filter(isNcmecEvidenceKey);
    if (env.MODELS && keys.length > 0) await env.MODELS.delete(keys);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM ncmec_evidence WHERE evidence_id = ?').bind(row.evidence_id),
      adminActionLogStatement(env.DB, null, 'ncmec_evidence_purge', 'ncmec_report', row.report_id, {
        reportId: row.report_id, capturedAt: row.captured_at, r2ObjectsDeleted: keys.length,
        trigger: 'scheduled',
      }),
    ]);
    purged += 1;
  }
  return { purged };
}
