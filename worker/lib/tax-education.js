// #2842 (sub-issue of #2841, docs/SPEC.md §7): jurisdiction-keyed tax
// education content — storage + admin-editable UI only. Surfacing this
// content to builders (#2843) and deciding who authors/reviews it (#2844,
// owner judgment) are separate sub-issues; every route here is
// requireAdmin-gated, same bar as the rest of public/admin-dashboard.html.
import { json, HttpError } from './http.js';
import { readJson, stringValue, labelValue } from './validation.js';
import { requireAdmin, requireCurrentUser } from './auth.js';
import { getUserTaxJurisdiction } from './seller-payouts-tax.js';
import { checkRateLimit } from './rate-limit.js';
import { adminActionLogStatement } from './admin-log.js';

const TAX_EDUCATION_BODY_MAX_LENGTH = 20000;
// #2973: every other requireAdmin-gated mutation across the codebase also
// rate-limits itself (being admin-gated doesn't exempt it -- see e.g.
// seller-payouts-tax.js's own comment to that effect) and logs to
// admin_action_log; these three handlers were the one outlier. Split by
// action, same shape as world-generation.js's land-candidate handlers --
// create gets a higher ceiling since bulk-authoring many jurisdictions'
// worth of content in one sitting is a normal admin workflow here, unlike
// update/delete.
const TAX_EDUCATION_CREATE_RATE_LIMIT_MAX = 30;
const TAX_EDUCATION_UPDATE_RATE_LIMIT_MAX = 20;
const TAX_EDUCATION_DELETE_RATE_LIMIT_MAX = 20;

function taxEducationBodyValue(value, field) {
  const text = stringValue(value, field);
  if (text.length > TAX_EDUCATION_BODY_MAX_LENGTH) {
    throw new HttpError(`${field} must be ${TAX_EDUCATION_BODY_MAX_LENGTH} characters or fewer`, 400);
  }
  return text;
}

// ISO 3166-1 alpha-2 only — every entry is scoped to at least a country.
// Normalized to uppercase so "us"/"US" don't create two effectively-
// duplicate entries a lookup would have to reconcile.
function countryCodeValue(value, field) {
  const code = stringValue(value, field).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new HttpError(`${field} must be a 2-letter country code`, 400);
  return code;
}

// State/province code — looser than countryCode since subdivision code
// formats vary by country (US states are 2 letters, but this shouldn't
// hard-code US's own format as the only one #2843 will ever need).
function stateCodeValue(value, field) {
  const code = stringValue(value, field).toUpperCase();
  if (!/^[A-Z0-9-]{1,10}$/.test(code)) {
    throw new HttpError(`${field} must be 1-10 letters, digits, or hyphens`, 400);
  }
  return code;
}

function taxEducationContentFromRow(row) {
  return {
    id: row.content_id,
    countryCode: row.country_code,
    stateCode: row.state_code,
    title: row.title,
    body: row.body,
    reviewed: row.reviewed_at != null,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function handleTaxEducation(request, env, db, route, url) {
  if (route.length === 1) {
    if (request.method === 'GET') return handleTaxEducationList(request, db, url);
    if (request.method === 'POST') return handleTaxEducationCreate(request, db);
    return json({ error: 'Not found' }, 404);
  }
  // #2843: checked before the generic contentId branch below -- 'mine' is
  // a fixed route segment, not a client-suppliable content_id (those are
  // always `tax-edu-<uuid>`, so this never collides with a real one).
  if (route.length === 2 && route[1] === 'mine') {
    if (request.method === 'GET') return handleTaxEducationMine(request, env, db);
    return json({ error: 'Not found' }, 404);
  }
  if (route.length === 2) {
    const contentId = route[1];
    if (request.method === 'GET') return handleTaxEducationGet(request, db, contentId);
    if (request.method === 'PATCH') return handleTaxEducationUpdate(request, db, contentId);
    if (request.method === 'DELETE') return handleTaxEducationDelete(request, db, contentId);
    return json({ error: 'Not found' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}

// #2843's own scope: surface reviewed content matching the CALLING user's
// own jurisdiction, resolved from their own already-on-file W-9/W-8BEN
// (getUserTaxJurisdiction, worker/lib/seller-payouts-tax.js) rather than
// collecting a new location signal. requireCurrentUser (not requireAdmin)
// -- any authenticated account can read this, same bar as GET /api/tax/
// summary and every other "read my own account's tax state" endpoint.
// Returns only the public-facing fields (no reviewedBy/reviewedAt/
// createdAt/updatedAt -- those are admin-authoring metadata, not
// something an ordinary reader of their own matched content needs, and
// reviewedBy in particular is the reviewing admin's own email).
async function handleTaxEducationMine(request, env, db) {
  const user = await requireCurrentUser(request, db);
  const jurisdiction = await getUserTaxJurisdiction(env, user);
  if (!jurisdiction) return json({ entries: [], jurisdiction: null });
  // state_code = ? matches a state-specific entry; state_code IS NULL
  // matches a country-wide one regardless of the caller's own state (or
  // lack of one) -- a binding of NULL makes the first half of the OR
  // always false, which is exactly "no state-specific match possible,
  // fall through to country-wide" when jurisdiction.state is itself null.
  const { results } = await db.prepare(`
    SELECT * FROM tax_education_content
    WHERE reviewed_at IS NOT NULL AND country_code = ? AND (state_code = ? OR state_code IS NULL)
    ORDER BY state_code IS NULL ASC, updated_at DESC
    LIMIT 50
  `).bind(jurisdiction.country, jurisdiction.state).all();
  return json({
    entries: results.map((row) => ({
      id: row.content_id, countryCode: row.country_code, stateCode: row.state_code, title: row.title, body: row.body,
    })),
    jurisdiction,
  });
}

async function handleTaxEducationList(request, db, url) {
  await requireAdmin(request, db);
  const countryCode = url.searchParams.get('countryCode');
  const conditions = [];
  const bindings = [];
  if (countryCode !== null) {
    conditions.push('country_code = ?');
    bindings.push(countryCodeValue(countryCode, 'countryCode'));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await db.prepare(
    `SELECT * FROM tax_education_content ${where} ORDER BY updated_at DESC LIMIT 500`,
  ).bind(...bindings).all();
  return json({ entries: results.map(taxEducationContentFromRow) });
}

async function handleTaxEducationGet(request, db, contentId) {
  await requireAdmin(request, db);
  const row = await db.prepare('SELECT * FROM tax_education_content WHERE content_id = ?').bind(contentId).first();
  if (!row) return json({ error: 'Entry not found' }, 404);
  return json({ entry: taxEducationContentFromRow(row) });
}

async function handleTaxEducationCreate(request, db) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `tax-education-create:${admin.user_id}`, TAX_EDUCATION_CREATE_RATE_LIMIT_MAX);
  const body = await readJson(request);
  const contentId = `tax-edu-${crypto.randomUUID()}`;
  const countryCode = countryCodeValue(body.countryCode, 'countryCode');
  const stateCode = body.stateCode ? stateCodeValue(body.stateCode, 'stateCode') : null;
  const title = labelValue(body.title, 'title');
  const text = taxEducationBodyValue(body.body, 'body');
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO tax_education_content (content_id, country_code, state_code, title, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(contentId, countryCode, stateCode, title, text, now, now).run();
  await adminActionLogStatement(db, admin.user_id, 'create_tax_education', 'tax_education_content', contentId).run();
  const row = await db.prepare('SELECT * FROM tax_education_content WHERE content_id = ?').bind(contentId).first();
  return json({ entry: taxEducationContentFromRow(row) }, 201);
}

async function handleTaxEducationUpdate(request, db, contentId) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `tax-education-update:${admin.user_id}`, TAX_EDUCATION_UPDATE_RATE_LIMIT_MAX);
  const existing = await db.prepare('SELECT * FROM tax_education_content WHERE content_id = ?').bind(contentId).first();
  if (!existing) return json({ error: 'Entry not found' }, 404);

  const body = await readJson(request);
  const fields = [];
  const values = [];
  const setIfPresent = (column, value) => { fields.push(`${column} = ?`); values.push(value); };

  if (body.countryCode !== undefined) setIfPresent('country_code', countryCodeValue(body.countryCode, 'countryCode'));
  if (body.stateCode !== undefined) setIfPresent('state_code', body.stateCode ? stateCodeValue(body.stateCode, 'stateCode') : null);
  if (body.title !== undefined) setIfPresent('title', labelValue(body.title, 'title'));
  if (body.body !== undefined) setIfPresent('body', taxEducationBodyValue(body.body, 'body'));
  // Marking an entry reviewed stamps the CALLING admin's own identity —
  // same shape as Control Room's settingWaitingOnOwner recording `caller`,
  // never a client-supplied name, so this can't be spoofed as reviewed by
  // someone else. Un-reviewing (reviewed: false) clears both columns,
  // matching the SPEC requirement that review gates whether an entry is
  // live at all, not just a display flag.
  if (body.reviewed !== undefined) {
    if (body.reviewed) { setIfPresent('reviewed_at', new Date().toISOString()); setIfPresent('reviewed_by', admin.email); }
    else { setIfPresent('reviewed_at', null); setIfPresent('reviewed_by', null); }
  }

  const now = new Date().toISOString();
  setIfPresent('updated_at', now);
  const result = await db.prepare(`UPDATE tax_education_content SET ${fields.join(', ')} WHERE content_id = ?`)
    .bind(...values, contentId).run();
  if (result.meta.changes === 0) return json({ error: 'Entry not found' }, 404);
  // Logged only after the update is confirmed to have actually happened —
  // a log row for an action that didn't happen (e.g. a concurrent delete
  // won the race) would misattribute it to this admin.
  await adminActionLogStatement(db, admin.user_id, 'update_tax_education', 'tax_education_content', contentId).run();

  const row = await db.prepare('SELECT * FROM tax_education_content WHERE content_id = ?').bind(contentId).first();
  return json({ entry: taxEducationContentFromRow(row) });
}

async function handleTaxEducationDelete(request, db, contentId) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `tax-education-delete:${admin.user_id}`, TAX_EDUCATION_DELETE_RATE_LIMIT_MAX);
  const result = await db.prepare('DELETE FROM tax_education_content WHERE content_id = ?').bind(contentId).run();
  if (result.meta.changes === 0) return json({ error: 'Entry not found' }, 404);
  await adminActionLogStatement(db, admin.user_id, 'delete_tax_education', 'tax_education_content', contentId).run();
  return json({ deleted: true });
}
