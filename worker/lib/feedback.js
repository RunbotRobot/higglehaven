// #2719 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
// reports with automatic rendering-state capture"): the backend half of
// the feature -- #2717's client-side ring buffer and #2718's "Submit
// Feedback" UI already land the payload this receives (a multipart
// `screenshot` file field plus a JSON-string `metadata` field; see
// src/feedback/submitFeedbackUI.js's own handleFeedbackSubmit for the
// exact shape). See migrations/0151_bug_reports.sql's own comment for why
// the screenshot goes to a dedicated FEEDBACK R2 bucket rather than the
// shared MODELS one.
import { json, HttpError, clientIp } from './http.js';
import { currentUser, requireAdmin } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import { formatBytes } from './storage.js';

// #2720 (sub-issue of #2715, the last of the four -- #2717/#2718/#2719 all
// already merged): "surface submitted bug reports in the Control Room as a
// new task kind." A `bug_reports` row by itself was invisible to the
// fleet's existing triage flow (docs/API.md's own "Not yet built" note on
// this) -- every other source of Control Room work (a GitHub issue/PR, an
// owner note, a session's own feedback/question) lands as a
// `control_room_tasks` row the instant it exists, so a bug report should
// too, rather than requiring a separate D1 query nobody's going to
// remember to run. This is a direct `control_room_tasks` write (same
// `db.batch` transaction as the `bug_reports` insert below), not a round
// trip through the validating `/api/control-room/tasks` HTTP API -- that
// API's own required fields (`from`, `title`) exist to stop an external
// caller from posting a malformed card; this endpoint is itself the
// trusted, same-process caller writing on a submitter's behalf, the same
// trust boundary every other direct `db.prepare`/`db.batch` call in this
// file already uses for `bug_reports` itself.
const CONTROL_ROOM_BUG_REPORT_POSTED_BY = 'bug-report';

// #2720's own card needs the ring-buffer/WebGL context inline (so a
// session triaging the board can act on a report "without needing
// separate D1/R2 lookups" per the issue's own wording) -- `note` is the
// board's existing free-text write-up field (rendered in the card's own
// thread once expanded, same as a session's own progress note), so this
// formats the informational fields #2718 already captures into one
// readable block rather than inventing new control_room_tasks columns for
// a single kind. Bounded to the same 20,000-character cap
// controlRoomTextValue enforces for every other `note` write (this one
// bypasses that validation, being a direct write, but a renderStateBuffer
// of unbounded size from a malformed/malicious client shouldn't be able to
// blow up this row the same way MAX_METADATA_JSON_BYTES above already
// guards the request itself).
const CONTROL_ROOM_NOTE_MAX_LENGTH = 20000;
function bugReportControlRoomNote({ webglRenderer, webglVendor, userAgent, platform, submittedAt, renderStateBuffer }) {
  const lines = [];
  if (webglRenderer || webglVendor) {
    lines.push(`WebGL renderer: ${webglRenderer || '(unknown)'}${webglVendor ? ` (${webglVendor})` : ''}`);
  }
  if (userAgent) lines.push(`User agent: ${userAgent}`);
  if (platform) lines.push(`Platform: ${platform}`);
  if (submittedAt) lines.push(`Submitted: ${submittedAt}`);
  lines.push(`Render-state buffer (${renderStateBuffer.length} sample${renderStateBuffer.length === 1 ? '' : 's'}, ~1Hz, camera/avatar state + shader uniforms):`);
  lines.push(JSON.stringify(renderStateBuffer, null, 2));
  let note = lines.join('\n');
  if (note.length > CONTROL_ROOM_NOTE_MAX_LENGTH) {
    note = `${note.slice(0, CONTROL_ROOM_NOTE_MAX_LENGTH - 1)}…`;
  }
  return note;
}

// Generous ceiling above a typical canvas.toBlob('image/png') capture of a
// single browser viewport (well under 1MB for most window sizes) -- same
// "reject an accidentally-huge upload before it reaches R2" reasoning as
// worker/lib/storage.js's own MAX_MODEL_BYTES, just a much smaller number
// since this is one screenshot, not an arbitrary 3D asset.
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

// The raw `metadata` field (JSON text) is checked against this before
// ever being JSON.parse'd -- #2717's own ring buffer is bounded to ~60
// samples (~1Hz over ~60s), so a well-behaved client's payload is tiny;
// this is the server's own backstop against a malformed or malicious
// caller sending something unbounded.
const MAX_METADATA_JSON_BYTES = 256 * 1024;

// Same per-IP-throttle shape as model-upload/signup/password-reset
// (worker/lib/rate-limit.js's own header comment) -- this endpoint is
// deliberately unauthenticated-callable (see handleFeedbackBugReportCreate
// below), so without this an anonymous caller could loop it to burn
// through the FEEDBACK bucket's (free-tier) storage and the bug_reports
// table for no legitimate reason.
const FEEDBACK_BUG_REPORT_RATE_LIMIT_MAX = 20;

// Same 280-character cap this codebase already applies to every other
// free-text comment/reason/note field (reviews, dispute reasons, chat
// text -- see worker/lib/reputation.js, worker/lib/social.js and others),
// since a bug-report description is the same kind of short free-text
// comment as those, not a multi-paragraph write-up like a Control Room
// note.
const MAX_TEXT_FIELD_LENGTH = 280;

// Shared by every optional string field #2718's own metadata payload
// carries (description, webglRenderer, webglVendor, userAgent, platform,
// submittedAt) -- each is informational/display-only (#2720's own Control
// Room surfacing), so a missing or blank value is just null, not a 400,
// but a present-and-wrong-shaped one is still rejected rather than
// silently coerced.
function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(`${field} must be a string`, 400);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw new HttpError(`${field} must be ${maxLength} characters or fewer`, 400);
  }
  return trimmed;
}

// POST /api/feedback/bug-report -- deliberately unauthenticated (resolves
// the submitting user from the session cookie if one exists, purely for
// display; never requires one). #2718's own UI already allows submitting
// while logged out (`userId: currentAuthUser?.userId ?? null`), and
// requiring a login here would silently reject exactly the reports an
// anonymous or not-yet-verified visitor most needs to be able to send.
// The client's own claimed `metadata.userId` is never trusted for this --
// same "resolve your own identity from the session, never a client-
// supplied id" rule every other owner-attributed row in this codebase
// already follows (see worker/lib/auth.js's own requireSessionBuilder
// comment).
export async function handleFeedbackBugReportCreate(request, env, db) {
  const user = await currentUser(request, db);
  await checkRateLimit(db, `feedback-bug-report:${clientIp(request)}`, FEEDBACK_BUG_REPORT_RATE_LIMIT_MAX);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new HttpError('Expected multipart/form-data', 415);
  }
  const form = await request.formData().catch(() => {
    throw new HttpError('Request body is not valid multipart/form-data', 400);
  });

  const metadataRaw = form.get('metadata');
  if (typeof metadataRaw !== 'string') {
    throw new HttpError('Expected a "metadata" field in the form data', 400);
  }
  if (metadataRaw.length > MAX_METADATA_JSON_BYTES) {
    throw new HttpError(`metadata is ${formatBytes(metadataRaw.length)}, over the ${formatBytes(MAX_METADATA_JSON_BYTES)} limit`, 413);
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataRaw);
  } catch {
    throw new HttpError('metadata is not valid JSON', 400);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new HttpError('metadata must be a JSON object', 400);
  }

  const description = optionalText(metadata.description, 'description', MAX_TEXT_FIELD_LENGTH);
  const webglRenderer = optionalText(metadata.webglRenderer, 'webglRenderer', MAX_TEXT_FIELD_LENGTH);
  const webglVendor = optionalText(metadata.webglVendor, 'webglVendor', MAX_TEXT_FIELD_LENGTH);
  const userAgent = optionalText(metadata.userAgent, 'userAgent', MAX_TEXT_FIELD_LENGTH);
  const platform = optionalText(metadata.platform, 'platform', MAX_TEXT_FIELD_LENGTH);
  const submittedAt = optionalText(metadata.submittedAt, 'submittedAt', 64);
  // #2717's own buffer shape is display-only (#2720) and never queried on
  // here -- same "not deeply schema-validated" treatment this codebase
  // already gives admin_action_log.detail_json and control_room_tasks'
  // own sub_issue_summaries. Only a defensive array-type fallback, so a
  // malformed client payload degrades to "no buffer" rather than storing
  // something #2720's own rendering can't rely on being iterable.
  const renderStateBuffer = Array.isArray(metadata.renderStateBuffer) ? metadata.renderStateBuffer : [];

  const reportId = `report-${crypto.randomUUID()}`;

  // screenshot is optional -- src/feedback/submitFeedbackUI.js's own
  // openFeedbackModal already tolerates a capture failure (toBlob
  // unsupported, etc.) and submits without one rather than blocking the
  // rest of the report.
  let screenshotUrl = null;
  const screenshot = form.get('screenshot');
  if (screenshot !== null) {
    if (typeof screenshot.arrayBuffer !== 'function') {
      throw new HttpError('"screenshot" field must be a file', 400);
    }
    if (screenshot.size > MAX_SCREENSHOT_BYTES) {
      throw new HttpError(`Screenshot is ${formatBytes(screenshot.size)}, over the ${formatBytes(MAX_SCREENSHOT_BYTES)} limit`, 413);
    }
    if (!env.FEEDBACK) throw new HttpError('R2 binding FEEDBACK is not configured', 500);
    const bytes = await screenshot.arrayBuffer();
    await env.FEEDBACK.put(screenshotKey(reportId), bytes, { httpMetadata: { contentType: 'image/png' } });
    screenshotUrl = `/api/feedback/bug-reports/${reportId}/screenshot`;
  }

  // #2720: the Control Room card this report also becomes, in the SAME
  // atomic write as the bug_reports row below -- no window where a report
  // exists in one table but not the other. `bug-report-<uuid>` (not
  // `report-<uuid>`, this row's own reportId) keeps the two ids visually
  // distinct while still pairing them 1:1 via the shared uuid, matching
  // this board's existing id-prefix convention (issue-N/pr-N/feedback-id).
  const controlRoomTaskId = `bug-report-${reportId.slice('report-'.length)}`;
  const now = new Date().toISOString();
  const controlRoomTitle = description || 'Bug report (no description)';
  const controlRoomNote = bugReportControlRoomNote({ webglRenderer, webglVendor, userAgent, platform, submittedAt, renderStateBuffer });

  await db.batch([
    db.prepare(`
      INSERT INTO bug_reports (
        report_id, user_id, screenshot_url, description, webgl_renderer, webgl_vendor,
        user_agent, platform, render_state_buffer_json, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      reportId, user?.user_id ?? null, screenshotUrl, description, webglRenderer, webglVendor,
      userAgent, platform, JSON.stringify(renderStateBuffer), submittedAt,
    ),
    // Same sequential "N<n>" display numbering every other message-shaped
    // (no GitHub issue/PR behind it) Control Room card already gets --
    // see handleControlRoomTaskCreate's own autoAssignNoteNumber comment
    // (worker/lib/control-room.js) for why a stable, referenceable id
    // matters here, not just for feedback/question cards.
    db.prepare(`
      INSERT INTO control_room_tasks (
        task_id, kind, note_number, title, status, session, posted_by,
        note, note_updated_at, note_author, image_url, created_at, updated_at
      ) VALUES (?, 'bug-report', (SELECT COALESCE(MAX(note_number), 0) + 1 FROM control_room_tasks), ?, 'queued', '', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      controlRoomTaskId, controlRoomTitle, CONTROL_ROOM_BUG_REPORT_POSTED_BY,
      controlRoomNote, now, CONTROL_ROOM_BUG_REPORT_POSTED_BY, screenshotUrl, now, now,
    ),
  ]);

  return json({ reportId }, 201);
}

function screenshotKey(reportId) {
  return `bug-reports/${reportId}.png`;
}

// GET /api/feedback/bug-reports/:reportId/screenshot -- admin-gated, not
// public. #2715's own body flags (as a still-open owner question, not yet
// resolved) that these screenshots could incidentally capture other
// users' in-world content, so the conservative default until a retention/
// moderation policy is decided is the same "operational data, not
// something an ordinary session has business reading" bar
// worker/lib/models.js's own handleModelListing/handleModelStorage already
// hold admin-only tooling to.
export async function handleFeedbackBugReportScreenshot(request, env, db, reportId) {
  await requireAdmin(request, db);
  if (!env.FEEDBACK) throw new HttpError('R2 binding FEEDBACK is not configured', 500);
  const row = await db.prepare('SELECT screenshot_url FROM bug_reports WHERE report_id = ?').bind(reportId).first();
  if (!row || !row.screenshot_url) return json({ error: 'Not found' }, 404);
  const object = await env.FEEDBACK.get(screenshotKey(reportId));
  if (!object) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Admin-only (see above), so unlike MODELS' public /uploads/* this is
  // never meant for a shared/CDN cache -- "private" rather than "public".
  // Still safe to cache indefinitely once fetched: a report's screenshot
  // is written once at submission time and never updated afterward.
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

export async function handleFeedback(request, env, db, route) {
  if (request.method === 'POST' && route.length === 2 && route[1] === 'bug-report') {
    return handleFeedbackBugReportCreate(request, env, db);
  }
  if (request.method === 'GET' && route.length === 4 && route[1] === 'bug-reports' && route[3] === 'screenshot') {
    return handleFeedbackBugReportScreenshot(request, env, db, route[2]);
  }
  return json({ error: 'Not found' }, 404);
}
