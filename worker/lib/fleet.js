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
import { agentNameFor, FLEET_NAME_PATTERN, isFleetLoginName } from './fleet-agents.js';
export { FLEET_NAME_PATTERN };

export const FLEET_KEY_HEADER = 'x-fleet-key';
export const FLEET_LOGIN_PATH = '/api/auth/fleet-login';
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

// #3429: IP-keyed rate-limit buckets (dozens of them, all via clientIp) are
// shared by everyone behind one address. A fleet session's traffic arrives from
// the fleet's own proxy, so give it its own address space: its requests are
// counted in buckets of their own (`fleet:<ip>`) and can neither use up a real
// person's budget nor be limited by one. Only a request that already proved the
// fleet key gets this; nothing a caller sends can pick the prefix.
export const FLEET_IP_PREFIX = 'fleet:';
export function asFleetTraffic(request) {
  const headers = new Headers(request.headers);
  headers.set('cf-connecting-ip', `${FLEET_IP_PREFIX}${request.headers.get('cf-connecting-ip') || 'unknown'}`);
  return new Request(request, { headers });
}

export async function handleFleetLogin(request, env, db, url, keyOk) {
  // Invisible without the key: the same 404 any unknown route gives.
  if (!keyOk) return json({ error: 'Not found' }, 404);
  const input = await readJson(request);
  const name = stringValue(input.name, 'name');
  if (!isFleetLoginName(name)) {
    throw new HttpError('name must be a fleet session name such as higglehaven3', 400);
  }

  const now = new Date().toISOString();
  const userId = `user-${crypto.randomUUID()}`;
  // No deliverable email (.invalid is reserved and never resolves) and no
  // usable password (not a pbkdf2$ value, so no password verifies against it).
  // A fleet account counts as verified and age-attested because those checks
  // only prove a mailbox and a person; it has neither and needs neither.
  const email = `${name}@fleet.invalid`;
  // #3445: the account is found by its fleet email (stable), not by username,
  // because the username is the agent name and can change when the mapping in
  // fleet-agents.js does. It is never a name a regular account already holds.
  const username = agentNameFor(name);
  await db.prepare(`
    INSERT INTO users (user_id, email, password_hash, username, email_canonical, email_verified_at, age_attested_at, is_fleet, trust_tier)
    SELECT ?, ?, 'fleet-account-no-password', ?, ?, ?, ?, 1, 'credit_card'
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ? OR email = ?)
  `).bind(userId, email, username, email, now, now, username, email).run();

  let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  // Never sign in as a real person who happens to hold this name.
  if (!user || user.is_fleet !== 1) {
    throw new HttpError('That name belongs to a regular account', 409);
  }
  // #3430: the app's verify step (age plus card) would otherwise block a fleet
  // account at its first screen, and there is no card to give. The lowest
  // verified tier clears it; also repairs an account made before this.
  if (user.trust_tier === 'none') {
    await db.prepare("UPDATE users SET trust_tier = 'credit_card' WHERE user_id = ? AND is_fleet = 1").bind(user.user_id).run();
  }
  if (user.username !== username) {
    // A rename in the mapping: applied on this login, never onto a name
    // another account holds.
    await db.prepare(`
      UPDATE users SET username = ?
      WHERE user_id = ? AND is_fleet = 1
        AND NOT EXISTS (SELECT 1 FROM users WHERE username = ? AND user_id != ?)
    `).bind(username, user.user_id, username, user.user_id).run();
    user = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.user_id).first();
    if (user.username !== username) {
      throw new HttpError('That name belongs to a regular account', 409);
    }
  }
  const builder = await getOrCreateBuilderForUser(db, user);
  // One alias per person: the builder label follows the username.
  if (builder.label !== username) {
    await db.prepare('UPDATE builders SET label = ? WHERE user_id = ?').bind(username, user.user_id).run();
  }
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
