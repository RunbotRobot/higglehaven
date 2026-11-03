// #3040 (sub-issue 1/3 of #3031, docs/SPEC.md §6): the admin-initiated
// "report to NCMEC" record. This module only ever writes an immutable
// ncmec_reports row (migrations/0176) and an admin_action_log entry. It
// makes no external call of any kind -- the CyberTipline submission is
// #3042, blocked on the owner registering with NCMEC -- and it never
// notifies, touches, or changes anything the reported user can see: the
// reported account sees only whatever ordinary moderation outcome already
// applied to it.
//
// Reports key on a confirmed admin decision that already exists, never on
// raw flag counts (standing owner decision: "Moderation actions key on
// confirmed violations"). Two decision kinds exist today:
//   - 'account_suspension': account_suspensions.suspension_id. The reported
//     account is derived from that row, not trusted from the request.
//   - 'content_removal': the moderation_removal_snapshots row for a content
//     item an admin removed. That table deliberately retains no author for
//     sexual_content removals (owner decision 2026-10-20), so the reported
//     account is supplied by the admin and only checked to exist.
import { json, HttpError } from './http.js';
import { readJson, stringValue, queryLimit } from './validation.js';
import { requireAdmin } from './auth.js';
import { checkRateLimit } from './rate-limit.js';

// Same bucket shape and ceiling as the sibling admin mutations in
// account-moderation.js (ADMIN_GRANT_RATE_LIMIT_MAX), keyed by the acting
// admin.
const NCMEC_REPORT_RATE_LIMIT_MAX = 20;
const NOTE_MAX_LENGTH = 500;
const MAX_CONTENT_REFS = 20;
const SOURCE_ID_MAX_LENGTH = 200;
const SOURCE_TABLE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DECISION_TYPES = ['account_suspension', 'content_removal'];

function reportFromRow(row) {
  return {
    reportId: row.report_id,
    decisionType: row.decision_type,
    decisionId: row.decision_id,
    reportedUserId: row.reported_user_id,
    contentRefs: JSON.parse(row.content_refs_json),
    note: row.note,
    reportedByAdminId: row.reported_by_admin_id,
    createdAt: row.created_at,
  };
}

// Identifiers only ({sourceTable, sourceId}), never content -- the report
// row must not become a second copy of material the owner's sexual_content
// rule says is retained nowhere.
function contentRef(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${field} must be an object with sourceTable and sourceId`, 400);
  }
  const sourceTable = typeof value.sourceTable === 'string' ? value.sourceTable.trim() : '';
  if (!SOURCE_TABLE_PATTERN.test(sourceTable)) {
    throw new HttpError(`${field}.sourceTable must be a lowercase table name`, 400);
  }
  const sourceId = stringValue(value.sourceId, `${field}.sourceId`);
  if (sourceId.length > SOURCE_ID_MAX_LENGTH) {
    throw new HttpError(`${field}.sourceId must be ${SOURCE_ID_MAX_LENGTH} characters or fewer`, 400);
  }
  return { sourceTable, sourceId };
}

async function resolveDecision(db, input, decisionType) {
  if (decisionType === 'account_suspension') {
    const suspensionId = stringValue(input.suspensionId, 'suspensionId');
    const suspension = await db.prepare(
      'SELECT suspension_id, user_id FROM account_suspensions WHERE suspension_id = ?',
    ).bind(suspensionId).first();
    if (!suspension) throw new HttpError('No suspension with that suspensionId', 404);
    if (input.reportedUserId !== undefined && input.reportedUserId !== suspension.user_id) {
      throw new HttpError('reportedUserId does not match that suspension', 400);
    }
    let contentRefs = [];
    if (input.contentRefs !== undefined) {
      if (!Array.isArray(input.contentRefs) || input.contentRefs.length > MAX_CONTENT_REFS) {
        throw new HttpError(`contentRefs must be an array of at most ${MAX_CONTENT_REFS} items`, 400);
      }
      contentRefs = input.contentRefs.map((ref, i) => contentRef(ref, `contentRefs[${i}]`));
    }
    return { decisionId: suspension.suspension_id, reportedUserId: suspension.user_id, contentRefs };
  }

  // content_removal: one removed item, identified by where it lived.
  if (input.contentRefs !== undefined) {
    throw new HttpError('contentRefs is not accepted for content_removal; the removed item is taken from sourceTable/sourceId', 400);
  }
  const ref = contentRef({ sourceTable: input.sourceTable, sourceId: input.sourceId }, 'content');
  const snapshot = await db.prepare(`
    SELECT snapshot_id FROM moderation_removal_snapshots
    WHERE source_table = ? AND source_id = ?
    ORDER BY removed_at DESC, snapshot_id DESC LIMIT 1
  `).bind(ref.sourceTable, ref.sourceId).first();
  if (!snapshot) throw new HttpError('No confirmed moderation removal for that content', 404);
  const reportedUserId = stringValue(input.reportedUserId, 'reportedUserId');
  const reported = await db.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(reportedUserId).first();
  if (!reported) throw new HttpError('No account with that reportedUserId', 404);
  return { decisionId: snapshot.snapshot_id, reportedUserId: reported.user_id, contentRefs: [ref] };
}

async function handleCreate(request, db) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `ncmec-report:${admin.user_id}`, NCMEC_REPORT_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const decisionType = input.decisionType;
  if (!DECISION_TYPES.includes(decisionType)) {
    throw new HttpError(`decisionType must be one of: ${DECISION_TYPES.join(', ')}`, 400);
  }
  let note = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') throw new HttpError('note must be a string', 400);
    note = input.note.trim() || null;
    if (note && note.length > NOTE_MAX_LENGTH) {
      throw new HttpError(`note must be ${NOTE_MAX_LENGTH} characters or fewer`, 400);
    }
  }
  const { decisionId, reportedUserId, contentRefs } = await resolveDecision(db, input, decisionType);

  const reportId = `ncmec-report-${crypto.randomUUID()}`;
  // One report per decision. ON CONFLICT on exactly that unique pair (not
  // INSERT OR IGNORE, which would also swallow a NOT NULL/CHECK violation
  // as if it were a duplicate). The audit-log row is batched with the
  // insert but conditional on the report row actually existing, so a
  // duplicate attempt logs nothing and a real one can never lack its log.
  const results = await db.batch([
    db.prepare(`
      INSERT INTO ncmec_reports
        (report_id, decision_type, decision_id, reported_user_id, content_refs_json, note, reported_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (decision_type, decision_id) DO NOTHING
    `).bind(reportId, decisionType, decisionId, reportedUserId, JSON.stringify(contentRefs), note, admin.user_id),
    db.prepare(`
      INSERT INTO admin_action_log (log_id, admin_user_id, action_type, target_type, target_id, detail_json)
      SELECT ?, ?, 'ncmec_report_create', 'user', ?, ?
      WHERE EXISTS (SELECT 1 FROM ncmec_reports WHERE report_id = ?)
    `).bind(
      `admin-action-${crypto.randomUUID()}`, admin.user_id, reportedUserId,
      JSON.stringify({ reportId, decisionType, decisionId }), reportId,
    ),
  ]);
  if (results[0].meta.changes === 0) {
    const existing = await db.prepare(
      'SELECT report_id FROM ncmec_reports WHERE decision_type = ? AND decision_id = ?',
    ).bind(decisionType, decisionId).first();
    throw new HttpError('That decision has already been reported', 409, { reportId: existing?.report_id ?? null });
  }
  const row = await db.prepare('SELECT * FROM ncmec_reports WHERE report_id = ?').bind(reportId).first();
  return json({ report: reportFromRow(row) }, 201);
}

async function handleList(request, db, url) {
  await requireAdmin(request, db);
  const limit = queryLimit(url.searchParams.get('limit'), 50);
  const reportedUserId = url.searchParams.get('reportedUserId');
  const { results } = reportedUserId === null
    ? await db.prepare('SELECT * FROM ncmec_reports ORDER BY created_at DESC, report_id DESC LIMIT ?').bind(limit).all()
    : await db.prepare(
      'SELECT * FROM ncmec_reports WHERE reported_user_id = ? ORDER BY created_at DESC, report_id DESC LIMIT ?',
    ).bind(stringValue(reportedUserId, 'reportedUserId'), limit).all();
  return json({ reports: results.map(reportFromRow) });
}

// Insert and read only: there is deliberately no PATCH/PUT/DELETE route,
// and the table's own triggers (migrations/0176) abort an UPDATE/DELETE
// even from code that bypasses this handler.
export async function handleNcmecReports(request, db, route, url) {
  if (route.length === 1 && request.method === 'POST') return handleCreate(request, db);
  if (route.length === 1 && request.method === 'GET') return handleList(request, db, url);
  return json({ error: 'Not found' }, 404);
}
