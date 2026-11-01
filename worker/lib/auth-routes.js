// #2542: the actual /api/auth/* HTTP route handlers (signup, login,
// logout, delete-account, change-password, me, verify-email, request/
// reset-password, resend-verification, change-email, age-attest) --
// worker/lib/auth.js (#2528) holds the lower-level session/identity chain
// these call into (currentUser/requireCurrentUser/parseCookies/sha256Hex/
// SESSION_COOKIE_NAME); this is a different module, one layer up.
// userFromRow and cascadeDeleteAccount are imported back from
// worker/index.js itself, not from auth.js -- userFromRow is defined
// there (already exported for worker/lib/stripe.js, #2541) and used far
// more broadly than just these routes; cascadeDeleteAccount is also
// called by worker/index.js's own escalateExpiredSuspensions cron job.
//
// handleAuth itself (the /api/auth dispatcher) stays in worker/index.js
// rather than moving here, even though the issue that scoped this leaf
// named it: it also routes to handleAdminBootstrap/handleGrantAdmin/
// handleRevokeAdmin/handleListAdmins/handleSuspendAccount/
// handleUnsuspendAccount/handleSuspensionStatus (admin/suspension
// domain, not yet split out) and to card-setup/Didit/video-gen/Stripe-
// webhook handlers (#2541, already in their own worker/lib/ modules) --
// moving it here would mean importing all of those back from
// worker/index.js instead of the other way around. Same reasoning
// worker/lib/builder-profile.js's own comment gives for leaving
// handleBuilders (the /api/builders dispatcher) in worker/index.js
// (#2535).
//
// handleExportData (also named in the issue) stays too: it and its own
// exportCommerceData/exportSocialSection helpers reach into nearly every
// other domain's row-formatters (builderFromRow, sellerFromRow,
// purchaseFromRow, templateFromRow, bundleFromRow, friendshipFromRow,
// labelsByBuilderId, ownedLandletsByBuilderId, savedLayoutInstanceFromRow,
// versionInstanceFromRow) -- a GDPR data-export aggregator, not a clean
// auth-scoped handler. Flagged in this PR's own description rather than
// forced through a move that would just drag that whole surface along
// for the ride.
//
// hashPassword/generateToken/sendEmail/normalizeEmail also stay in
// worker/index.js and are imported back below -- each has a real caller
// outside this auth-routes surface (cascadeDeleteAccount's own password-
// revocation hash, a scheduled()-driven migration-drift alert email, an
// admin grant/revoke/suspend email lookup), so moving any of them here
// would mean worker/index.js importing back from here instead -- the
// same "whichever side has the one caller elsewhere keeps the shared
// helper" call #2528/#2535 already made for their own entangled helpers.
// DUMMY_PASSWORD_HASH stays for the same reason (tied to hashPassword's
// exact PBKDF2_ITERATIONS format) but is a plain const, not a function --
// workerd requires every named export of the main Worker entry module to
// be a function/class binding (#1978, same constraint
// worker/lib/builder-profile.js's own comment documents for
// D1_MAX_BOUND_PARAMETERS), so it's exported here as a getter,
// dummyPasswordHash(), instead.
import { HttpError, json, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue } from './validation.js';
import { timingSafeEqual, bytesToHex, hexToBytes } from './crypto.js';
import { turnstileConfigured, verifyTurnstileToken } from './turnstile.js';
import {
  SESSION_COOKIE_NAME, parseCookies, sha256Hex, currentUser, requireCurrentUser,
} from './auth.js';
import {
  hashPassword, generateToken, sendEmail, normalizeEmail, appBaseUrl, dummyPasswordHash, cascadeDeleteAccount,
  userFromRow,
} from '../index.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour — shorter than email verification since a leaked reset link is higher-stakes
const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const FAILED_LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iterationsText, saltHex, hashHex] = parts;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations }, key, 256,
  );
  return timingSafeEqual(bytesToHex(new Uint8Array(bits)), hashHex);
}

// Issue #200's owner decision: one real account per email, closing the
// sybil vector plain lowercasing leaves open — someone can otherwise
// register unlimited distinct accounts against one real inbox
// (`you+tag@gmail.com`, or Gmail's own dot-insensitivity:
// `first.last@gmail.com`/`firstlast@gmail.com` are the same inbox), which
// matters here specifically because of the one-claimed-landlet-per-builder
// fairness invariant. Deliberately only used to *detect* a collision at
// signup (see handleSignup) — the actual `email` column stays the plain
// lowercased address forever, so this never touches login, password
// reset, or any already-stored row.
function canonicalizeEmail(value) {
  const email = normalizeEmail(value);
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return email;
  const domain = email.slice(atIndex + 1);
  let local = email.slice(0, atIndex);
  const plusIndex = local.indexOf('+');
  if (plusIndex !== -1) local = local.slice(0, plusIndex);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replaceAll('.', '');
  }
  return `${local}@${domain}`;
}

// Deliberately permissive — "does this look roughly like an email" rather
// than a fully RFC-5322-correct pattern.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailValue(value) {
  const email = normalizeEmail(value);
  if (!EMAIL_PATTERN.test(email)) throw new HttpError('email is not a valid email address', 400);
  return email;
}

function passwordValue(value) {
  if (typeof value !== 'string') throw new HttpError('password is required', 400);
  if (value.length < 8) throw new HttpError('password must be at least 8 characters', 400);
  if (value.length > 200) throw new HttpError('password must be at most 200 characters', 400);
  return value;
}

function usernameValue(value) {
  const username = stringValue(value, 'username');
  if (username.length > 40) throw new HttpError('username must be at most 40 characters', 400);
  return username;
}

async function createSession(db, userId) {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt).run();
  return token;
}

// Mirrors checkAccessGate's own cookie-attribute reasoning (HttpOnly so
// frontend JS can never read the session token even via XSS; SameSite=Lax
// rather than a separate CSRF token, since every mutating endpoint here is
// POST and Lax cookies are already withheld from cross-site POST/fetch/
// form-submit by every modern browser; Secure omitted only for plain-http
// local dev).
function sessionCookieHeader(url, token, maxAgeSeconds) {
  const attrs = [`${SESSION_COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (url.protocol === 'https:') attrs.push('Secure');
  return attrs.join('; ');
}

function clearSessionCookieHeader(url) {
  return sessionCookieHeader(url, '', 0);
}

async function issueEmailVerification(env, db, userId, email) {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString();
  await db.prepare('INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt).run();
  const verifyUrl = `${appBaseUrl(env)}/?verifyEmail=${token}`;
  const emailSent = await sendEmail(env, {
    to: email,
    subject: 'Verify your higglehaven email',
    html: `<p>Welcome to higglehaven! Confirm your email address to finish setting up your account:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`,
    text: `Welcome to higglehaven! Confirm your email address: ${verifyUrl} (expires in 24 hours)`,
  });
  // #811: devVerifyUrl must reflect whether Resend is *configured*, not
  // whether the send happened to succeed -- same reasoning as
  // handleRequestPasswordReset's own env.RESEND_API_KEY gate below.
  return { emailSent, devVerifyUrl: env.RESEND_API_KEY ? null : verifyUrl };
}

export async function handleSignup(request, env, db, url) {
  const input = await readJson(request);
  const email = emailValue(input.email);
  const password = passwordValue(input.password);
  const username = usernameValue(input.username);

  await checkRateLimit(db, `signup:${clientIp(request)}:${email}`, 5);

  if (input.ageAttested !== true) {
    throw new HttpError('You must confirm you meet the age requirement to sign up.', 400);
  }

  // #2941: never gates the signup itself -- see turnstile.js's own
  // comment and migrations/0171's for why turnstileFailedAt stays NULL
  // (rather than recording a failure) whenever the feature is off here,
  // not just when it actually passed.
  const turnstileFailedAt = turnstileConfigured(env) && !(await verifyTurnstileToken(env, input.turnstileToken, clientIp(request)))
    ? new Date().toISOString()
    : null;

  const emailCanonical = canonicalizeEmail(email);
  const userId = `user-${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(password);
  const ageAttestedAt = new Date().toISOString();
  const inserted = await db.prepare(`
    INSERT INTO users (user_id, email, password_hash, username, email_canonical, age_attested_at, turnstile_failed_at)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ? OR email_canonical = ? OR username = ?)
  `).bind(
    userId, email, passwordHash, username, emailCanonical, ageAttestedAt, turnstileFailedAt,
    email, emailCanonical, username,
  ).run();
  if (inserted.meta.changes === 0) {
    const emailConflict = await db.prepare('SELECT 1 FROM users WHERE email = ? OR email_canonical = ?').bind(email, emailCanonical).first();
    if (emailConflict) throw new HttpError('Email is already registered', 409);
    throw new HttpError('Username is already taken', 409);
  }

  // docs/SPEC.md §3: "every user is automatically a builder — no separate
  // account types." A seller profile stays deliberately lazy instead.
  await db.prepare('INSERT INTO builders (builder_id, label, user_id) VALUES (?, ?, ?)')
    .bind(`builder-${crypto.randomUUID()}`, username, userId).run();

  const { emailSent, devVerifyUrl } = await issueEmailVerification(env, db, userId, email);
  const sessionToken = await createSession(db, userId);
  const row = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();

  return json({
    user: userFromRow(row),
    verificationEmailSent: emailSent,
    ...(devVerifyUrl ? { devVerifyUrl } : {}),
  }, 201, { 'set-cookie': sessionCookieHeader(url, sessionToken, SESSION_TTL_MS / 1000) });
}

export async function handleResendVerification(request, env, db) {
  const user = await requireCurrentUser(request, db);
  if (user.email_verified_at !== null) throw new HttpError('Email is already verified', 400);
  await checkRateLimit(db, `resend-verification:${user.user_id}`, 5);
  const { emailSent, devVerifyUrl } = await issueEmailVerification(env, db, user.user_id, user.email);
  return json({ verificationEmailSent: emailSent, ...(devVerifyUrl ? { devVerifyUrl } : {}) });
}

const CHANGE_EMAIL_RATE_LIMIT_MAX = 5;
export async function handleChangeEmail(request, env, db) {
  const user = await requireCurrentUser(request, db);
  await checkRateLimit(db, `change-email:${user.user_id}`, CHANGE_EMAIL_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new HttpError('Incorrect password', 401);
  }
  const email = emailValue(input.email);
  if (email === user.email) throw new HttpError('That is already your current email', 400);
  const emailCanonical = canonicalizeEmail(email);
  const result = await db.prepare(`
    UPDATE users SET email = ?, email_canonical = ?, email_verified_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ?
      AND NOT EXISTS (SELECT 1 FROM users WHERE (email = ? OR email_canonical = ?) AND user_id != ?)
  `).bind(email, emailCanonical, user.user_id, email, emailCanonical, user.user_id).run();
  if (result.meta.changes === 0) throw new HttpError('Email is already registered', 409);
  const { emailSent, devVerifyUrl } = await issueEmailVerification(env, db, user.user_id, email);
  const row = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.user_id).first();
  if (!row) return json({ error: 'Account no longer exists' }, 404);
  return json({ user: userFromRow(row), verificationEmailSent: emailSent, ...(devVerifyUrl ? { devVerifyUrl } : {}) });
}

const LOGIN_RATE_LIMIT_MAX = 10;

export async function handleLogin(request, db, url) {
  await checkRateLimit(db, `login:${clientIp(request)}`, LOGIN_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const email = normalizeEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';

  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const invalidCredentials = () => new HttpError('Invalid email or password', 401);
  if (!row) {
    await verifyPassword(password, dummyPasswordHash());
    throw invalidCredentials();
  }

  if (row.locked_until && row.locked_until > new Date().toISOString()) {
    throw new HttpError('Too many failed attempts. Try again in a few minutes.', 423);
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    await db.prepare(`
      UPDATE users SET
        failed_login_attempts = failed_login_attempts + 1,
        locked_until = CASE WHEN failed_login_attempts + 1 >= ? THEN ? ELSE locked_until END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ?
    `).bind(
      FAILED_LOGIN_LOCK_THRESHOLD,
      new Date(Date.now() + FAILED_LOGIN_LOCK_DURATION_MS).toISOString(),
      row.user_id,
    ).run();
    throw invalidCredentials();
  }

  await db.prepare(`
    UPDATE users SET failed_login_attempts = 0, locked_until = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ?
  `).bind(row.user_id).run();

  const sessionToken = await createSession(db, row.user_id);
  const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(row.user_id).first();
  if (!updated) return json({ error: 'Account no longer exists' }, 404);
  return json(
    { user: userFromRow(updated) },
    200,
    { 'set-cookie': sessionCookieHeader(url, sessionToken, SESSION_TTL_MS / 1000) },
  );
}

export async function handleLogout(request, db, url) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) {
    const tokenHash = await sha256Hex(token);
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  return json({ loggedOut: true }, 200, { 'set-cookie': clearSessionCookieHeader(url) });
}

const DELETE_ACCOUNT_RATE_LIMIT_MAX = 5;

export async function handleDeleteAccount(request, db, url) {
  const user = await requireCurrentUser(request, db);
  await checkRateLimit(db, `delete-account:${user.user_id}`, DELETE_ACCOUNT_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new HttpError('Incorrect password', 401);
  }

  await cascadeDeleteAccount(db, user.user_id);

  return json({ accountDeleted: true }, 200, { 'set-cookie': clearSessionCookieHeader(url) });
}

const CHANGE_PASSWORD_RATE_LIMIT_MAX = 5;

export async function handleChangePassword(request, db) {
  const user = await requireCurrentUser(request, db);
  await checkRateLimit(db, `change-password:${user.user_id}`, CHANGE_PASSWORD_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new HttpError('Incorrect password', 401);
  }
  const newPassword = passwordValue(input.newPassword);
  const passwordHash = await hashPassword(newPassword);
  const cookies = parseCookies(request.headers.get('cookie'));
  const currentTokenHash = await sha256Hex(cookies[SESSION_COOKIE_NAME]);

  await db.batch([
    db.prepare(`
      UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ?
    `).bind(passwordHash, user.user_id),
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.user_id, currentTokenHash),
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(user.user_id),
  ]);
  return json({ changed: true });
}

export async function handleMe(request, db) {
  const user = await currentUser(request, db);
  if (!user) return json({ user: null });
  // #2929: requireCurrentUser (every OTHER authenticated endpoint) throws
  // 403 for a suspended account before returning anything, so the #2031
  // in-app suspension notice (reason/grace-period-date/dispute contact,
  // fired straight to `notifications` the moment a suspension lands) was
  // never actually reachable -- not through GET /api/notifications, not
  // through any of the mode-entry flows that resolve a builder/seller
  // profile first, all of which hit that same gate before a client could
  // ever get far enough to read it. This handler is the one exception
  // (deliberately plain currentUser, not requireCurrentUser, so a
  // suspended session's own login/session-restore still succeeds --
  // see this function's own pre-existing behavior/tests) and therefore
  // the one reliable place to surface it: same field shape as the
  // admin-only handleSuspensionStatus above, minus the admin-internal
  // fields (evidenceNote/adminUserId) this isn't the account owner's to see.
  const activeSuspension = await db.prepare(`
    SELECT reason, grace_period_ends_at FROM account_suspensions
    WHERE user_id = ? AND lifted_at IS NULL AND escalated_at IS NULL
  `).bind(user.user_id).first();
  return json({
    user: {
      ...userFromRow(user),
      ...(activeSuspension ? {
        suspension: { reason: activeSuspension.reason, gracePeriodEndsAt: activeSuspension.grace_period_ends_at },
      } : {}),
    },
  });
}

const AGE_ATTEST_RATE_LIMIT_MAX = 20;

export async function handleAgeAttest(request, db) {
  const user = await requireCurrentUser(request, db);
  await checkRateLimit(db, `age-attest:${user.user_id}`, AGE_ATTEST_RATE_LIMIT_MAX);
  const input = await readJson(request);
  if (input.ageAttested !== true) {
    throw new HttpError('You must confirm you meet the age requirement to continue.', 400);
  }
  if (user.age_attested_at === null) {
    await db.prepare(`
      UPDATE users SET age_attested_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ?
    `).bind(new Date().toISOString(), user.user_id).run();
  }
  const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.user_id).first();
  if (!updated) return json({ error: 'Account no longer exists' }, 404);
  return json({ user: userFromRow(updated) });
}

const EMAIL_VERIFY_RATE_LIMIT_MAX = 20;

export async function handleVerifyEmail(request, db) {
  await checkRateLimit(db, `email-verify:${clientIp(request)}`, EMAIL_VERIFY_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const token = stringValue(input.token, 'token');
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(`
    SELECT * FROM email_verification_tokens
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first();
  if (!row) throw new HttpError('Verification link is invalid or has expired', 400);

  const result = await db.prepare(`
    UPDATE email_verification_tokens SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE token_hash = ? AND consumed_at IS NULL
  `).bind(tokenHash).run();
  if (result.meta.changes !== 1) throw new HttpError('Verification link is invalid or has expired', 400);

  await db.prepare(`
    UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ?
  `).bind(row.user_id).run();
  return json({ verified: true });
}

export async function handleRequestPasswordReset(request, env, db, ctx) {
  const input = await readJson(request);
  const email = normalizeEmail(input.email);

  await checkRateLimit(db, `password-reset:${clientIp(request)}:${email}`, 5);

  const row = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

  let devResetUrl = null;
  if (row) {
    const token = generateToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    await db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(tokenHash, row.user_id, expiresAt).run();
    const resetUrl = `${appBaseUrl(env)}/?resetPassword=${token}`;
    const emailPayload = {
      to: email,
      subject: 'Reset your higglehaven password',
      html: `<p>Someone requested a password reset for this higglehaven account. If that was you:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
      text: `Reset your higglehaven password: ${resetUrl} (expires in 1 hour). If you didn't request this, ignore this email.`,
    };
    if (env.RESEND_API_KEY) {
      ctx.waitUntil(sendEmail(env, emailPayload).catch((error) => {
        console.error('Password reset email failed', error);
      }));
    } else {
      const emailSent = await sendEmail(env, emailPayload);
      if (!emailSent) devResetUrl = resetUrl;
    }
  }
  return json({ requested: true, ...(devResetUrl ? { devResetUrl } : {}) });
}

const PASSWORD_RESET_CONSUME_RATE_LIMIT_MAX = 20;

export async function handleResetPassword(request, db) {
  await checkRateLimit(db, `password-reset-consume:${clientIp(request)}`, PASSWORD_RESET_CONSUME_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const token = stringValue(input.token, 'token');
  const newPassword = passwordValue(input.newPassword);
  const tokenHash = await sha256Hex(token);

  const row = await db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first();
  if (!row) throw new HttpError('Reset link is invalid or has expired', 400);

  const result = await db.prepare(`
    UPDATE password_reset_tokens SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE token_hash = ? AND consumed_at IS NULL
  `).bind(tokenHash).run();
  if (result.meta.changes !== 1) throw new HttpError('Reset link is invalid or has expired', 400);

  const passwordHash = await hashPassword(newPassword);
  await db.batch([
    db.prepare(`
      UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ?
    `).bind(passwordHash, row.user_id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(row.user_id),
  ]);
  return json({ reset: true });
}
