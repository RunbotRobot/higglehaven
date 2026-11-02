// #2529 (sub-issue of #2502, itself sub-issue of #2500): Control Room
// board/API handlers plus the admin-page/admin-action-log viewer routes
// (all requireAdmin-gated, same shape), extracted verbatim, zero behavior
// change. Unlike #2538's bundles/auctions leaf, none of this group touches
// requireSessionBuilder at all -- requireControlRoomAccess only ever needs
// currentUser (an existing is_admin session) or the CONTROL_ROOM_API_KEY
// Worker secret, so there's no circular-import blocker here.
import { json, HttpError, htmlResponse } from './http.js';
import { readJson, stringValue, labelValue, positiveInteger } from './validation.js';
import { timingSafeEqual } from './crypto.js';
import { currentUser, requireAdmin } from './auth.js';

// N31 (owner, Control Room, 2026-09-11): "I must insist that we move this
// page to a proper server-based format. That will enable a structured API
// that we write which can reject calls that don't meet the required
// criteria (caller name and message text)." The Control Room previously
// lived entirely as a Claude Artifact's own `db` capability — real
// persistent storage, but with no server-side validation: a session wrote
// straight through db.collection('tasks').doc(id).update(), so nothing
// ever stopped a bare `waitingOn: 'owner'` write with zero explanation
// (the recurring #610/#616/#653/#659 pattern the owner flagged repeatedly).
// This is that real, validating server: migrations/0082_control_room.sql
// holds the data, and every mutating call here is rejected outright —
// not just flagged after the fact — if it's missing a caller name or
// message text, or if it tries to set waitingOn to 'owner' with no reason
// attached.
//
// Two caller shapes need write access: the owner's own browser (an
// existing admin-role user session cookie, same bar as every other
// requireAdmin-gated endpoint in this file) and the ~12 autonomous Claude
// sessions that read/write this API server-to-server with no cookie at
// all. Accepting either lets the frontend page reuse the owner's existing
// login with no secret ever shipped to a browser, while sessions
// authenticate with a guarded Worker secret in a header — the same
// never-configured-in-tests convention as STRIPE_SECRET_KEY/DIDIT_API_KEY,
// so local dev and this test suite (neither ever sets
// CONTROL_ROOM_API_KEY) exercise the "no access" 401 path by default.
export async function requireControlRoomAccess(request, env, db) {
  const providedKey = request.headers.get('x-control-room-key');
  if (env.CONTROL_ROOM_API_KEY && providedKey && timingSafeEqual(providedKey, env.CONTROL_ROOM_API_KEY)) {
    return { via: 'api-key' };
  }
  const user = await currentUser(request, db);
  if (user?.is_admin) {
    // #3000: currentUser() alone doesn't know about suspension -- only
    // requireCurrentUser does (worker/lib/auth.js) -- so a bare is_admin
    // check here let a suspended admin (still is_admin=1, still holding a
    // valid session per auth.js's own comment) keep full Control Room API
    // access after handleControlRoomAdminPage would already 403 them from
    // the page itself. Same query/error shape requireCurrentUser uses.
    const activeSuspension = await db.prepare(`
      SELECT 1 FROM account_suspensions WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
    `).bind(user.user_id).first();
    if (activeSuspension) throw new HttpError('Your account is suspended', 403, { suspended: true });
    return { via: 'admin-session', user };
  }
  throw new HttpError('Control Room access required', 401);
}

// Generous length cap for a note/reply body (a session's own multi-
// paragraph write-up, or the owner's own reply) — labelValue's own
// MAX_LABEL_LENGTH (100, sized for a short display label like a template
// name) is far too tight for this. 20,000 characters is well beyond any
// legitimate write-up seen in this project's own history, just enough of
// a ceiling to keep a single row from growing unboundedly.
const CONTROL_ROOM_TEXT_MAX_LENGTH = 20000;
export function controlRoomTextValue(value, field) {
  const text = stringValue(value, field);
  if (text.length > CONTROL_ROOM_TEXT_MAX_LENGTH) {
    throw new HttpError(`${field} must be ${CONTROL_ROOM_TEXT_MAX_LENGTH} characters or fewer`, 400);
  }
  return text;
}

// #915: labelValue alone (non-empty, ≤100 chars) let a typo or casing slip
// ("Done", "in-progress") reach the control_room_tasks table, where the
// schema's own CHECK constraint (migrations/0082_control_room.sql) rejects
// it anyway -- but only with an opaque "Request violates a database
// constraint" error, not the field-scoped 400 message this file gives for
// every other rejected field. This mirrors that CHECK in application code
// purely for a caller-facing error message, same enum-check idiom already
// used elsewhere in this file (e.g. handleAuctions' own status check).
// `kind` deliberately has NO equivalent: migration 0082's own comment
// explains kind/tag are free-text on purpose ("new values have appeared
// organically over months of multi-session use; a CHECK constraint would
// just become a recurring migration tax") -- do not add one.
const CONTROL_ROOM_STATUSES = ['queued', 'in_progress', 'done'];
export function controlRoomStatusValue(value) {
  const status = labelValue(value, 'status');
  if (!CONTROL_ROOM_STATUSES.includes(status)) {
    throw new HttpError(`status must be one of ${CONTROL_ROOM_STATUSES.join(', ')}`, 400);
  }
  return status;
}

// #2830: last_reply_from feeds waitingBadge()'s own "(unexplained)" strict
// === against the literal lowercase string 'owner' (admin-control-room.html),
// but unlike waitingOn/kind (#1070/#1449/#2205) it was never normalized to
// that canonical form at write time -- a caller/from value like "Owner" or
// the owner's real name (the direct-D1-write fallback AGENTS.md documents)
// stored verbatim silently defeats the badge. Any other value (a session
// name) passes through untouched, same as waitingOn's own canonicalization.
function canonicalReplyFrom(value) {
  return value.toLowerCase() === 'owner' ? 'owner' : value;
}

export function controlRoomTaskFromRow(row) {
  return {
    id: row.task_id,
    kind: row.kind,
    number: row.number,
    noteNumber: row.note_number,
    title: row.title,
    status: row.status,
    session: row.session,
    from: row.posted_by,
    note: row.note,
    noteUpdatedAt: row.note_updated_at,
    noteAuthor: row.note_author,
    tag: row.tag,
    url: row.url,
    pr: row.pr_url,
    waitingOn: row.waiting_on,
    viewed: !!row.viewed,
    awaitingClaude: !!row.awaiting_claude,
    lastReplyFrom: row.last_reply_from,
    lastReplyAt: row.last_reply_at,
    imageUrl: row.image_url,
    subIssues: row.sub_issues ? JSON.parse(row.sub_issues) : null,
    subIssueSummaries: row.sub_issue_summaries ? JSON.parse(row.sub_issue_summaries) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function controlRoomReplyFromRow(row) {
  return {
    id: row.reply_id,
    taskId: row.task_id,
    from: row.from_caller,
    text: row.text,
    imageUrl: row.image_url,
    createdAt: row.created_at,
  };
}

// N31 option 3 (owner, Control Room, 2026-09-11: "I would like to do
// option 3. Isn't there a way to do it for free?"). Yes — this needs no
// new hosting or vendor: it's one more route on the same Cloudflare Worker
// already serving the whole game (worker/index.js's own default export),
// so it costs nothing extra to run. Serving the board same-origin (instead
// of from its own Claude Artifact origin) is what actually fixes the
// blocker 2kf6b67zlbicmreasema's own note found: the owner's existing
// hh_session admin cookie is SameSite=Lax and this Worker's CORS is
// wildcarded, so a cross-origin fetch() from the Artifact could never
// carry that cookie. A same-origin page has no such problem — the browser
// just sends it, no CORS/SameSite configuration needed at all — so this
// also means no CONTROL_ROOM_API_KEY (a secret meant to be guarded the
// same way STRIPE_SECRET_KEY is) ever has to reach browser-visible
// JavaScript the way option 1 would have required.
export async function handleControlRoomAdminPage(request, env) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  try {
    await requireAdmin(request, env.DB);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return htmlResponse(controlRoomSignInPage(error), error.status);
  }
  // The page itself (public/admin-control-room.html, a plain static file
  // Vite copies verbatim into dist/) is fetched through the same ASSETS
  // binding every other static file already uses — this route only adds
  // the requireAdmin gate in front of it, not a separate rendering path.
  return env.ASSETS.fetch(new Request(new URL('/admin-control-room.html', request.url), request));
}

function controlRoomSignInPage(error, title = 'higglehaven Control Room') {
  const message = error.status === 401
    ? 'Sign in to higglehaven as an admin in another tab, then reload this page.'
    : 'This page is admin-only.';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${title}</title>
<style>body { font: 15px/1.5 -apple-system, sans-serif; max-width: 32em; margin: 20vh auto; padding: 0 16px; color: #16240a; }</style>
</head>
<body><p>${message}</p></body>
</html>`;
}

// #996: same "gate, then hand off to a plain static file over the ASSETS
// binding" shape as handleControlRoomAdminPage above -- the browse UI for
// admin_action_log (#814/#813), never built alongside the write side.
export async function handleAdminActionLogPage(request, env) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  try {
    await requireAdmin(request, env.DB);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return htmlResponse(controlRoomSignInPage(error, 'higglehaven Admin Action Log'), error.status);
  }
  return env.ASSETS.fetch(new Request(new URL('/admin-action-log.html', request.url), request));
}

// #1818 (sub-issue of #1817): same "gate, then hand off to a plain static
// file over the ASSETS binding" shape as the two admin pages above — this
// one is just the shell/nav other #1817 sub-issues plug their own panel
// content into, not a page with real business logic of its own yet.
export async function handleAdminDashboardPage(request, env) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  try {
    await requireAdmin(request, env.DB);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return htmlResponse(controlRoomSignInPage(error, 'higglehaven Admin Dashboard'), error.status);
  }
  return env.ASSETS.fetch(new Request(new URL('/admin-dashboard.html', request.url), request));
}

export async function handleControlRoom(request, env, route, url) {
  const db = env.DB;
  if (route.length === 2 && route[1] === 'tasks') {
    if (request.method === 'GET') return handleControlRoomTasksList(request, env, db, url);
    if (request.method === 'POST') return handleControlRoomTaskCreate(request, env, db);
    return json({ error: 'Not found' }, 404);
  }
  if (route.length === 3 && route[1] === 'tasks') {
    const taskId = route[2];
    if (request.method === 'GET') return handleControlRoomTaskGet(request, env, db, taskId);
    if (request.method === 'PATCH') return handleControlRoomTaskUpdate(request, env, db, taskId);
    return json({ error: 'Not found' }, 404);
  }
  if (route.length === 4 && route[1] === 'tasks' && route[3] === 'replies') {
    const taskId = route[2];
    if (request.method === 'GET') return handleControlRoomRepliesList(request, env, db, taskId);
    if (request.method === 'POST') return handleControlRoomReplyCreate(request, env, db, taskId);
    return json({ error: 'Not found' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}

// Read access stays open to any Control Room caller with the right access
// (no per-row filtering) — this is dev-team backlog/coordination data, the
// same visibility model the shareable Artifact link already had, not
// end-user account data.
async function handleControlRoomTasksList(request, env, db, url) {
  await requireControlRoomAccess(request, env, db);
  const rawStatus = url.searchParams.get('status');
  // #986: unlike the create/update handlers' own status field (validated by
  // controlRoomStatusValue since #915), this filter went straight into the
  // WHERE clause with no check -- a typo'd status (wrong case, wrong
  // separator) silently matched zero rows instead of 400ing.
  const status = rawStatus === null ? null : controlRoomStatusValue(rawStatus);
  const query = status
    ? db.prepare('SELECT * FROM control_room_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT 500').bind(status)
    : db.prepare('SELECT * FROM control_room_tasks ORDER BY updated_at DESC LIMIT 500');
  // The query above caps at 500 rows regardless of how many actually match
  // (the admin page's own list can't usefully render more than that at
  // once) — a separate, uncapped count so the page can tell "500 tasks
  // total" from "500 of 1400, capped" instead of confusing the two (owner,
  // Control Room: the header kept reading "500 tasks total · 500 shown"
  // even as new tasks kept getting posted, since `tasks.length` is exactly
  // this same capped result set, not a real total).
  const countQuery = status
    ? db.prepare('SELECT COUNT(*) AS total FROM control_room_tasks WHERE status = ?').bind(status)
    : db.prepare('SELECT COUNT(*) AS total FROM control_room_tasks');
  const [{ results }, countRow] = await Promise.all([query.all(), countQuery.first()]);
  return json({ tasks: results.map(controlRoomTaskFromRow), total: countRow.total });
}

async function handleControlRoomTaskGet(request, env, db, taskId) {
  await requireControlRoomAccess(request, env, db);
  const row = await db.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
  if (!row) return json({ error: 'Task not found' }, 404);
  return json({ task: controlRoomTaskFromRow(row) });
}

// #1584: task_id is a client-supplied value with no character restriction
// (labelValue alone only checks length), and it's interpolated unescaped
// into several HTML attributes on the Control Room admin board -- every real
// id in use (issue-N, pr-N, note-<uuid>, feedback-<id>) already fits a plain
// alphanumeric/hyphen/underscore charset, so restrict it to that rather than
// relying solely on the rendering side to escape it correctly everywhere.
function controlRoomTaskIdValue(value, field) {
  const id = labelValue(value, field);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new HttpError(`${field} may only contain letters, numbers, hyphens, and underscores`, 400);
  }
  return id;
}

// #1460: the Control Room admin board renders url/prUrl/imageUrl fields as
// an <a href>/<img src> with only HTML-entity escaping (no scheme check) —
// labelValue alone let a "javascript:..." value through untouched, since it
// has no &<>"' characters for escapeHtml to catch. Require an actual
// http(s) URL for a field meant to be clicked as a link (url/prUrl).
function urlValue(value, field) {
  const url = labelValue(value, field);
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(`${field} must be an http:// or https:// URL`, 400);
  }
  return url;
}

// imageUrl's own real-world values aren't always absolute -- catalog
// template/avatar images elsewhere in this app (docs/API.md) are routinely a
// same-origin `/uploads/<key>` reference, e.g. from a real image-upload flow,
// not a full URL, so urlValue's http(s)-only rule would reject the
// legitimate case alongside the "javascript:..." one it's meant to catch.
function imageUrlValue(value, field) {
  const url = labelValue(value, field);
  if (/^https?:\/\//i.test(url) || url.startsWith('/uploads/')) return url;
  throw new HttpError(`${field} must be an http:// or https:// URL, or a /uploads/ path`, 400);
}

// Control Room tracking-task sub-issue links (e.g. issue-326 listing #583-
// #586) — previously only ever written by a direct D1 query (#ce3d9c55's
// own investigation), since neither handleControlRoomTaskCreate nor
// handleControlRoomTaskUpdate accepted them at all. Capped the same way
// every other array/label field in this file already is; the summary map's
// keys aren't validated against subIssues itself (a summary can outlive its
// own entry being removed from a later edit without needing both to change
// in lockstep).
const MAX_SUB_ISSUES = 50;
function subIssuesValue(value, field) {
  if (!Array.isArray(value)) throw new HttpError(`${field} must be an array of positive integers`, 400);
  if (value.length > MAX_SUB_ISSUES) throw new HttpError(`${field} must have ${MAX_SUB_ISSUES} entries or fewer`, 400);
  return value.map((n) => positiveInteger(n, field));
}

function subIssueSummariesValue(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(`${field} must be an object mapping a sub-issue number to a short summary`, 400);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SUB_ISSUES) throw new HttpError(`${field} must have ${MAX_SUB_ISSUES} entries or fewer`, 400);
  const result = {};
  for (const [key, summary] of entries) {
    if (!/^\d+$/.test(key)) throw new HttpError(`${field} keys must be sub-issue numbers`, 400);
    result[key] = labelValue(summary, field);
  }
  return result;
}

// The owner's own two required fields, direct from N31: a caller name
// (`from`) and message text (`title` — this task's own initial post, the
// same role a GitHub issue's title or a freeform note's own text plays on
// the board). Both are rejected outright by controlRoomTextValue/
// stringValue below if missing or blank, before any row is ever written —
// the actual fix, not a badge added after the fact.
async function handleControlRoomTaskCreate(request, env, db) {
  await requireControlRoomAccess(request, env, db);
  const body = await readJson(request);
  const postedBy = labelValue(body.from, 'from (caller name)');
  const title = controlRoomTextValue(body.title, 'title (message text)');
  const taskId = body.id ? controlRoomTaskIdValue(body.id, 'id') : `note-${crypto.randomUUID()}`;
  const existing = await db.prepare('SELECT task_id FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
  if (existing) throw new HttpError('A task with this id already exists', 409);

  const kind = body.kind ? labelValue(body.kind, 'kind') : 'feedback';
  const explicitNumber = body.number == null ? null : positiveInteger(body.number, 'number');
  const explicitNoteNumber = body.noteNumber == null ? null : positiveInteger(body.noteNumber, 'noteNumber');
  // Owner feedback (control room notes 9461ee39/96d6d08c, 2026-09-28): a
  // message-shaped task (no GitHub issue/PR behind it) had no visible id at
  // all -- taskNumberLabel (admin-control-room.html) already renders
  // "N" + noteNumber for exactly this case, but nothing ever populated
  // noteNumber unless the caller happened to pass one, which neither the
  // admin page's compose form nor any session's create call ever did. Auto-
  // assign the next one here instead, so every message-shaped card gets a
  // stable, referenceable id (e.g. "N42") the moment it's created, the same
  // way a GitHub-backed card already gets its issue/PR number for free.
  // #1070: compared case-insensitively -- kind/waitingOn are both
  // deliberately free-text (a GitHub-issue kind, or a "blocked on #123"
  // waitingOn value, must pass through untouched), but the two sentinel
  // values this file gates real behavior on ('feedback'/'question' here,
  // 'owner' below) need to be recognized regardless of a caller's casing,
  // or a caller who happens to write e.g. "Feedback"/"Owner" silently
  // skips the gate entirely -- exactly the N31 failure mode #909 already
  // fixed for the exact-casing case.
  const kindLower = kind.toLowerCase();
  const isMessageShaped = kindLower === 'feedback' || kindLower === 'question';
  const autoAssignNoteNumber = isMessageShaped && explicitNumber == null && explicitNoteNumber == null;
  // #2205: unlike waitingOn just below, kind itself was never reassigned to
  // the canonical lowercase form once it matched case-insensitively -- the
  // gate above worked for a casing variant (e.g. "Question"), but the
  // original mixed-case value is what got stored, and
  // admin-control-room.html's needsAnswerBadge() does a strict === against
  // the stored value, so "Needs your answer" silently never showed for a
  // case-variant question. Any other value (a genuine GitHub-issue kind)
  // passes through untouched, same as waitingOn's own canonicalization.
  const canonicalKind = kindLower === 'feedback' ? 'feedback' : kindLower === 'question' ? 'question' : kind;

  // #909: the update handler's own comment above calls its reason
  // requirement "the core of N31's own fix" -- this create path is the
  // other way a task can land at waitingOn:'owner', and until now it had
  // no equivalent guard at all, letting a brand-new task reach the board
  // already "Waiting on: Owner" with zero reply anywhere explaining why.
  // Same requirement, same atomic reply-in-the-same-write shape as update.
  //
  // #1070: normalized to the canonical lowercase sentinel (not just
  // compared case-insensitively) once it matches -- admin-control-room.html's
  // own badge/Quick-Look logic does a strict === against the STORED value
  // for all three sentinels ('owner'/'claude'/'subtasks'; #1449 extended
  // this past #1070's original owner-only scope once the other two were
  // added), so a casing variant that only passed a gate check here would
  // still render wrong on the board. Any other value (a genuine "blocked on
  // #123" task id) passes through untouched.
  let waitingOn = body.waitingOn ? labelValue(body.waitingOn, 'waitingOn') : null;
  const waitingOnLower = waitingOn?.toLowerCase();
  if (waitingOnLower === 'owner') waitingOn = 'owner';
  else if (waitingOnLower === 'claude') waitingOn = 'claude';
  else if (waitingOnLower === 'subtasks') waitingOn = 'subtasks';
  let reason = null;
  if (waitingOn === 'owner') {
    reason = controlRoomTextValue(body.reason, 'reason (message text explaining the owner block)');
  }

  const now = new Date().toISOString();
  const statements = [
    db.prepare(`
      INSERT INTO control_room_tasks
        (task_id, kind, number, note_number, title, status, session, posted_by, tag, url, pr_url,
         waiting_on, image_url, sub_issues, sub_issue_summaries, created_at, updated_at,
         last_reply_from, last_reply_at)
      VALUES (?, ?, ?, ${autoAssignNoteNumber
        ? '(SELECT COALESCE(MAX(note_number), 0) + 1 FROM control_room_tasks)'
        : '?'}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      taskId,
      canonicalKind,
      explicitNumber,
      ...(autoAssignNoteNumber ? [] : [explicitNoteNumber]),
      title,
      body.status ? controlRoomStatusValue(body.status) : 'queued',
      body.session ? labelValue(body.session, 'session') : '',
      postedBy,
      body.tag ? labelValue(body.tag, 'tag') : null,
      body.url ? urlValue(body.url, 'url') : null,
      body.prUrl ? urlValue(body.prUrl, 'prUrl') : null,
      waitingOn,
      body.imageUrl ? imageUrlValue(body.imageUrl, 'imageUrl') : null,
      body.subIssues == null ? null : JSON.stringify(subIssuesValue(body.subIssues, 'subIssues')),
      body.subIssueSummaries == null ? null : JSON.stringify(subIssueSummariesValue(body.subIssueSummaries, 'subIssueSummaries')),
      now, now,
      // #2301: waitingOn:'owner' inserts a real linked reply below (the
      // reason) -- last_reply_from/last_reply_at need to reflect that same
      // reply, same reasoning as handleControlRoomTaskUpdate's own
      // settingWaitingOnOwner branch (#2254).
      waitingOn === 'owner' ? canonicalReplyFrom(postedBy) : null,
      waitingOn === 'owner' ? now : null,
    ),
  ];
  if (waitingOn === 'owner') {
    statements.push(db.prepare(`
      INSERT INTO control_room_replies (reply_id, task_id, from_caller, text, created_at) VALUES (?, ?, ?, ?, ?)
    `).bind(`reply-${crypto.randomUUID()}`, taskId, postedBy, reason, now));
  }
  await db.batch(statements);

  const row = await db.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
  return json({ task: controlRoomTaskFromRow(row) }, 201);
}

// The core of N31's own fix. Every update requires `caller` (who's making
// this change — stored as this task's own `session`, mirroring the
// Artifact-era convention of a task's `session` field naming whichever
// Claude session currently has it, or the owner's own name). Setting
// waitingOn to 'owner' additionally requires a non-empty `reason`, written
// as a real linked reply in the SAME request — atomically, so it is
// impossible (not just discouraged) for this API to ever produce a task
// sitting at "Waiting on: Owner" with no reply anywhere explaining why,
// the exact #610/#616/#653/#659 pattern this whole migration exists to
// close. A `waitingOn` change to anything else (or a change that doesn't
// touch waitingOn at all) needs no reason — only the specific transition
// the owner has repeatedly flagged is gated.
async function handleControlRoomTaskUpdate(request, env, db, taskId) {
  await requireControlRoomAccess(request, env, db);
  const existing = await db.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
  if (!existing) return json({ error: 'Task not found' }, 404);

  const body = await readJson(request);
  const caller = labelValue(body.caller, 'caller (caller name)');

  // #1070/#1449: normalized to the canonical lowercase sentinel once it
  // matches case-insensitively, on both the incoming and already-stored
  // side -- see handleControlRoomTaskCreate's own comment on why a strict
  // === alone (against a column that's also genuinely free-text) isn't
  // enough, and on why this covers all three sentinels, not just 'owner'.
  let normalizedIncomingWaitingOn = body.waitingOn ? labelValue(body.waitingOn, 'waitingOn') : null;
  const normalizedIncomingWaitingOnLower = normalizedIncomingWaitingOn?.toLowerCase();
  if (normalizedIncomingWaitingOnLower === 'owner') normalizedIncomingWaitingOn = 'owner';
  else if (normalizedIncomingWaitingOnLower === 'claude') normalizedIncomingWaitingOn = 'claude';
  else if (normalizedIncomingWaitingOnLower === 'subtasks') normalizedIncomingWaitingOn = 'subtasks';
  // Only 'owner' gates real behavior (the required-reason check below) --
  // 'claude'/'subtasks' are purely display sentinels, so this stays scoped
  // to 'owner' alone, unlike the normalization above.
  const existingWaitingOnOwner = existing.waiting_on?.toLowerCase() === 'owner';
  const settingWaitingOnOwner = normalizedIncomingWaitingOn === 'owner' && !existingWaitingOnOwner;
  let reason = null;
  if (settingWaitingOnOwner) {
    reason = controlRoomTextValue(body.reason, 'reason (message text explaining the owner block)');
  }

  const fields = [];
  const values = [];
  const setIfPresent = (column, value) => { fields.push(`${column} = ?`); values.push(value); };

  if (body.status !== undefined) setIfPresent('status', controlRoomStatusValue(body.status));
  if (body.session !== undefined) setIfPresent('session', body.session ? labelValue(body.session, 'session') : '');
  if (body.note !== undefined) {
    setIfPresent('note', body.note ? controlRoomTextValue(body.note, 'note') : null);
    setIfPresent('note_updated_at', new Date().toISOString());
    setIfPresent('note_author', body.note ? caller : null);
  }
  if (body.tag !== undefined) setIfPresent('tag', body.tag ? labelValue(body.tag, 'tag') : null);
  if (body.prUrl !== undefined) setIfPresent('pr_url', body.prUrl ? urlValue(body.prUrl, 'prUrl') : null);
  if (body.waitingOn !== undefined) setIfPresent('waiting_on', normalizedIncomingWaitingOn);
  // #1550: settingWaitingOnOwner inserts a real linked reply below (the
  // reason) -- same reasoning as handleControlRoomReplyCreate's own reset
  // (#997), so it shouldn't leave a previously-viewed task's "New"
  // indicator hidden just because that reply arrived through this endpoint
  // instead of the dedicated POST .../replies one.
  if (settingWaitingOnOwner) setIfPresent('viewed', 0);
  else if (body.viewed !== undefined) setIfPresent('viewed', body.viewed ? 1 : 0);
  if (body.awaitingClaude !== undefined) setIfPresent('awaiting_claude', body.awaitingClaude ? 1 : 0);
  if (body.subIssues !== undefined) {
    setIfPresent('sub_issues', body.subIssues == null ? null : JSON.stringify(subIssuesValue(body.subIssues, 'subIssues')));
  }
  if (body.subIssueSummaries !== undefined) {
    setIfPresent('sub_issue_summaries', body.subIssueSummaries == null ? null : JSON.stringify(subIssueSummariesValue(body.subIssueSummaries, 'subIssueSummaries')));
  }

  const now = new Date().toISOString();
  setIfPresent('updated_at', now);
  // #2254: settingWaitingOnOwner inserts a real linked reply below (the
  // reason) -- last_reply_from/last_reply_at need to reflect that same
  // reply, same reasoning as the viewed reset above.
  if (settingWaitingOnOwner) { setIfPresent('last_reply_from', canonicalReplyFrom(caller)); setIfPresent('last_reply_at', now); }

  const statements = [
    db.prepare(`UPDATE control_room_tasks SET ${fields.join(', ')} WHERE task_id = ?`).bind(...values, taskId),
  ];
  if (settingWaitingOnOwner) {
    statements.push(db.prepare(`
      INSERT INTO control_room_replies (reply_id, task_id, from_caller, text, created_at) VALUES (?, ?, ?, ?, ?)
    `).bind(`reply-${crypto.randomUUID()}`, taskId, caller, reason, now));
  }
  await db.batch(statements);

  const row = await db.prepare('SELECT * FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
  return json({ task: controlRoomTaskFromRow(row) });
}

async function handleControlRoomRepliesList(request, env, db, taskId) {
  await requireControlRoomAccess(request, env, db);
  const { results } = await db.prepare(
    'SELECT * FROM control_room_replies WHERE task_id = ? ORDER BY created_at ASC',
  ).bind(taskId).all();
  return json({ replies: results.map(controlRoomReplyFromRow) });
}

// The other half of N31's own required criteria, applied to a reply
// directly (a reply is nothing BUT a caller name + message text, so both
// fields are unconditionally required here, not gated behind any special
// case the way handleControlRoomTaskUpdate's `reason` is).
async function handleControlRoomReplyCreate(request, env, db, taskId) {
  await requireControlRoomAccess(request, env, db);
  const task = await db.prepare('SELECT task_id, waiting_on FROM control_room_tasks WHERE task_id = ?').bind(taskId).first();
  if (!task) return json({ error: 'Task not found' }, 404);

  const body = await readJson(request);
  const fromCaller = labelValue(body.from, 'from (caller name)');
  const text = controlRoomTextValue(body.text, 'text (message text)');
  const replyId = `reply-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // #2254: AGENTS.md documents this exact auto-clear as already shipped
  // ("every reply typed into that form is always from them -- this happens
  // unconditionally") but it was never actually built against this real,
  // N31-era API -- only an owner reply to a task genuinely waitingOn them
  // clears it, same scoping as handleControlRoomTaskUpdate's own
  // settingWaitingOnOwner comparison (case-insensitive on both sides, same
  // #1070/#1449 precedent).
  const clearsWaitingOnOwner = fromCaller.toLowerCase() === 'owner' && task.waiting_on?.toLowerCase() === 'owner';

  await db.batch([
    db.prepare(`
      INSERT INTO control_room_replies (reply_id, task_id, from_caller, text, image_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(replyId, taskId, fromCaller, text, body.imageUrl ? imageUrlValue(body.imageUrl, 'imageUrl') : null, now),
    // A reply is always fresh activity worth flagging, so it also clears
    // `viewed` -- otherwise a task the owner already reviewed sits with no
    // "New" indicator even though it just got a new reply (AGENTS.md's own
    // Control Room section calls this out as the intended behavior).
    // last_reply_from/last_reply_at (#2254) record this same reply for the
    // "(unexplained)" badge check in waitingBadge().
    db.prepare(`
      UPDATE control_room_tasks
      SET updated_at = ?, viewed = 0, last_reply_from = ?, last_reply_at = ?${clearsWaitingOnOwner ? ", waiting_on = 'claude'" : ''}
      WHERE task_id = ?
    `).bind(now, canonicalReplyFrom(fromCaller), now, taskId),
  ]);

  const row = await db.prepare('SELECT * FROM control_room_replies WHERE reply_id = ?').bind(replyId).first();
  return json({ reply: controlRoomReplyFromRow(row) }, 201);
}

// #996: admin_action_log (#814) was write-only from its own first
// landing (#813's own body called an admin-facing browse UI an
// intentional, separate follow-up) -- this is that follow-up. Same
// "capped list + separate uncapped total count" shape as
// handleControlRoomTasksList, not real cursor pagination, since a few
// hundred most-recent entries is what an admin actually wants to browse
// here too.
export async function handleAdminActionLogList(request, db, url) {
  await requireAdmin(request, db);
  const actionType = url.searchParams.get('actionType');
  const targetType = url.searchParams.get('targetType');
  const adminUserId = url.searchParams.get('adminUserId');
  const targetId = url.searchParams.get('targetId');
  const conditions = [];
  const bindings = [];
  if (actionType !== null) {
    conditions.push('action_type = ?');
    bindings.push(labelValue(actionType, 'actionType'));
  }
  if (targetType !== null) {
    conditions.push('target_type = ?');
    bindings.push(labelValue(targetType, 'targetType'));
  }
  if (adminUserId !== null) {
    conditions.push('admin_user_id = ?');
    bindings.push(labelValue(adminUserId, 'adminUserId'));
  }
  // #1242: target_id was already selected/returned/displayed (below,
  // public/admin-action-log.html) but had no matching filter, unlike its
  // three siblings here -- the one audit query ("every action taken
  // against this one entity") the table exists for had no server-side way
  // to run it.
  if (targetId !== null) {
    conditions.push('target_id = ?');
    bindings.push(labelValue(targetId, 'targetId'));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [{ results }, countRow] = await Promise.all([
    db.prepare(`SELECT * FROM admin_action_log ${where} ORDER BY created_at DESC LIMIT 500`).bind(...bindings).all(),
    db.prepare(`SELECT COUNT(*) AS total FROM admin_action_log ${where}`).bind(...bindings).first(),
  ]);
  return json({ entries: results.map(adminActionLogEntryFromRow), total: countRow.total });
}

function adminActionLogEntryFromRow(row) {
  return {
    logId: row.log_id,
    adminUserId: row.admin_user_id,
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    createdAt: row.created_at,
  };
}
