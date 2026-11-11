// #3429 (part of #3428): access for the fleet's Claude Code sessions to the
// live site, so a session can see and use the app the way a person does.
//
// Two pieces, both inert until the Worker secret FLEET_ACCESS_KEY is set
// (removing the secret turns fleet access off):
//   1. The fleet key. A request carrying it in `x-fleet-key` passes the
//      private-preview gate as if it held the `hh_access` cookie. The owner
//      stores the same value as a network secret on the fleet's environment,
//      so the proxy adds the header and no session ever reads the value.
//   2. Fleet login. `POST /api/auth/fleet-login { name }`, only with the key,
//      signs in (creating on first use) the account for one session name.
//
// Fleet accounts are flagged (users.is_fleet) and kept out of everything that
// measures or moderates real people; see assertNotFleetAccount and the
// callers. They are never admins (a trigger in migrations/0211 enforces it).
import { json, HttpError, clientIp } from './http.js';
import { timingSafeEqual } from './crypto.js';
import { checkRateLimit, RATE_LIMIT_WINDOW_MS } from './rate-limit.js';
import { readJson, stringValue } from './validation.js';
import { createSession, sessionCookieHeader, SESSION_TTL_MS } from './auth-routes.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';

export const FLEET_KEY_HEADER = 'x-fleet-key';
export const FLEET_LOGIN_PATH = '/api/auth/fleet-login';
// The allow-list: `higglehaven` plus digits, exactly the session names
// AGENTS.md assigns. Anything else is refused, so the key cannot be used to
// mint an account under any other name (or to sign in as a real person).
export const FLEET_NAME_PATTERN = /^higglehaven[0-9]{1,3}$/;
// Wrong keys are limited per client IP, like /__access/login. A request with
// the right key is never counted, so the fleet cannot lock itself out.
const FLEET_KEY_WRONG_MAX = 10;

// 'off'    FLEET_ACCESS_KEY is not set: the header means nothing.
// 'absent' no header on the request.
// 'ok'     the header equals the key.
// 'wrong'  a header that does not equal the key (already counted against the
//          caller's budget; throws 429 once that budget is spent).
export async function fleetKeyStatus(request, env) {
  if (!env.FLEET_ACCESS_KEY) return 'off';
  const submitted = request.headers.get(FLEET_KEY_HEADER);
  if (submitted === null) return 'absent';
  const bucket = `fleet-key-wrong:${clientIp(request)}`;
  // Look before comparing: otherwise, once the budget is spent, every further
  // guess would still be compared for free and a correct one would get in.
  const spent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket_key = ? AND created_at >= ?',
  ).bind(bucket, Date.now() - RATE_LIMIT_WINDOW_MS).first();
  if ((spent?.n ?? 0) >= FLEET_KEY_WRONG_MAX) {
    await checkRateLimit(env.DB, bucket, FLEET_KEY_WRONG_MAX); // throws the 429
  }
  if (timingSafeEqual(submitted, env.FLEET_ACCESS_KEY)) return 'ok';
  await checkRateLimit(env.DB, bucket, FLEET_KEY_WRONG_MAX);
  return 'wrong';
}

// The header is a credential: nothing downstream (logs, echoed requests, a
// handler that reflects headers) should ever see it.
export function withoutFleetKey(request) {
  if (!request.headers.has(FLEET_KEY_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(FLEET_KEY_HEADER);
  return new Request(request, { headers });
}

export async function handleFleetLogin(request, env, db, url, keyOk) {
  // Invisible without the key: the same 404 any unknown route gives.
  if (!keyOk) return json({ error: 'Not found' }, 404);
  const input = await readJson(request);
  const name = stringValue(input.name, 'name');
  if (!FLEET_NAME_PATTERN.test(name)) {
    throw new HttpError('name must be a fleet session name such as higglehaven3', 400);
  }

  const now = new Date().toISOString();
  const userId = `user-${crypto.randomUUID()}`;
  // No deliverable email (.invalid is reserved and never resolves) and no
  // usable password (not a pbkdf2$ value, so no password verifies against it).
  // A fleet account counts as verified and age-attested because those checks
  // only prove a mailbox and a person; it has neither and needs neither.
  const email = `${name}@fleet.invalid`;
  await db.prepare(`
    INSERT INTO users (user_id, email, password_hash, username, email_canonical, email_verified_at, age_attested_at, is_fleet, trust_tier)
    SELECT ?, ?, 'fleet-account-no-password', ?, ?, ?, ?, 1, 'credit_card'
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ? OR email = ?)
  `).bind(userId, email, name, email, now, now, name, email).run();

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(name).first();
  // Never sign in as a real person who happens to hold this username.
  if (!user || user.is_fleet !== 1) {
    throw new HttpError('That name belongs to a regular account', 409);
  }
  // #3430: the app's verify step (age plus card) would otherwise block a fleet
  // account at its first screen, and there is no card to give. The lowest
  // verified tier clears it; also repairs an account made before this.
  if (user.trust_tier === 'none') {
    await db.prepare("UPDATE users SET trust_tier = 'credit_card' WHERE user_id = ? AND is_fleet = 1").bind(user.user_id).run();
  }
  await getOrCreateBuilderForUser(db, user);
  const token = await createSession(db, user.user_id);
  return json(
    { user: { userId: user.user_id, username: user.username, isFleet: true } },
    200,
    { 'set-cookie': sessionCookieHeader(url, token, SESSION_TTL_MS / 1000) },
  );
}

// Fleet accounts are for looking at the app, not for speaking as a person in
// it: they file no conduct reports and leave no reviews or ratings, and
// product flags carry zero weight (see handleProductFlags). Takes the user row
// (or null) and throws a plain 403.
export function assertNotFleetAccount(user, action) {
  if (user?.is_fleet === 1) {
    throw new HttpError(`A fleet account cannot ${action}.`, 403);
  }
}

// Real money never moves for a fleet account while Stripe is live.
export function stripeIsLive(env) {
  return typeof env.STRIPE_SECRET_KEY === 'string' && /^[rs]k_live_/.test(env.STRIPE_SECRET_KEY);
}
