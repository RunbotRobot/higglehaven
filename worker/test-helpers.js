// Shared test scaffolding for worker/*.test.js — split out of what used to
// be one single worker/index.test.js (see issue #385: that file's ever-
// growing, single-D1-instance test count started crashing the CI unit-
// tests job outright with "Maximum call stack size exceeded" once total
// suite size crossed some threshold, not from any one test's own bug).
// @cloudflare/vitest-pool-workers gives each test *file* its own D1/worker
// isolate (not each test), so splitting the one file into several — each
// under vitest.config.js's own `worker/**/*.test.js` include pattern —
// resets that accumulation at each file boundary instead of letting it
// grow across the entire suite in one shared instance.
//
// Every split file still needs its own top-level `let adminSession` and
// `beforeAll` (each file gets a fresh D1, so each needs its own admin
// signup + migrations) — those aren't shared here, only the stateless
// helpers that don't close over anything file-local.
import { env, SELF } from 'cloudflare:test';

export async function api(path, options = {}) {
  const response = await SELF.fetch(`https://higglehaven.test/api${path}`, {
    ...options,
    // Found via #362: several IP-keyed rate limits (checkRateLimit calls
    // bucketed by clientIp(request) alone — sign posts, purchases, and
    // now builders/sellers/catalog) all fall back to a shared 'unknown'
    // clientIp when no cf-connecting-ip header is set. Every call in this
    // suite that doesn't explicitly set one used to collide on that same
    // bucket by accident — harmless while only a handful of tests hit a
    // rate-limited endpoint, but it broke outright once catalog-template
    // creation (used as ordinary fixture setup in dozens of unrelated
    // tests, e.g. "Simulated purchases"' own createTemplate) started
    // being rate-limited too: enough of those calls shared one bucket to
    // trip the limit well before any single test's own real behavior
    // exhausted it. Defaulting every call to its own random synthetic IP
    // isolates unrelated tests from each other by default, the same way
    // two different real-world clients would never share a bucket;
    // a test that deliberately wants several calls to share one bucket
    // (every existing rate-limit test above already does this) still
    // can, by passing its own explicit cf-connecting-ip header, which
    // takes precedence here.
    headers: {
      'cf-connecting-ip': `test-${crypto.randomUUID()}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  return { response, body: await response.json() };
}

export function extractSessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/hh_session=([^;]+)/);
  return match ? match[1] : null;
}

export function withSession(token, options = {}) {
  return { ...options, headers: { ...options.headers, cookie: `hh_session=${token}` } };
}

// username is required at signup (migrations/0056_username_required_unique.sql)
// and unique, so tests that don't care what it is (most of them — only a
// handful actually assert on the chosen username) get a fresh random one
// by default rather than needing to invent one at every call site; `extra`
// can still override it for the tests that do care.
export async function signup(email, password, extra = {}) {
  // #556: signup now requires age attestation — every test account signs up
  // as an adult by default so this doesn't need repeating at every call
  // site; a test specifically exercising the attestation requirement itself
  // overrides it via `extra`.
  const body = { email, password, username: `user-${crypto.randomUUID().slice(0, 8)}`, ageAttested: true, ...extra };
  const result = await api('/auth/signup', { method: 'POST', body: JSON.stringify(body) });
  // #556: requireSessionBuilder/requireSessionSeller (worker/index.js's own
  // assertVerified) now reject any session whose trust_tier is still
  // 'none' — the owner's "force everyone through, no grandfathering"
  // decision applies to every account. Stripe is never configured in this
  // test suite (see stripeConfigured's own comment), so the real
  // card-setup-intent/confirm-card round trip can't be used to clear that
  // bar here the way a real signup would. Test accounts get trust_tier
  // stamped directly instead, the same shortcut ageAttested above already
  // takes, so the hundreds of existing builder/seller-action tests don't
  // each need their own bypass — a test that specifically exercises the
  // unverified-session gate itself signs up its own account and skips this
  // (see worker/reviews-auth.test.js's "Authentication" describe block).
  if (result.response.ok) {
    await env.DB.prepare("UPDATE users SET trust_tier = 'credit_card' WHERE email = ?").bind(email).run();
  }
  return result;
}

// Signs up a fresh account and returns its auto-provisioned builder profile
// along with a `session()` helper for attaching that account's cookie to
// any request — the standard way tests act "as" a particular builder now
// that builderId can no longer be passed in directly.
export async function signupBuilder(label) {
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const signedUp = await signup(email, 'a fine long password here', { username: label });
  const sessionToken = extractSessionCookie(signedUp.response);
  const me = await api('/builders/me', withSession(sessionToken));
  return {
    email,
    sessionToken,
    builderId: me.body.builder.builderId,
    builder: me.body.builder,
    session: (options) => withSession(sessionToken, options),
  };
}

// Same idea for sellers. A seller profile is lazily created per user
// independent of the builder one, so this can layer on top of a fresh
// signup rather than needing its own account-creation path.
export async function signupSeller(label) {
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const signedUp = await signup(email, 'a fine long password here', { username: label });
  const sessionToken = extractSessionCookie(signedUp.response);
  const me = await api('/sellers/me', withSession(sessionToken));
  return {
    email,
    sessionToken,
    sellerId: me.body.seller.sellerId,
    seller: me.body.seller,
    session: (options) => withSession(sessionToken, options),
  };
}

// `adminSession` is per-file (each file signs up its own admin against its
// own fresh D1 — see each file's own beforeAll), so this takes it as a
// parameter rather than closing over a shared one. Every call site keeps
// its original `createGreenbeltLandlet(landletId)` shape via a one-line
// local wrapper in each file: `(id) => createGreenbeltLandletAs(adminSession, id)`.
// `center` is optional (omitted, every caller before #570 gets the same
// origin-default body as always) — worker-api.test.js's own land-candidates
// tests are the one caller that now needs its fixture landlets spread out
// in space, since #570's new overlap check means a real landlet sitting at
// the literal world origin is no longer a neutral position.
export async function createGreenbeltLandletAs(adminSession, landletId, center) {
  return api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({
      landletId,
      name: `Test ${landletId}`,
      areaM2: 1000,
      status: 'greenbelt',
      ...(center ? { center } : {}),
    }),
  }));
}

export function glbFile({ version = 2, declaredLength, json = '{}' } = {}) {
  const encoded = new TextEncoder().encode(json);
  const chunkLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(20 + chunkLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, declaredLength ?? bytes.length, true);
  view.setUint32(12, chunkLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(encoded, 20);
  bytes.fill(0x20, 20 + encoded.length);
  return new File([bytes], 'chair.glb', { type: 'model/gltf-binary' });
}

// Admin status (migrations/0055_admin_role.sql) has no self-service signup
// path — this mirrors handleAdminBootstrap's real contract (sign up, then
// prove you hold ADMIN_BOOTSTRAP_SECRET) using the fixed test-env secret
// vitest.config.js configures.
export async function signupAdmin(label) {
  const account = await signupBuilder(label);
  const bootstrapped = await api('/auth/admin-bootstrap', account.session({
    method: 'POST',
    body: JSON.stringify({ secret: env.ADMIN_BOOTSTRAP_SECRET }),
  }));
  return { ...account, isAdmin: bootstrapped.body.user.isAdmin };
}
