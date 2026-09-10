# higglehaven backend API

This document describes the current dev-only Cloudflare Worker + D1 API contract.
It is meant to keep backend and frontend work aligned while higglehaven moves
from browser `localStorage` placeholders toward persistent data.

## Scope and assumptions

- Real account auth (signup/login, session cookies) and a real seller/builder
  identity model are built and live — see "Authentication," "Authorization
  model," and "Builders" below. Payments, multiplayer, and moderation are
  still dev-only/simulated today — that's an open gap against docs/SPEC.md,
  not a scope boundary this backend is meant to stay behind. See AGENTS.md's
  "Proposing big feature work" for how this project picks that kind of work
  up.
- Internal names use plain `a` (`land`, `landlet`) even when display copy may
  eventually use accented customer-facing strings. The currency term
  (`higgle`/`higgles`) has no "a" at all, so this split doesn't apply to it —
  it's spelled identically everywhere.
- Coordinates and dimensions are decimal meters. Placed object positions use the
  current client convention: `x`/`y` are ground-plane coordinates and `z` is
  vertical.
- The Worker serves JSON under `/api/*` and falls back to Cloudflare static
  assets for all non-API routes.
- `starter-landlet` is the default landlet when none is specified — real land
  selection (claiming any greenbelt landlet) and per-session builder ownership
  both exist; `starter-landlet` just remains the fallback identifier for
  requests that don't name one.

## Local and Cloudflare setup

The Worker expects a D1 binding named `DB` and an Assets binding named `ASSETS`.
Wrangler configuration lives in `wrangler.jsonc`.

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

`db:migrate:remote` applies the migrations to the configured Cloudflare D1
instance. If a new D1 database is created, update the `database_id` in
`wrangler.jsonc` before deploying.

## Response conventions

Successful responses are JSON objects. Collection endpoints wrap arrays under a
plural key; single-record endpoints wrap the record under a singular key.

Errors use this shape:

```json
{
  "error": "Human-readable error message"
}
```

Malformed JSON and recognized D1 constraint failures are treated as client
errors rather than generic server failures. Duplicate resources return `409`,
foreign-key conflicts return `409`, and database check violations return `400`.
Raw SQL and internal D1 error details are never included in API responses.

The Worker currently sets permissive CORS headers for dev use.

## Health endpoint

### `GET /api/health`

Returns a simple health payload confirming that the Worker API route is live.

Response:

```json
{
  "ok": true,
  "service": "higglehaven-api"
}
```

## Authentication

Real accounts (docs/SPEC.md's login system, resolved: email + password —
the mainstream-standard baseline, chosen over a magic-link-only or
OAuth-only flow because it's the most universally familiar to a general
audience and needs no third-party app registration to work). This is the
first genuinely unforgeable identity concept in this app — see
`migrations/0053_users_auth.sql` for the full schema rationale.

**Linked to builders/sellers:** `migrations/0054_link_builders_sellers_to_users.sql`
adds `user_id` to both, and Build/Sell mode now require a real, logged-in
account to enter at all — see "Builders"/"Sellers" below for the full
get-or-create contract (`GET /api/builders/me`/`GET /api/sellers/me`) and
what happened to the old free-text dev-mode picker.

**Password storage:** PBKDF2-SHA256 via the Workers runtime's own Web
Crypto (`hashPassword`/`verifyPassword` in `worker/index.js`) — no
external dependency and no WASM build needed, unlike bcrypt/scrypt, which
aren't natively available in this runtime. Stored as a self-describing
`pbkdf2$<iterations>$<saltHex>$<hashHex>` string so the iteration count
can be raised later for newly-set passwords without invalidating or
needing to migrate passwords hashed under an older count. Password rules
follow NIST 800-63B's current guidance: a reasonable minimum length (8
characters) rather than forced complexity rules, which tend to push people
toward predictable substitutions instead of real entropy.

**Sessions:** a signed-nothing, opaque 256-bit random token, handed to the
browser as an `HttpOnly`, `SameSite=Lax` cookie (`hh_session`) — the exact
same cookie-attribute reasoning `ACCESS_PASSPHRASE`'s private-preview gate
above already uses, including `Secure` being added only when the request
is HTTPS (never on plain-http local dev). Only a SHA-256 hash of the token
is ever stored server-side (`sessions.token_hash`), the same
defense-in-depth reasoning applied to passwords: a leaked/dumped D1
snapshot alone shouldn't be enough to hijack a live session, only a leaked
*cookie* should be. One row per logged-in device/browser, not one row per
user — logging out on a phone doesn't sign a laptop out too, and "sign out
everywhere" (used on password reset) is just a `DELETE FROM sessions WHERE
user_id = ?`. No separate CSRF token is used: every mutating endpoint here
is `POST`, and `SameSite=Lax` cookies are already withheld by every modern
browser from cross-site `POST`/`fetch`/form-submit requests, which is the
actual CSRF threat model for a cookie-authenticated API.

**Brute-force defense:** `users.failed_login_attempts`/`locked_until`,
checked and updated on every login attempt — no Durable Object or external
rate-limiter needed. Five consecutive failures locks the account for 15
minutes (`423 Locked`); a successful login resets the counter. Deliberately
symmetric with password reset: resetting a password also clears the
lockout, since proving control of the email is a stronger signal than
whatever guessing produced the lockout.

**Rate limiting:** `checkRateLimit` in `worker/index.js` (migrations/0057)
guards `POST /api/auth/signup` and `POST /api/auth/request-password-reset`
— the two auth endpoints that are both unauthenticated/repeatable and (once
`RESEND_API_KEY` is configured, below) can trigger a real outbound email to
an arbitrary address. `POST /api/auth/login` doesn't need this — it
already has the account-level lockout described above — and
`resend-verification` requires an existing session, so it isn't an
anonymous abuse vector either. A plain D1 table (no Durable Object or
Cloudflare rate-limiting binding needed, matching the brute-force
defense's own reasoning) tracks attempts in a bucket keyed by client IP
*and* the specific email being targeted, fixed 15-minute window, 5
attempts per bucket; the 6th within the window gets `429`. Bucketing by
target email (not IP alone) is deliberate: it stops repeated
harassment/retry-hammering of one address without needing any per-source
global counter that a shared IP (or this app's own automated test suite,
which never sets a real client IP) could trip on unrelated traffic. It
does **not** stop an attacker spraying signups across many distinct
addresses from one source — that broader case is already substantially
covered today by the private-preview access-gate passphrase below (these
endpoints are unreachable at all without it), and would need something
like Cloudflare Turnstile/Bot Management if that gate ever comes off, not
just a bigger version of this.

The same `checkRateLimit` helper also guards `POST /api/models` (see
"Custom model uploads" below) — a different unauthenticated/repeatable
endpoint with a different abuse shape: it doesn't send email, but each call
can burn shared R2 storage headroom, so it's bucketed by client IP alone
(no per-target email to key on), 20 attempts per 15-minute window.

It also guards `POST /api/instances/:instanceId/purchase` (see "Simulated
purchases" below), bucketed by client IP alone, 30 attempts per 15-minute
window — the one other public, repeatable endpoint that credits real state
(a builder's `higgles_balance_cents`/`higgles_earnings_events`, which feeds
land cap) with no shopper account of any kind to otherwise attribute or
throttle by.

**Email delivery:** [Resend](https://resend.com)'s REST API, via
`sendEmail` in `worker/index.js` — chosen for a simple, well-documented API
and a free tier generous enough for this stage. Configure it with:

```sh
npx wrangler secret put RESEND_API_KEY
```

(a Worker secret, never committed — the same pattern `ACCESS_PASSPHRASE`
already uses.) Optionally also set a `from` address via the `EMAIL_FROM`
variable (defaults to `higglehaven <no-reply@higglehaven.com>`) — Resend
requires the domain in that address to be verified in your Resend account,
so this needs to match whatever domain you've actually verified there.

**Building an absolute link (`APP_BASE_URL`):** the verify-email/
password-reset links these emails carry need a real, absolute base URL —
and neither `new URL(request.url).origin` nor the raw `Host` header can be
trusted for this, confirmed by hand: `wrangler dev --local` fully
simulates this project's configured custom-domain `routes`
(`wrangler.jsonc`), rewriting both to `higglehaven.com` even for a request
that actually arrived at `localhost:8787`, so there's no way to recover
"what host did this really arrive at" from inside the Worker in local dev.
`appBaseUrl(env)` in `worker/index.js` sidesteps this entirely: an
optional `APP_BASE_URL` var/secret overrides the default; left unset, it
falls back to this app's one real production address
(`https://higglehaven.com`, matching `routes`). Local dev sets
`APP_BASE_URL=http://localhost:8787` in `.dev.vars` (gitignored,
wrangler's standard mechanism for exactly this kind of local-only
override — see that file for the actual local value) so links built
during local testing are actually reachable.

**Dev-mode fallback:** whenever `RESEND_API_KEY` isn't configured — true
for local dev and the entire automated test suite, neither of which ever
sets it — `sendEmail` quietly returns `false` instead of making a network
call, and the affected endpoints fall back to returning the verification/
reset link directly in the API response (`devVerifyUrl`/`devResetUrl`)
instead of emailing it. This is the same "dev-mode" spirit already used
throughout this codebase, and it's what keeps the entire signup → verify →
login → reset flow fully testable without a real email provider.

### `POST /api/auth/signup`

```json
{ "email": "ada@example.com", "password": "correct horse battery staple", "username": "Ada", "ageAttested": true }
```

`ageAttested` must be exactly `true` — `400` otherwise (#556, docs/SPEC.md
§6's registration gate). A plain attestation checkbox, not a birthdate
collection or age verification; the account's `trustTier` (below) is what
actually gates real-money/social-feature access, raised separately via
`POST /api/auth/confirm-card` or (once government-ID verification exists)
its own endpoint. Counted against the rate limit below the same as every
other rejection on this endpoint — a cheap validation failure isn't a free
way to probe past the limiter.

`email` is normalized (trimmed, lowercased) and validated against a
deliberately permissive pattern — "does this look roughly like an email,"
not a full RFC-5322 parser, since the only real validation of an address
is actually receiving mail at it, which email verification already does.
`409` if that email is already registered (revealing a duplicate email
here is common, accepted practice — unlike the password-reset-request
endpoint below, which deliberately stays silent about whether an account
exists). Also `409`, with the same message, if a **canonicalized** form of
the email collides with an existing account (issue #200): a `+tag` suffix
is stripped for every domain (a de facto standard most major providers
honor, not just Gmail), and — Gmail/`googlemail.com` specifically, since
this is genuinely a Gmail-only quirk, not a general one — dots in the
local part are also folded (`first.last@gmail.com` and
`firstlast@gmail.com` are the same inbox there). This only ever blocks a
*new* signup from colliding with an existing account; it's a one-way gate,
not a retroactive merge — accounts already registered before this existed
(under the old lowercase-only normalization) are untouched and keep
logging in/resetting exactly as before, matched by the same literal
address they always have been. `429` after 5 attempts against the same
email within 15 minutes (see "Rate limiting" above). `password` must be
8–200 characters.
`username` is required (how
users identify each other, not a cosmetic label), at most 40 characters,
and must be unique — `409` if it's already taken, case-insensitively
("Ada" and "ada" are the same username).

Creates the account, logs it in immediately (sets the `hh_session`
cookie — no separate login step needed right after signup), and kicks off
email verification:

```json
{
  "user": { "userId": "user-...", "email": "ada@example.com", "username": "Ada", "emailVerified": false, "ageAttested": true, "trustTier": "none", "cardFunding": null, "createdAt": "...", "updatedAt": "..." },
  "verificationEmailSent": true
}
```

`verificationEmailSent` is `false` (with a `devVerifyUrl` field added
instead) whenever the dev-mode fallback above kicks in.

### `POST /api/auth/age-attest`

```json
{ "ageAttested": true }
```

Session-gated (`401` without one). Lets an existing account attest age
after the fact — signup's own `ageAttested` checkbox only covers brand-new
accounts; every account created before #556 existed has `ageAttestedAt:
null` and no other way to clear it. `ageAttested` must be exactly `true`
— `400` otherwise. Idempotent: attesting again on an already-attested
account is a no-op, not an error. Returns `{ "user": { ... } }`, same
shape as signup's.

### `POST /api/auth/card-setup-intent` and `POST /api/auth/confirm-card`

Session-gated (`401` without one). #556's credit-card half of the
registration gate: collecting a card and reading Stripe's own
`card.funding` costs nothing beyond the Stripe account this app already
has for seller Connect payouts and checkout — no charge is ever created.

`POST /api/auth/card-setup-intent` takes no body and creates a Stripe
`SetupIntent`, returning
`{ "clientSecret": "seti_..._secret_...", "publishableKey": "pk_...", "simulated": false }`
for the frontend to confirm client-side with Stripe.js Elements. If Stripe
isn't configured on this deployment (`STRIPE_SECRET_KEY` unset), returns
`{ "clientSecret": null, "publishableKey": null, "simulated": true }`
instead of `503` — see below.

```json
{ "paymentMethodId": "pm_..." }
```

`POST /api/auth/confirm-card` reads back the PaymentMethod the frontend
just confirmed and checks its `card.funding`: `"credit"` raises the
account's `trustTier` to `"credit_card"`; `"debit"`/`"prepaid"` is
rejected with `400` (SPEC §6's own reasoning: those are too accessible to
minors to serve as an age signal). `cardFunding` is recorded on the
account either way, so a rejected attempt is still visible on the
account rather than a silent no-op.

**Simulated fallback when Stripe isn't configured:** every builder/seller
action now requires `trustTier != "none"` (see "Builders"/"Sellers"
below), not just newly created accounts (owner decision, Control Room
2026-09-09: "force everyone through the new gates, no grandfathering
in"). A deployment with no Stripe keys at all (local dev, the test suite,
or a fresh install before the platform owner adds real keys) would
otherwise have no way to ever clear that gate. Same silent
simulated-fallback convention this app already uses for real-money
purchases and seller-payout onboarding when Stripe isn't configured:
`card-setup-intent` returns `simulated: true` with nothing to collect, and
`confirm-card` (called with no `paymentMethodId`, or any body at all) sets
`trustTier` to `"credit_card"` directly, no real card ever checked. A real
deployment with `STRIPE_SECRET_KEY` set never sees this path.

### Age/credit-card verification gates builder and seller actions

Every builder-owned or seller-owned mutation (claiming a landlet, placing
an instance, creating a product, etc. — see "Builders"/"Sellers" sections
below) requires the session's account to have both `ageAttestedAt` set and
`trustTier != "none"`, not just a valid session. An account that hasn't
cleared this gate gets `403` with
`{ "error": "...", "verificationRequired": true }` — the extra field lets
the frontend distinguish this from an ordinary ownership/permission `403`.
Account-level endpoints stay reachable regardless (`GET
/api/builders|sellers/me`, `age-attest`, `card-setup-intent`,
`confirm-card`, logout) since a session needs them to clear the gate in
the first place. Shopping (browsing, buying, reviewing, sign-posts) needs
no account at all, so it's unaffected either way.

### `POST /api/auth/didit-verification-session`, `GET /api/auth/didit-verification-status`, `POST /api/auth/didit-webhook`

#589 (sub-issue of #556)'s government-ID verification tier, via
[Didit](https://didit.me/): the higher trust tier above `"credit_card"`,
raising `trustTier` to `"id_verified"`.

`POST /api/auth/didit-verification-session` is session-gated (`401`
without one), takes no body, and starts a fresh Didit-hosted verification
session for the requesting builder, returning
`{ "sessionId": "...", "url": "https://verify.didit.me/..." }` — the
frontend opens `url` for the builder to complete verification there.
`400` if the account is already `"id_verified"`. `503` if Didit isn't
configured on this deployment (`DIDIT_API_KEY` unset).

`GET /api/auth/didit-verification-status` is session-gated and returns
`{ "status": "none" | "pending" | "approved" | "declined" }` for the
requesting builder's most recent verification session. While still
`pending` and Didit is configured, this reconciles directly against
Didit's own session-decision endpoint (rather than only trusting the
webhook below to have already landed), so a builder who already finished
verification isn't stuck reading "pending" if the webhook is slow.

`POST /api/auth/didit-webhook` is Didit's own server-to-server delivery
of a verification result — unauthenticated (no session cookie to check),
verified instead via an HMAC-SHA256 signature over the raw request body
(`x-signature` header, keyed by `DIDIT_WEBHOOK_SECRET`), `401` on a
missing or wrong signature. `503` if `DIDIT_WEBHOOK_SECRET` isn't
configured. Idempotent against a repeat delivery for the same session —
only the first delivery (webhook or a status poll, whichever gets there
first) applies the resulting `trustTier` change.

### `POST /api/auth/login`

```json
{ "email": "ada@example.com", "password": "correct horse battery staple" }
```

`401` with an identical, generic "Invalid email or password" message
whether the email doesn't exist or the password is wrong — telling the two
apart would let an attacker enumerate which emails have accounts here.
`423` if the account is currently locked out (see "Brute-force defense"
above). On success, sets a fresh `hh_session` cookie (a genuinely new
session, not a reused one) and returns `{ "user": { ... } }`, same shape as
signup's response.

### `POST /api/auth/logout`

No body. Deletes the current session (if any) and clears the cookie.
Always `200 { "loggedOut": true }`, even with no session present —
idempotent by design.

### `GET /api/auth/me`

Deliberately always `200`, never a `401` — even with no cookie or an
expired/unknown one, which returns `{ "user": null }` rather than an
error. This is the frontend's own "is anyone logged in" check, called
unconditionally on every page load; a 4xx status here would log a
browser-level "Failed to load resource" console message for the
overwhelmingly common "nobody's logged in yet" case — not something
application code can suppress, and something every automated test's
shared console-error collector would then read as a real page error, on
every single page load, regardless of whether the test has anything to do
with auth. (This bit us for real — see this section's own Testing note.)
Returns `{ "user": { ... } }` once actually logged in.

### `POST /api/auth/verify-email`

```json
{ "token": "..." }
```

The token from a verification email's link (or `devVerifyUrl` in dev
mode). `400` if it's invalid, already consumed, or past its 24-hour
expiry. On success, sets `email_verified_at` and returns
`{ "verified": true }`. Tokens are single-use — stored hashed
(`email_verification_tokens.token_hash`), the same reasoning as sessions
above, and marked consumed rather than deleted so a replay attempt is
still detectable as "already used" rather than silently "not found."

### `POST /api/auth/request-password-reset`

```json
{ "email": "ada@example.com" }
```

Always `200 { "requested": true }`, regardless of whether that email has
an account — this is the classic account-enumeration vector, so unlike
signup it stays deliberately generic. `429` after 5 attempts against the
same email within 15 minutes (see "Rate limiting" above) — the one place
this endpoint's response isn't generic, but only in the sense that an
attacker learns "this specific address has been requested 5 times
recently," not whether it has an account. A real account gets a reset email
(or, in dev mode, the response gains a `devResetUrl` field carrying the
link directly — this is the one place the generic response quietly
differs, but only in dev mode, and only in a way an attacker could already
infer from "this dev/test deployment has no email provider configured,"
not from anything about the specific email address).

### `POST /api/auth/reset-password`

```json
{ "token": "...", "newPassword": "a brand new password" }
```

The token from a reset email's link (or `devResetUrl`). `400` if invalid,
already consumed, or past its 1-hour expiry (shorter than email
verification's 24 hours, since a leaked reset link is higher-stakes).
`newPassword` follows the same 8–200 character rule as signup. On success:
updates the password, clears any lockout, marks the token consumed, and —
deliberately — deletes every existing session for that account, signing
out every device. If the reset was prompted by a compromised password, an
attacker riding an existing session loses it too.

### `POST /api/auth/resend-verification`

No body — requires a valid session cookie (`401` without one). `400` if
the account is already verified. Otherwise issues a brand-new verification
token (the original one, if the first email never arrived, is left alone
and still valid — resending never invalidates it) and returns the same
`{ "verificationEmailSent": ..., "devVerifyUrl"?: ... }` shape signup does.

### Testing note

`worker/reviews-auth.test.js`'s "Authentication" describe block owns the full
contract: signup/login/logout, session-cookie behavior (a fresh session
per login, logging out one device leaving others intact), duplicate-email
and malformed-input rejection, case-insensitive email matching, identical
wrong-password/unknown-email responses, the five-attempt lockout, the full
email-verification lifecycle (valid/invalid/reused token), resending
verification (requires a session, a no-op once already verified, doesn't
invalidate the original token), the full password-reset lifecycle
(valid/invalid/reused token, old sessions invalidated, old password
rejected afterward), and rate limiting on signup/request-password-reset
(the 6th attempt against one email within the window is `429`, a
different email isn't affected). All of it runs against the
dev-mode fallback (no `RESEND_API_KEY` in the test environment) — the
actual Resend network call itself is the one part of this that can't be
exercised by the automated suite, since that would require a real API key
and would depend on an external service being reachable during `npm test`.

Also covered by `e2e/auth.test.mjs`: the full real-UI signup → verify-email
link → logout → login and forgot-password → reset link → reset → old-
password-rejected loops, driven through `#account-auth-btn`/`#auth-modal`
exactly the way a real visitor would. This is also where a real, easy-to-
miss regression first surfaced: `GET /api/auth/me` originally returned
`401` for "nobody's logged in," which is called unconditionally on every
page load — every one of the 20 e2e test files failed at once the first
time this shipped, not because anything they actually check broke, but
because Chrome logs a "Failed to load resource" console message for any
non-2xx fetch response, and every test file's shared console-error
collector (`e2e/helpers.mjs`) reads that as a real page error regardless
of which test it is. Fixed by making `/auth/me` always `200` (see its own
section above) — a good example of why "does this add a new page-load-time
network call" is worth asking before adding one, quite apart from whatever
that call's own status code conventionally "should" be.

A second, genuinely subtle bug surfaced while testing Build mode's new
login requirement (see "Builders" below): reloading a page that was
already in Build mode with a perfectly valid session cookie still popped
the login modal open, every time. Root cause was a race between two
independent top-level `async` calls in `src/main.js` — the one that
resolves `currentAuthUser` via `GET /api/auth/me`, and `bootstrap()`,
which (for Build/Sell) calls `ensureBuilderIdentity()` and checks
`currentAuthUser` synchronously. Neither awaited the other, so on a fresh
page load `bootstrap()`'s check routinely ran before the `/auth/me` round
trip had resolved, reading `currentAuthUser` as still `null` regardless of
whether the cookie was valid. Fixed by storing the auth-check IIFE's
promise (`authInitPromise`) and having `bootstrap()` await it before
touching `currentAuthUser` — but only on the Build/Sell path, not before
Shop mode's own `startMode === 'shop'` branch, since Shop mode is
deliberately never held up by a network round trip (see its own comment
on rendering instantly). This is exactly the kind of intermittent,
load-order-dependent bug that a fresh-every-page-load flow (no persisted
session to race against) would never surface — caught only because a real
e2e reload-into-Build scenario exercises the actual race window.

## Authorization model

Real accounts (above) only prove *who you are* — a session cookie. Every
mutating endpoint below that acts on a builder's or seller's own data goes
one step further: it derives "who is performing this action" from that
session, and never trusts a client-supplied `builderId`/`sellerId` for that
purpose, even though most endpoints still accept and return those ids
(they're real, stable identifiers — just not something a caller can claim
to be).

Two shapes of check recur throughout this document:

- **Acting-identity fields are session-derived, not request-supplied.**
  Anywhere an endpoint used to read a `builderId`/`sellerId`/
  `requesterBuilderId` out of the request body to mean "as whom," it now
  ignores that field (or never accepted one in the first place) and uses
  `requireSessionBuilder`/`requireSessionSeller` internally instead — the
  caller's own linked builder/seller profile, resolved from the session
  cookie, get-or-created on first use exactly like `GET /builders/me` /
  `GET /sellers/me` do. A field that references *someone else* (e.g. a
  friend request's `recipientBuilderId`, or a landlet's `templateId`) is
  not affected — those stay ordinary request fields, since naming a target
  isn't a claim of identity.
- **Existing-resource ownership is checked against the session, not
  re-assignable.** Anywhere an endpoint mutates or deletes a resource that
  already has an owner (a landlet, a catalog template with a seller, a
  bundle, a notification, a placed instance via the landlet it sits on),
  the caller must be that owner's own session — a `403` results otherwise.
  Ownership itself can never be reassigned through a generic update either
  (a landlet's `ownerBuilderId`, a template's `sellerId` are force-
  preserved regardless of what the request body sends); transferring
  ownership only ever happens through the specific flows built for it
  (claim, auction resolution).

A resource with **no** owner yet (an unclaimed/generating landlet, a
catalog template created with no `sellerId`) stays open to unauthenticated
requests for the handful of admin/world-gen/system-tooling paths that only
ever operate on those — see each endpoint's own note below for whether it
applies.

A third case, alongside "session-derived" and "existing-owner": a small
set of world-generation *tooling* endpoints — manual `/api/world` settings
edits, and all of `/api/land-candidates*`/`/api/land-candidate-rings*` —
require a real **admin** account (`users.is_admin`, see "Admin role"
below), not just any logged-in session. These are troubleshooting/manual
operations; the day-to-day mechanism that actually keeps land claimable
(expanding the world, generating new rings) now runs automatically on a
schedule — see "Automatic world growth" under "World settings" below —
rather than through any HTTP request a session could gate at all.

Every endpoint section below notes its own specific rule inline; this
section is just the shared vocabulary for reading those notes.

### Admin role

`migrations/0055_admin_role.sql` adds `users.is_admin`. There is no
self-service way to become one — no signup checkbox, no promotion via any
other endpoint — only:

### `POST /api/auth/admin-bootstrap`

Requires a session (`401` without one). Request body: `{ "secret" }`.
`404` if the Worker secret `ADMIN_BOOTSTRAP_SECRET` isn't configured in
this environment at all (local dev's `.dev.vars`, or `wrangler secret put`
in production — never committed, same pattern `ACCESS_PASSPHRASE`/
`RESEND_API_KEY` already use). Rate-limited per IP (10 attempts per
window, `429` past that) — the only endpoint that grants admin privilege,
so it gets the same brute-force protection as signup/password-reset.
`403` if `secret` doesn't match it exactly.
On success, promotes the calling account to admin and returns
`{ "user": { ..., "isAdmin": true } }`. Reusable, not one-time — anyone
who currently holds the secret can promote themselves (or, by sharing it
briefly, someone else) at any time; there's deliberately no "first admin
only" ratchet. Revoking admin status has no endpoint either — rare enough
to do directly against the database.

## Builders

A shared, cross-device roster of builder profiles. `GET`/`POST` below stay
open to anyone (listing the roster or creating a fresh, unlinked row isn't
an impersonation risk), but renaming or deleting an existing builder now
requires a session logged in as that builder (`403` otherwise — see
"Authorization model" above). `migrations/0054_link_builders_sellers_to_users.sql`
adds a `user_id` column, and **every account is automatically given a
linked builder profile at signup** (docs/SPEC.md §3: "every user is
automatically a builder — no separate account types"), with its `label`
set to the account's username.

**Build mode now requires a real, logged-in account to enter at all.**
`src/main.js`'s `ensureBuilderIdentity()` — previously backed by a
free-text dev-mode picker anyone could type any name into — now blocks on
`#auth-modal` (see "Authentication" above) if nobody's logged in yet, then
calls `GET /api/builders/me` below to resolve *your* builder profile.
Closing the login prompt without signing in/up falls back to Shop mode
rather than proceeding with no identity. Pre-existing dev-mode builders
created before this migration have `user_id = NULL` and are simply
unreachable through the UI going forward (not deleted — their landlets/
placed content stay intact) — an acceptable one-time cost specifically
because this app has no real users yet; see the migration's own comment.

`builders.last_active_at` (migrations/0067) is an internal-only column,
never returned in any Builder object below — `getOrCreateBuilderForUser`
in `worker/index.js` bumps it every time a session resolves *your*
builder profile, whether that's to mutate something (claiming, placing,
bidding, publishing, ...) or just to load it (`GET /api/builders/me`, hit
on entering any mode — see "Build mode now requires a real, logged-in
account" above). Per the owner's #325 decision: "I'm inclined to count
any login as activity — even if only logging in for shopping or selling."
It's the activity signal the inactivity-triggered auction job under "Land
acquisition auctions" below runs on. `NULL` for any builder who hasn't
resolved their profile at all since this column was added, deliberately
not backfilled to any guessed value — the auction job treats `NULL` as
"not yet tracked," not "long inactive."

### `GET /api/builders/me`

Requires a session (`401` without one, the same `requireCurrentUser` gate
"Authentication" above uses). Returns the calling account's own builder
profile, auto-provisioning one if somehow missing (a defensive fallback —
signup already creates it, so this should never actually need to):

```json
{ "builder": { "builderId": "builder-...", "label": "Ada", "isPioneer": false, "pioneerRank": null, "higglesBalanceCents": 0, "landCapM2": 1000, "ownedAreaM2": 0, "createdAt": "...", "updatedAt": "..." } }
```

Idempotent — the same profile every call, never a new one.

### Builder object

```json
{
  "builderId": "builder-3c9e9c50-2b10-4ba9-b62c-2abfd48b64f7",
  "label": "Ada",
  "isPioneer": false,
  "pioneerRank": null,
  "higglesBalanceCents": 0,
  "landCapM2": 1000,
  "ownedAreaM2": 1000,
  "createdAt": "2026-08-16T00:00:00.000Z",
  "updatedAt": "2026-08-16T00:00:00.000Z"
}
```

`isPioneer`/`pioneerRank` are docs/SPEC.md §3's founding/pioneer
recognition — see "Founding/pioneer recognition" below. `higglesBalanceCents`
is docs/SPEC.md §5's land-acquisition-auction proceeds ledger — see "Land
acquisition auctions" below for what can (and can't yet) change it.
`landCapM2`/`ownedAreaM2` are "Land cap" below's cap itself and the real
ground-plus-levels total counted against it — `ownedAreaM2` is `null`
instead of a number on a response that didn't just recompute both (a
plain create/rename), never a stale or silently-wrong figure.

### `GET /api/builders`

Lists every builder, oldest first. Not paginated — this is a small,
dev-scale roster, not a growing content collection.

### `POST /api/builders`

Creates a builder, unlinked to any account (`user_id` stays `NULL`) — the
frontend never calls this directly anymore now that signup provisions a
linked profile automatically (see "Builders" above); it remains for
direct API/test use. `builderId` is optional; if omitted, the Worker
generates one.

Request body:

```json
{
  "builderId": "builder-3c9e9c50-2b10-4ba9-b62c-2abfd48b64f7",
  "label": "Ada"
}
```

`label` is required, capped at 100 characters like every other short
free-text field in this API. Returns `409` if `builderId` is already
taken. Rate-limited per client IP (`BUILDER_CREATE_RATE_LIMIT_MAX`, 20 per
window) — unauthenticated and repeatable, the same abuse-cost reasoning as
sign posts/purchases (#362, mirroring #337).

### `PUT /api/builders/:builderId`
### `PATCH /api/builders/:builderId`

Renames a builder. `label` is required. Returns `404` if the builder
doesn't exist, `403` if it isn't your own (see "Authorization model"
above) — requires a session logged in as this builder.

### `DELETE /api/builders/:builderId`

Requires a session logged in as this builder (`403` otherwise). Deletes a
builder. Whatever claimed landlet it currently owns is released
back to `greenbelt` — status, owner, and active version all reset, and its
placed instances and version history are deleted — rather than left
claimed by a builder that no longer exists. The landlet's own shape
(`polygon`/`center`) is untouched, so it's immediately claimable again,
not regenerated.

This is deliberately more destructive than a hypothetical future
inactivity-based reclaim should be: that case should clear the *active*
build but keep the builder's own version history, in case they come back
and want to recreate it on a new landlet. Deleting the builder removes the
only place that history could live, so there's nothing left to preserve.

Any `purchases` row where this builder was the hosting/earning party has
its `builderId` set to `null` rather than being deleted along with the
builder (migrations/0062) — the purchase is a different party's (the
product's seller's) sales-history record too, so it survives; see
"Refunds" below for how a refund handles a null `builderId`.

If this builder is the seller on an active auction that already has at
least one bid, deletion is rejected outright (`409`) — per policy, once an
auction has bids that decision can't be revoked, including by deleting the
account to back out of it. Without this, `auctions.seller_builder_id`'s
`ON DELETE CASCADE` (`migrations/0045_auctions.sql`) would silently remove
that auction row and every bid on it, releasing the land back to
`greenbelt` (re-claimable, including by the same person again under a
fresh auto-provisioned builder profile) at zero cost to the seller. An
active auction the builder is selling with **no** bids yet is unaffected —
it cascades away exactly as before, with the land released the normal way.

If this builder currently holds the *highest* bid on someone else's
still-active auction, deletion is likewise rejected (`409`) —
`auction_bids.bidder_builder_id`'s own `ON DELETE CASCADE` would otherwise
silently erase that bid. A leading bid actively deters every other bidder
from bidding (a new bid must strictly exceed it) for as long as it stands,
so letting it vanish via self-deletion — at zero cost, since a fresh
builder profile is auto-provisioned for the same logged-in user on their
next request — would let a bidder walk back a commitment that already
shaped how others bid. There's no bid-withdrawal feature, so a placed bid
is exactly as binding as it already implicitly is for a builder who
doesn't delete their account. A bid that's since been outbid, or that was
on an auction which has already ended (whether or not it won), doesn't
block deletion.

Response:

```json
{
  "deleted": true,
  "releasedLandletIds": ["some-landlet-id"]
}
```

Returns `404` if the builder doesn't exist.

## Founding/pioneer recognition

docs/SPEC.md §3: "permanent 'Pioneer' profile badge (grows in prestige
over time)... **Explicitly no larger starter plot for founding
builders**... Recognition stays reputational/historical only." Only the
badge itself is built — the spec's separate "founding history" page (the
real "nail-chalice" launch-day lore) isn't something a dev session can
honestly fabricate; that's real narrative content only the operator can
supply, so it's left for later as a known gap, not guessed at.

**Revised to a ranked founding cohort, not a single "first ever" winner**
(`migrations/0044_pioneer_cohort.sql`, superseding
`migrations/0043_pioneer_recognition.sql`'s original single-`is_pioneer`-
boolean design) — per explicit direction: "Pioneer status [should] extend
to a larger population of early adopters." `pioneerRank` (1, 2, 3, ...) is
granted to each builder's first-ever successful landlet claim, up to
`PIONEER_COHORT_SIZE` (100, a plain constant in `worker/index.js` — a
"founding hundred" is a common, legible round-number convention for this
kind of recognition, chosen for real early-adopter breadth without
diluting into "everyone"; adjust the constant directly if that number
ever needs tuning). `isPioneer` is a convenience boolean derived from it
(`pioneerRank !== null`) so the frontend doesn't need a null-check
everywhere it only cares about membership, not rank.

`pioneer_rank` lives on the builder, not derived live from current landlet
ownership, so the distinction survives even if that builder later releases
their land — matching "permanent." `POST /api/landlets/:id/claim` grants
the next sequential rank on a builder's first-ever claim, as long as the
cohort isn't full yet:

```sql
UPDATE builders
SET pioneer_rank = (SELECT COALESCE(MAX(pioneer_rank), 0) + 1 FROM builders)
WHERE builder_id = ? AND pioneer_rank IS NULL
  AND (SELECT COUNT(*) FROM builders WHERE pioneer_rank IS NOT NULL) < ?
```

No-ops silently once either condition fails: past the 100-builder cutoff,
or if this builder already holds a rank (claiming a second landlet after
releasing an earlier one doesn't grant a second one — the rule is "not yet
ranked," not "this exact claim is chronologically their first ever").

Deleting a ranked builder's account (`DELETE /api/builders/:id`, the only
way today to lose a claim outright) deletes that row entirely, which frees
one cohort slot for whoever claims next rather than leaving ranks
permanently sparse — a reasonable dev-mode reading given the spec's
real-world intent (real early builders, presumably permanent in practice)
doesn't have to account for one being deleted at all.

The migration backfills ranks for a world that already had claims before
this feature shipped: every already-claimed builder is ranked by how
early their first claim landed (`claimable_at`, ties broken by
`builder_id`), the same "don't erase builders who got here before this
feature existed" reasoning `migrations/0032`'s own builder-roster backfill
already follows. Implemented as `UPDATE ... FROM` over a derived
`ROW_NUMBER()` table, not a `CREATE TEMP TABLE` — D1 rejects temp-table
DDL outright with `SQLITE_AUTH`, confirmed by hand against a local D1
instance while writing this migration (window functions and
`ALTER TABLE ... DROP COLUMN`, both also used here to retire the old
`is_pioneer` column, are fine).

This app has no separate profile page, so the account panel (`#auth-modal`'s
logged-in view, `refreshAccountAuthUI` in `src/main.js` — see
"Authentication") is the closest fit: a ranked builder gets a small
"🏆 Pioneer #N" line there, fetched fresh via `GET /api/builders/me` every
time the panel opens, showing the actual rank (not just membership) so it
reads as more impressive the further the platform's real population grows
past this fixed founding hundred — the spec's own "grows in prestige over
time." (Before real login existed, this showed in the old free-text
identity roster's row instead — see migrations/0054's own comment for why
that roster no longer drives anything.) Sellers have no such concept;
`isPioneer` is simply `undefined` on a seller row, so no badge applies.

Covered by `e2e/pioneer-badge.test.mjs`: the first two claims on a fresh
world land ranks #1 and #2 (demonstrating the cohort, not a single
winner). The cutoff itself — rank stops being granted past
`PIONEER_COHORT_SIZE` — is covered by `worker/profiles.test.js` instead,
where filling 100 rows directly via the D1 binding is cheap; doing that
through 100 real browser-driven claims would not be.

### Known gaps

The spec's "founding history" page (launch-day lore) isn't built — see
this section's own opening paragraph for why.

## Sellers

A genuinely separate roster from builders — `catalog_templates.seller_id`
references these, not a builder's ID. Same shape as Builders above (shared,
cross-device roster, `GET`/`POST` open to anyone, rename/delete gated to a
session logged in as that seller), but a builder
and a seller are independent identities: uploading a product needs a
seller identity chosen, quite apart from whichever builder identity (if
any) is active. The one deliberate asymmetry from Builders:
**a seller profile is lazily provisioned on first entry to Sell mode, not
automatically at signup** — docs/SPEC.md §3 frames selling as the more
opt-in of the two ("uploading a product needs a seller identity chosen,
quite apart from whichever builder identity is active"), and there's no
reason to give every account a seller row it may never use.

### Seller object

```json
{
  "sellerId": "seller-7f3a1c20-9e44-4b7a-8c3d-1a2b3c4d5e6f",
  "label": "Ada's Shop",
  "createdAt": "2026-08-16T00:00:00.000Z",
  "updatedAt": "2026-08-16T00:00:00.000Z"
}
```

### `GET /api/sellers/me`

Requires a session (`401` without one). Returns the calling account's own
seller profile, provisioning one on first call — `label` is set to the
account's username, same as a builder profile. Idempotent afterward, same
profile every time.
**Sell mode now requires a real, logged-in account to enter at all** — the
same login-wall/fallback-to-Shop behavior "Builders" above describes for
`ensureBuilderIdentity()` applies identically to `ensureSellerIdentity()`.

### `GET /api/sellers`

Lists every seller, oldest first. Not paginated, same reasoning as
`GET /api/builders`.

### `POST /api/sellers`

Creates a seller, unlinked to any account — same reasoning as
`POST /api/builders`, kept for direct API/test use now that the frontend
provisions one automatically via `/sellers/me`. `sellerId` is optional; if
omitted, the Worker generates one.

Request body:

```json
{
  "label": "Ada's Shop"
}
```

`label` is required, capped at 100 characters. Returns `409` if a
caller-supplied `sellerId` is already taken. Rate-limited per client IP
(`SELLER_CREATE_RATE_LIMIT_MAX`, 20 per window) — same reasoning as
`POST /api/builders` (#362).

### `PUT /api/sellers/:sellerId`
### `PATCH /api/sellers/:sellerId`

Renames a seller. `label` is required. Returns `404` if the seller
doesn't exist, `403` if it isn't your own — requires a session logged in
as this seller.

### `DELETE /api/sellers/:sellerId`

Requires a session logged in as this seller (`403` otherwise). Deletes a
seller. Unlike deleting a builder, there's no owned-land release
to do — a seller owns no land — so any of its existing catalog templates
just keep their `seller_id` pointing at an ID no longer in the roster, the
same as a template that already has a `null` `seller_id` for an unclaimed
custom upload.

Response:

```json
{
  "deleted": true
}
```

Returns `404` if the seller doesn't exist.

### `GET /api/sellers/me/stripe-account`
### `POST /api/sellers/me/stripe-account`

Stripe Connect (Custom account) payout onboarding (#452) — the owner
confirmed Custom accounts for real-money seller payouts (see issue #347):
Stripe stays entirely invisible to the seller, and higglehaven's own
onboarding form submits the required KYC info directly to Stripe's
Accounts API. Onboarding, and the real-money checkout it unlocks (#453,
below), both need:

```sh
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_PUBLISHABLE_KEY
```

(Worker secrets, never committed — the same pattern `RESEND_API_KEY`
above uses.) `STRIPE_SECRET_KEY` is used server-side only;
`STRIPE_PUBLISHABLE_KEY` is handed to the browser as part of a real-money
checkout's own response (see "Real-money checkout" below) so Stripe.js can
mount a card field — it's meant to be public, the same way it's meant to
be public in any Stripe integration.

Both `GET` and `POST` here require a session (`401` otherwise) and act on
the calling account's own seller profile (lazily created the same way
`GET /sellers/me` does).

No field submitted to `POST` (legal name, DOB, SSN, bank account, etc.) is
ever stored on the seller's own row — only the resulting Stripe account id
and a derived onboarding status are kept.

`GET` response:

```json
{
  "configured": true,
  "connected": false,
  "status": "not_started",
  "requirementsCurrentlyDue": [],
  "updatedAt": null
}
```

`configured` is `false` whenever this server has no `STRIPE_SECRET_KEY`
Worker secret set (e.g. local dev, the automated test suite) — same
dev-mode-friendly pattern as `RESEND_API_KEY` elsewhere in this API.
`status` is one of `not_started`, `pending`, `requirements_due` (see
`requirementsCurrentlyDue`, Stripe's own `requirements.currently_due`
field names), `action_needed`, or `complete`.

`POST` body — individual sellers only for now (a `business_type: company`
flow is a fast-follow):

```json
{
  "individual": {
    "firstName": "Ada",
    "lastName": "Seller",
    "dobDay": 12,
    "dobMonth": 6,
    "dobYear": 1990,
    "ssnLast4": "1234",
    "addressLine1": "123 Main St",
    "addressCity": "Seattle",
    "addressState": "WA",
    "addressPostalCode": "98101",
    "addressCountry": "US"
  },
  "externalAccount": {
    "routingNumber": "110000000",
    "accountNumber": "000123456789",
    "currency": "usd"
  }
}
```

Validates every field (`400` on any missing/malformed one — e.g.
`ssnLast4` must be exactly 4 digits, `dobMonth` 1-12) before checking
whether Stripe is configured, so a caller always finds out about a bad
payload rather than a `503` masking it. Returns `503` if `STRIPE_SECRET_KEY`
isn't configured. Creates the seller's Stripe Custom account on first call,
or updates the existing one (Stripe's own account id, once assigned, is
never re-created) on every call after — the same shape as `GET`'s response,
reflecting whatever Stripe just returned.

### `GET /api/builders/me/stripe-account`
### `POST /api/builders/me/stripe-account`

Stripe Connect (Custom account) onboarding for a **builder** (#624,
sub-issue of #349/#324) — the prerequisite for redeeming a higgles balance
for real cash (see `GET`/`POST /api/builders/me/redeem` below). Identical
contract to `GET`/`POST /api/sellers/me/stripe-account` just above in
every respect (same request/response shapes, same KYC validation, same
"no PII persisted on the row itself" property, same `STRIPE_SECRET_KEY`
requirement) — acts on the calling account's own **builder** profile
instead of its seller one. A builder and a seller profile on the same
account have completely independent Stripe Connect accounts; submitting
one's onboarding never touches the other's.

### `GET /api/builders/me/redeem`
### `POST /api/builders/me/redeem`

Redeems some or all of a builder's `higglesBalanceCents` for a real-money
Stripe payout (#625, sub-issue of #349/#324) — the first real exit from
higgles to cash this codebase has. Per the owner's own Control Room answer
on #349 (2026-09-09): redemption is **not** scoped to "only what's owed in
tax" (that issue's own original framing) — it's unrestricted below the
real regulatory threshold, and blocked once that's crossed without tax
paperwork on file, reusing #615's exact gate.

**#629**: this endpoint was briefly paused after a real exploit was found
here — auction bidding used to credit the seller's higgles balance with
the full bid amount whether or not the bidder ever held it, harmless
before this endpoint existed, unbounded unbacked-cash extraction once it
did. The pause lifted once bidding itself was fixed to require and hold
both higgles balance and land cap until the bidder is outbid or the
auction closes, atomically enforced at resolution — see "Land acquisition
auctions" below.

Both require a session (`401` otherwise) and act on the calling account's
own builder profile.

`GET` response — folds in the same fields `GET .../stripe-account` returns,
plus the redemption-specific one:

```json
{
  "configured": true,
  "connected": true,
  "status": "complete",
  "requirementsCurrentlyDue": [],
  "updatedAt": "2026-09-09T23:00:00.000Z",
  "availableCents": 5000
}
```

`availableCents` is simply the builder's current `higglesBalanceCents`
(never negative) — unlike a seller's own held/available split, there's no
separate "held" pool here since nothing about a higgles balance is ever
pending release the way an unshipped physical sale is.

`POST` body — `amountCents` is optional; an empty `{}` body redeems the
full available balance:

```json
{ "amountCents": 2000 }
```

Checked in order: `400` if nothing is available at all, `400` if
`amountCents` exceeds the available balance, then the #615-style
tax-reporting-threshold gate — `403` if this account's combined gross
income for the current calendar year has already crossed
`TAX_REPORTING_THRESHOLD_CENTS` ($20,000, same constant #613/#615 use)
with no W-9/W-8BEN on file (see "Tax reporting" above). Unlike #615's own
gate, this doesn't compute a **partial** redeemable amount once close to
the line — `higglesBalanceCents` is one lifetime running total with no
per-earning-event pool to partially attribute a redemption against the
way #615's own per-purchase gross can, so this is a flat block once the
threshold is already crossed, not a partial cap. `503` if
`STRIPE_SECRET_KEY` isn't configured; `400` if Stripe onboarding
(`GET/POST .../stripe-account` above) isn't complete; `409` if the
balance changed between the request starting and the atomic debit (a
concurrent redemption already claimed some of it — safe to retry).

On success, moves the redeemed amount from the platform's own Stripe
balance into the builder's connected account (a `POST /v1/transfers`
call) and immediately triggers a real payout of it to their bank (a
`POST /v1/payouts` call against that connected account) — unlike a
seller's own sale proceeds, which land directly in their connected
account via `transfer_data` at checkout time, higgles were never sitting
in any per-builder Stripe balance to begin with, so the transfer step is
new here. Records a permanent `higgles_redemptions` row (amount, Stripe
transfer/payout ids) for reconciliation. Response:

```json
{ "redeemedCents": 2000, "stripePayoutId": "po_..." }
```

#### Testing note

`worker/stripe-connect.test.js`'s "Higgles redemption (#625)" describe
block covers everything reachable without a real Stripe account (this
suite never configures `STRIPE_SECRET_KEY`, same as every other Stripe
test in this file): the `401`s, `availableCents` reflecting the real
balance, the nothing-available and over-balance `400`s, the tax-threshold
`403`, and the `503` once past validation — confirming the balance stays
untouched in every rejected case. The actual `transfers`/`payouts` Stripe
round trip and the atomic-claim race guard aren't covered by any
automated test in this repo, the same limitation "Real-money checkout"'s
own testing note already documents for Stripe-dependent code paths.

### `GET /api/sellers/me/payouts`
### `POST /api/sellers/me/payouts`

Seller payout/cash-out (#454) — a real-money sale's proceeds
(`totalCents - commissionCents`) already land in the seller's own Stripe
Custom-account balance the instant it's charged, via the real-money
checkout's own `transfer_data` (see "Real-money checkout" below). This is
a policy-driven hold on top of that: higglehaven controls when the seller
is actually allowed to request payout of it, since a Custom account
doesn't get Stripe's own automatic payout scheduling.

Hold policy (owner-confirmed): a digital good (`metadata.digitalGoodDisclaimer`
set) pays out instantly, no hold at all — it's delivered the moment it's
bought, so there's no chargeback window where non-delivery is plausible. A
physical good holds until whichever comes first: the buyer confirms
delivery (see "Purchase delivery confirmation" below), or 7 days after the
seller marks it shipped (see "Mark purchase shipped" below) — a fallback
for exactly the case where confirmation never happens. A simulated
(higgles) purchase has no real Stripe balance at all and never appears
here.

Both require a session (`401` otherwise) and act on the calling account's
own seller profile.

`GET` response — folds in the same fields `GET .../stripe-account` returns,
plus the payout-specific ones:

```json
{
  "configured": true,
  "connected": true,
  "status": "complete",
  "requirementsCurrentlyDue": [],
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "availableCents": 4900,
  "heldCents": 9800,
  "nextEligibleAt": "2026-01-08T00:00:00.000Z"
}
```

`availableCents` is what a `POST` here would currently try to cash out;
`heldCents` is everything else still on hold. `nextEligibleAt` is the
earliest a currently-held, already-shipped purchase becomes eligible via
the 7-day fallback (`null` if nothing held has shipped yet, or nothing is
held at all) — informational only, since a buyer confirming delivery
sooner can always unlock a purchase before this date.

`POST` triggers an actual Stripe payout for whatever's currently
available. Returns `503` if `STRIPE_SECRET_KEY` isn't configured, `400` if
Stripe onboarding isn't `complete` yet, and `400` if nothing is available
(either nothing eligible, or Stripe's own funds-availability delay hasn't
cleared it on their side yet — this endpoint never requests more than
Stripe's own reported available balance for the connected account, to
avoid a payout Stripe would reject outright). Marks every purchase whose
own share fit inside the actual payout amount as paid out; a purchase
whose amount didn't fit stays available for the next request.

**Tax-reporting gate (#615, sub-issue of #350):** once this account's
combined gross income for the calendar year — higgles commissions plus
real-money sales, the same combined total `GET /api/tax/summary` (#612)
reports and `noticeLevel` (#613) warns about — reaches the
`thresholdCents` reporting threshold with no W-9/W-8BEN on file (`POST
/api/tax/id-form`, #614), this endpoint blocks access to the *excess*
above that line rather than the whole balance: a payout is capped to
whatever headroom is still under the threshold (higgles earnings consume
that headroom first, since nothing in this codebase lets a builder
spend/withdraw a higgles balance at all yet — see the next paragraph),
and returns `403` once no headroom is left, checked before the
`STRIPE_SECRET_KEY`/onboarding checks above so a caller already over the
line gets this specific error rather than an unrelated `503`/`400`
masking it. Filing paperwork removes the cap entirely, including
retroactively over past-threshold earnings already sitting unpaid.

This is a real-money-only gate for now — higgles are never gated here,
because no endpoint in this codebase currently lets a builder spend or
withdraw a higgles balance at all (an auction win never debits the
winning bidder's own balance, and #349's higgle-to-cash redemption isn't
built yet), so there's no higgles "access" action to block. `#615`'s own
scoping left this as an explicit open question to resolve once one of
those exists.

```json
{
  "payoutCents": 4900,
  "purchaseCount": 1,
  "stripePayoutId": "po_..."
}
```

### Mark purchase shipped

`POST /api/purchases/:purchaseId/mark-shipped`

Seller-initiated (there's no shipping-carrier integration to detect this
automatically) — starts the 7-day payout-hold fallback clock described
above. Requires a session logged in as this purchase's own seller (`403`
otherwise). Returns `400` if the purchase isn't real-money
(`paymentIntentId` unset), is a digital good (nothing to ship), or is
already marked shipped.

```json
{ "purchase": { "purchaseId": "...", "shippedAt": "2026-01-01T00:00:00.000Z", "...": "..." } }
```

### Purchase delivery confirmation

`POST /api/purchases/confirm-delivery`

Unauthenticated on purpose — there is no buyer account anywhere in this
app (see "Simulated purchases" below) to authenticate a "my orders" view
against. A real-money physical purchase gets an unguessable token the
instant it's finalized; only its SHA-256 hash is ever stored (same
discipline as password-reset tokens), and the raw token is handed to the
buyer exactly once, in their own checkout's finalize response (see
"Real-money checkout" below) — there's no way to retrieve it again later,
by design, so losing it just means the purchase falls back to the 7-day
post-shipping hold instead of an early release.

```json
{ "token": "..." }
```

Response: `{ "confirmed": true }`. Idempotent — confirming an
already-confirmed purchase (a second visit to the same link) is a no-op,
not an error. Returns `400` if the token doesn't match any purchase.

## Catalog templates

Catalog templates describe product-like placeholders that can be placed into a
landlet. They are not production commerce listings yet.

### Catalog template object

```json
{
  "templateId": "placeholder-chair",
  "name": "Placeholder chair",
  "category": "placeholder",
  "subcategory": "furniture",
  "color": "#3366cc",
  "dimensions": {
    "width": 0.7,
    "depth": 0.7,
    "height": 1.0
  },
  "priceCents": null,
  "sellerId": "dev-seller",
  "modelUrl": null,
  "imageUrl": null,
  "imageEmbedding": null,
  "metadata": {
    "placeholder": true
  },
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

`imageUrl` and `imageEmbedding` are `null` until set via `POST
/api/catalog/:templateId/thumbnail` below — every other endpoint on this
object (create, update, batch) leaves them untouched.

### `GET /api/catalog`

Lists catalog templates in stable name order. Results are cursor-paginated to
keep product discovery reads bounded as the catalog grows.

Optional query parameters:

- `category`: filters templates by exact category.
- `subcategory`: filters templates by exact subcategory, independently or in
  combination with `category`.
- `sellerId`: filters templates by exact seller ID and can be combined with the
  category, subcategory, and name-search filters.
- `color`: filters templates by the exact stored color string.
- `minPriceCents` / `maxPriceCents`: inclusive non-negative integer price bounds.
  Templates without a price are excluded whenever either bound is present.
- `minWidthM` / `maxWidthM`, `minDepthM` / `maxDepthM`, and `minHeightM` /
  `maxHeightM`: inclusive positive dimension bounds in meters, usable together
  to find products within a required size envelope.
- `q`: case-insensitive literal substring search on template names, limited to
  100 characters. SQL wildcard characters in the query are treated literally.
- `sort`: `name` (default), `price-asc`, or `price-desc`. Price sorting excludes
  templates without a price and uses template ID as the stable tie-breaker.
- `limit`: page size from 1 to 100; defaults to 100.
- `cursor`: opaque `nextCursor` value from the preceding page.

The response includes `nextCursor`, which is `null` after the final page. Keep
the same filters and `sort` mode while following a cursor; cursors are specific
to their sort mode.

Response:

```json
{
  "templates": [
    {
      "templateId": "placeholder-chair",
      "name": "Placeholder chair",
      "category": "placeholder",
      "subcategory": "furniture",
      "color": "#3366cc",
      "dimensions": {
        "width": 0.7,
        "depth": 0.7,
        "height": 1.0
      },
      "priceCents": null,
      "sellerId": "dev-seller",
      "modelUrl": null,
      "imageUrl": null,
      "imageEmbedding": null,
      "metadata": {
        "placeholder": true
      },
      "createdAt": "2026-07-29T07:30:06.519Z",
      "updatedAt": "2026-07-29T07:30:06.519Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /api/catalog/:templateId`

Fetches one catalog template.

### `POST /api/catalog/batch`
### `PUT /api/catalog/batch`
### `DELETE /api/catalog/batch`

Atomically creates between 1 and 100 catalog templates. The request body wraps
normal catalog-create objects under `templates`. Every template and uploaded
model reference is validated before the D1 batch runs; duplicate IDs within the
request return `400`, while any database conflict returns `409` and rolls back
the entire batch. Responses return persisted templates in request order. `POST`
is create-only and returns `201`. `PUT` atomically replaces existing IDs and
creates missing IDs, returning `200`; it supports idempotently synchronizing a
bounded catalog batch. Both modes avoid one D1 request per product. Any
template in the batch that has (or already has, for a `PUT` that touches an
existing row) a non-null `sellerId` requires a session logged in as that
seller — `403` if any one of them isn't yours. A `PUT` that changes an
existing template's dimensions triggers `notifyBuildersOfDimensionChange`
per template (see "Notifications" above), the same as the single-item
`PATCH /api/catalog/:templateId` — a seller batch-resizing several products
at once still warns every builder hosting a placed instance of one of them.

`DELETE` accepts 1–100 unique IDs under `templateIds`. Every ID is preflighted
before deletion; a missing ID returns `404`, and a foreign-key conflict returns
`409` with the entire D1 batch rolled back. Every template being deleted that
has a non-null `sellerId` requires a session logged in as that seller (`403`
otherwise). Success returns `deletedTemplateIds` in request order.

### `POST /api/catalog`

Creates a catalog template. `templateId` is optional; if omitted, the Worker
generates one. If `sellerId` is set, requires a session logged in as that
seller (`403` otherwise) — a template with no `sellerId` stays open to
unauthenticated creation (a system/placeholder template with no seller to
attribute it to).

Request body:

```json
{
  "templateId": "placeholder-stool",
  "name": "Placeholder stool",
  "category": "placeholder",
  "subcategory": "furniture",
  "color": "#aa8844",
  "dimensions": {
    "width": 0.5,
    "depth": 0.5,
    "height": 0.6
  },
  "priceCents": null,
  "sellerId": "dev-seller",
  "modelUrl": null,
  "metadata": {
    "placeholder": true
  }
}
```

Required fields:

- `name`
- `color`
- `dimensions.width`
- `dimensions.depth`
- `dimensions.height`

All dimensions must be numbers greater than zero. `priceCents`, when present,
must be a non-negative integer no greater than 100,000,000 (i.e. $1,000,000) —
same cap `startingBidCents` and a bid's `amountCents` share, ruling out a
value large enough to lose precision past `Number.isSafeInteger` once
persisted, or to mint an outsized `higgles_balance_cents` credit through a
self-purchase or auction win. `name`, `category`, `subcategory`, and `color`
are each capped at 100 characters, same as `label` elsewhere in this API.

Deliberately **not** rate-limited (#362 flagged the gap, same as
builders/sellers below, but an IP-keyed limit isn't safe to add here at
any size a real automated flood would actually need to trip on):
unauthenticated catalog creation is this app's own primary way of seeding
ordinary system/placeholder products, and legitimately happens dozens of
times over in normal operation — the same "bootstrapping trap" shape of
problem "Land cap" below documents for why a hard block there got
reverted.

`modelUrl`, when present, must start with `/uploads/` (a real reference
returned by `POST /api/models`) — `400` otherwise. Found via backlog audit
(#375): every placed instance's `modelUrl` is fetched directly by the
browser of anyone who loads that lándlet (`src/main.js`'s model loader), so
an unvalidated arbitrary external URL here let any seller turn every
visitor's browser into an unwitting requester of a URL of their choosing.
Omit the field entirely (or pass `null`) for a plain colored-box template.

### `PUT /api/catalog/:templateId`
### `PATCH /api/catalog/:templateId`

If the existing template has a non-null `sellerId`, requires a session
logged in as that seller (`403` otherwise). Updates a catalog template. The
current implementation merges request fields with the existing template
before validation — but only at the top level: `metadata` is a single
field, so sending it replaces the whole object rather than deep-merging
into it. A caller that wants to change one key inside `metadata` (the
Seller modal's extensibility edit, say) needs to read the existing
`metadata` first and send the whole merged object back — see "Extensible
products (crop)" above. A request-body `sellerId` is ignored — this
endpoint never reassigns a template to a different seller, the same way
`PUT /api/landlets/:id` never reassigns `ownerBuilderId`.

If the request actually changes `dimensions`, every builder with a placed
instance of this template gets a notification once the update succeeds —
see "Notifications" below.

When the existing template has a null `sellerId` (or a dangling one — see
"unlocks review moderation" above), this endpoint requires no session at
all, and its dimension-change notification fan-out makes it worth throttling
even so: `429` after 20 PATCHes per 15 minutes from one client IP (see
"Rate limiting" above), same shape as sign-post/community-calendar posting.
A seller-owned template's PATCH is not rate-limited — the session
requirement already bounds it.

### `DELETE /api/catalog/:templateId`

If the template has a non-null `sellerId`, requires a session logged in as
that seller (`403` otherwise). Deletes a catalog template. D1 foreign-key
behavior may reject deletion while placed instances still reference the
template.

Response:

```json
{
  "deleted": true
}
```

### `POST /api/catalog/:templateId/thumbnail`

Persists a flat product-image thumbnail for a template, plus an optional
embedding for it (#327 — the owner's direction, after ruling out a second
seller-provided photo upload and server-side 3D rendering, was to build a "3D
Model > Flat image" pathway: the client renders a flat PNG from the seller's
already-uploaded 3D model, using the same canvas render (`renderCatalogThumbnailNow`
in `src/main.js`) the catalog picker already produces for display, and uploads
it here). This is a separate endpoint from the ordinary create/update ones
above — `image_url`/`image_embedding` are not accepted by `POST`/`PUT`/`PATCH
/api/catalog` at all, only ever set through this endpoint.

The template must have a non-null `sellerId` referencing a still-existing
seller, and the request must be a session logged in as that seller — `403`
otherwise (unlike `PATCH` above, this endpoint never falls open for an
unowned/orphaned template, since it writes new bytes to storage rather than
just editing a row). `404` if the template doesn't exist.

Request body:

```json
{
  "imageDataUrl": "data:image/png;base64,iVBORw0KGgo...",
  "embedding": [0.12, 0.98, 0.5, "... more numbers ..."]
}
```

- `imageDataUrl`: required. Must start with `data:image/png;base64,`. Decoded
  bytes are capped at 300KB (`400`/`413` otherwise) — comfortably above what
  the client's fixed 128x128 render produces.
- `embedding`: optional. A non-empty array of at most 4096 finite numbers
  (`400` otherwise), or omit/`null` to store no embedding. Opaque to the
  server — today the client computes a cheap stand-in (a downsampled 8x8 grid
  of normalized RGB averages sampled from the same rendered thumbnail, with no
  embedding-model/provider dependency), matching this issue's own "reasonable
  to stub with whatever's cheapest to get the pipeline working end-to-end
  first... swap in a better model later" guidance — a future real embedding
  model can replace it with no shape requirement to honor.

The image is stored content-addressed (a SHA-256 hash of its bytes as the R2
key under `thumbnails/`, deduplicating identical uploads), the same pattern
`POST /api/models` already uses for `.glb` files — not a fixed
`thumbnails/<templateId>.png` key, since `GET /uploads/:key` (see "Model
uploads" below) serves every object with a permanent `immutable` cache-control
header, which a fixed key would fight against on a legitimate re-render (a
seller resizing their product, say).

Response:

```json
{
  "imageUrl": "/uploads/thumbnails/3f2a9c...ab.png"
}
```

`imageUrl` and `imageEmbedding` (`null` if never set) are included on every
catalog template response once set (see "Catalog template object" above).

### `POST /api/catalog/similarity-search`

The backend half of #329 — see that issue's own text: it depends on both the
embedding index (#327, above) **and** the prompt→concept-image endpoint
(#328, below). Only the frontend "Prompt mode" entry point (#330) genuinely
needs both to exist together; the similarity-search half is independently
buildable and testable today by passing any embedding directly, so it's
shipped ahead of the frontend piece. No UI calls this endpoint yet.

Given an embedding (the same shape `POST .../thumbnail` above stores), ranks
every catalog template that has one by cosine similarity and returns the
closest matches. Unauthenticated — this only ever reads already-public
catalog data.

Request body:

```json
{
  "embedding": [0.12, 0.98, 0.5, "... more numbers ..."],
  "limit": 10
}
```

- `embedding`: required. Same validation as `POST .../thumbnail`'s own
  `embedding` field — a non-empty array of at most 4096 finite numbers.
- `limit`: optional integer from 1 to 50 (`400` otherwise), defaults to 10 —
  a smaller cap than the ordinary paginated-listing endpoints above, since
  this is a full in-memory scan (see below), not an indexed query.

No Vectorize (or any other vector-search) binding exists in this project
(confirmed via `wrangler.jsonc`) — this is a plain scan over every
`catalog_templates` row with a non-null `image_embedding`, computing cosine
similarity in-Worker rather than querying an index. Fine at this catalog's
current size, matching this codebase's own "get the mechanic working, model
the real thing later" pattern; swapping in a real vector index later doesn't
change this endpoint's request/response shape. A stored embedding whose
length doesn't match the query embedding's is silently excluded (comparing
vectors of different dimensionality is meaningless) rather than erroring the
whole search — relevant once a future embedding-model swap leaves some older
rows with an old vector shape alongside newly-computed ones.

Response:

```json
{
  "templates": [
    { "templateId": "...", "...": "...", "similarity": 0.94 }
  ]
}
```

Each entry is a full catalog template object (see "Catalog template object"
above) plus `similarity` (this query's own cosine similarity score, highest
first) — `similarity` is not itself persisted anywhere, only computed
per-request.

### `POST /api/catalog/concept-image`

#328 — given a builder's free-text prompt, generates a concept image via an
external image-generation API and stores it. Out of scope here (#328's own
text): embedding the result and running it through similarity-search above
(#329, already merged) or the placement UI (#330) — this endpoint only ever
turns a prompt into a stored image URL. Provider: OpenAI's `gpt-image-1`,
picked over the cheaper Cloudflare Workers AI option per the owner's own
stated priority (generation quality over minimizing per-call cost).

Requires a session (`requireSessionBuilder`) and is rate-limited per builder
— unlike everything else this file calls out to externally, this is a real,
non-trivial per-call cost, so this can't be left anonymous or unthrottled the
way similarity-search's read-only query above is.

Request body:

```json
{ "prompt": "a cozy wooden park bench with wrought-iron armrests" }
```

- `prompt`: required, 1 to 2000 characters (`400` otherwise). Validated
  before the "is this configured" check below, so a malformed request always
  gets a real, specific `400` rather than being masked by a `503`.

Response (`201`):

```json
{ "imageUrl": "/uploads/concept-images/<sha256>.png" }
```

Stored content-addressed in the same `MODELS` R2 bucket as uploaded models
and catalog thumbnails (a hash of the generated image's own bytes as the R2
key) — `GET /uploads/:key` serves every object with a permanent, immutable
cache-control header, so a fixed key wouldn't survive two different prompts
that happen to hash-collide... which in practice never happens; the real
reason for content-addressing here is consistency with the thumbnail
endpoint above, not because two prompts are likely to produce identical
bytes.

Counts against the same `MAX_TOTAL_STORAGE_BYTES` cap `POST /api/models`
enforces (#602) — both are writes into the shared `MODELS` bucket, so both
go through the same atomic reservation (`reserveStorageBudget` in
`worker/index.js`) before their own R2 `put`, closing the same
concurrent-write race #264 already closes for model uploads. The one
difference: a model upload reserves *before* reading the request body (its
size is known upfront), while this endpoint reserves right before its own
`put` instead, since a generated image's size isn't known until generation
actually finishes.

#### Testing note

Same shape as `STRIPE_SECRET_KEY`/`RESEND_API_KEY` elsewhere in this file: a
Worker secret (`OPENAI_API_KEY`) that's never configured in local dev or the
automated test suite, so a real OpenAI call is never attempted during tests
— covered up to the `503` this endpoint returns when unconfigured, not
beyond it. That also means the storage-cap check above (which only runs
after a real generation succeeds) isn't exercised end-to-end by this
endpoint's own tests; its shared `reserveStorageBudget` logic is the same
code path `POST /api/models`'s own storage-cap race test already covers.

### Extensible products (crop)

A template's `metadata` can declare that it may be shortened along one or more
local axes — e.g. a door trimmed narrower to fit a gap, or a length of lumber
cut down like real dimensional lumber. The template is uploaded at its
*maximum* size (its ordinary `dimensions`); the declaration adds a minimum:

```json
{
  "metadata": {
    "extensible": {
      "x": { "minM": 0.4 }
    }
  }
}
```

Axis keys are `x`, `y`, `z`, matching how `dimensions.width` / `.depth` /
`.height` map onto the scene's local axes — validated server-side
(`assertValidExtensible` in `worker/index.js`, called from `validateTemplate`)
on every create/update, not just enforced by the frontend's own Extensibility
panel: an unrecognized axis key, or a `minM` that isn't a finite number
strictly between `0` and that axis's own dimension, is rejected with `400`
(#271 — a bypassed-frontend request that snuck in a non-numeric/missing/
negative `minM` used to defeat the crop-floor check below entirely, since
JS's numeric comparison makes `anything < NaN`/`anything < undefined` both
`false`). A template can declare any subset of the three at once — e.g. a wall resizable in thickness, length, and
height all independently — and the frontend's Trim gizmo shows a separate
handle (and a separate numeric field) for every axis a selected item's
template declares, all active simultaneously; each still crops exactly one
axis per drag (see "Dragging the Trim gizmo" below for the multi-handle
gizmo itself, and "Managing extensibility" for how a seller turns axes on).
(Trim is the per-axis shortening tool described here — not to be confused
with the now-removed Resize tool, a real uniform scale unrelated to
extensibility; see "Legacy per-instance Resize scale" below.)

A builder's per-instance override lives on the placed instance itself, not the
template — see `crop` under Placed instances below. The frontend never
stretches an extensible product's geometry to realize a crop (that would
distort a textured product's UVs); a crop is always a true "cut it shorter,"
never a squash:

- A template with no `modelUrl` (or one whose `metadata.extensible` axis
  fails to load) renders as a plain colored box at the cropped size —
  trivially correct, since there's no texture to distort in the first place.
- A template with a real model (e.g. a photogrammetry scan) is actually
  clipped, and asymmetrically: the crop only ever removes material from the
  local +axis end (`src/meshCrop.js`'s `cropGeometryFromEnd`). The -axis end
  — the "anchor" — is never touched at all, real end cap included. The
  +axis end doesn't get a fabricated flat disc either: the product's own
  real end-cap geometry (whatever triangles were already sitting at its
  true, uncropped +axis extreme) is lifted and translated inward to the new
  boundary, so a crop always looks like a shorter version of the same real
  product — never an artificial-looking patch. How *thick* a slab to lift
  isn't a fixed fraction of the product's length — `pickCapThickness`
  searches for it, starting thin and doubling until the slab's own
  freshly-cut cross-section is actually close to the main body's hole it
  needs to cover, up to a ceiling relative to the kept length. This
  replaced an earlier fixed-thickness version after a real scanned brick
  showed why a fixed thickness isn't safe: real scanned geometry is least
  reliable right at its own true silhouette edge (the shallowest, most
  occluded camera angles), and on that brick this wasn't a gradual taper
  but a sharp transition — a slab barely under 1cm thick measured a
  cross-section only ~60% of the cut boundary's own extent on one axis,
  while a slab just 2cm thick measured within 2%. A single fixed thickness
  can't safely split the difference for every product, since where that
  unreliable edge zone ends varies by scan; a product whose edge is fine at
  the starting thickness (the common case) pays nothing extra by searching,
  while one like the brick above grows only as much as it actually needs
  to, discovered empirically rather than guessed. Because a real scanned
  product can still taper or vary slightly along its length even once
  picked past the unreliable zone, the lifted slab's own cross-section
  isn't guaranteed to *exactly* match the main body's hole — `cropGeometryFromEnd`
  recenters and (only if actually necessary) scales the slab up just
  enough to fully cover that hole, so real geometry only ever stretches to
  fit, never leaves a gap. This is a bounding-box fit, not a true outline
  match, so an irregular (non-rectangular) real cross-section can still
  leave a sliver of the manufactured backing cap exposed even after it.
  That backing — built as an invisible safety net behind the relocated
  real cap, in case the two don't nest perfectly — is rendered with a
  plain material colored from the real texture's own average color
  (downsampled to a single pixel via an offscreen canvas — see
  `averageTextureColor` in `src/main.js`) rather than `template.color`:
  for a real uploaded model, `template.color` is almost always just the
  upload flow's generic gray placeholder, not a color anyone actually
  chose, so any exposed sliver would otherwise read as an obviously-wrong
  flat gray patch rather than blending into the surrounding real surface.
  See `loadCroppedModelInstance` in `src/main.js`, which also recenters the
  result so a placed instance's own position keeps meaning "the object's
  true center" even though the crop itself is one-sided. Each individual
  crop is single-axis-aligned — fine for the roughly-box-shaped products
  (bricks, boards, doors, walls) this exists for. An instance cropped on
  more than one axis at once (only possible when its template declares more
  than one extensible axis) runs `cropGeometryFromEnd` once per cropped
  axis in turn on the same evolving geometry — safe since each pass only
  ever touches its own axis's coordinates, so an already-cropped x range is
  untouched by a following z crop and vice versa. The one real cost of
  chaining rather than cropping fresh geometry per axis: a later pass's
  triangle-normalizing step treats an earlier pass's own fabricated
  backing-cap sliver (see above) as ordinary "real surface," so a small,
  already-meant-to-be-hidden patch near a shared corner can occasionally
  render with the real texture instead of its flat backing color — a minor
  cosmetic wrinkle at a rarely-visible seam, not the always-preserved
  surface a builder actually sees. A genuinely holey source scan (an actual
  gap in the mesh, not something the crop introduces or touches) can still
  show background through that gap regardless — a property of the uploaded
  model itself, not fixable by the crop math, and distinct from the
  backing-sliver case above (that's about a manufactured surface peeking
  through; this is a real hole in the source mesh).
- Dragging the Trim gizmo shows this real crop live, throttled to about
  8 updates/second rather than one per pointer-move frame (a full reload +
  reclip isn't free) — the object being dragged is hidden immediately when
  the drag starts (not only once the first preview finishes loading), and
  a temporary preview mesh takes its place for the span of the drag, so
  nothing about TransformControls' own internal drag-tracking is ever
  touched mid-drag, and a fast drag past the min/max never shows the raw,
  unclamped stretch TransformControls itself would otherwise apply. When a
  template declares more than one extensible axis, every declared axis's
  own single-axis handle is shown on the gizmo at once — which axis a given
  drag actually crops is read fresh from TransformControls' own report of
  which handle was grabbed (`trimControls.axis`), not decided ahead of
  time. The plane and uniform-corner handles TransformControls' scale mode
  would otherwise add once two or three single-axis handles are all
  visible together are deliberately never reachable (see the `trimControls`
  setup in `src/main.js`) — Trim only ever crops one axis per drag; a real
  uniform scale is what the separate Resize tool is for.

### Managing extensibility — the Seller modal

A template's `sellerId` is a genuinely separate identity from whichever
builder uploaded it — see "Sellers" above. Reaching Sell mode (the `#mode-nav`
Sell tab — the only way in; there is deliberately no "My Products" shortcut
from Build mode) ensures a seller identity is active first if one isn't
already (`ensureSellerIdentity` in `src/main.js`, which now just blocks on a
real login and fetches the account's auto-provisioned seller via
`fetchMySeller()` — see "Authentication"/"Sellers" above) — no builder
identity or claimed landlet needed, only a seller one. The Sell modal lists
every template whose
`sellerId` matches the active seller, plus any custom-uploaded template with
a `null` `sellerId` (covers products uploaded before sellers existed as their
own concept). There's no "switch seller identity" control in the modal — a
real account has exactly one auto-provisioned seller profile, not a roster to
pick from.

Each row leads with just the product's name; tapping it (`.seller-row-toggle`)
expands the row to reveal everything else — dimensions, action buttons, and
the Extensibility/Edit Size panels — a collapse-until-tapped pattern. Tapping
a different row's toggle collapses whichever one was open, and a collapsed
row's live preview (if any) is torn down (`disposeAxisPreview`) rather than
left rendering behind a `display:none` panel.

An expanded row shows its dimensions, then four action buttons — Preview,
Rename, Duplicate, Delete — with Edit Size and Extensibility each tucked
behind their own collapsed toggle rather than shown inline. Both are real
features but rare needs; putting their controls behind a deliberate expand
keeps the row itself readable as "a product with some buttons" rather than
a resize-configuration form every seller has to visually parse whether they
need it or not.

- **Preview** renders that product — the real model or placeholder box,
  exactly as Build mode would show it — into a small self-contained Three.js
  scene (`showAxisPreview` in `src/main.js`, the same create/dispose-per-open
  pattern the claim flyover uses), reusing a single shared canvas moved
  between rows rather than one per row (mobile GPUs don't want many WebGL
  contexts open at once, and only one row's preview is ever meaningful at a
  time). It's collapsed until tapped — the modal doesn't reserve space for a
  3D viewport a seller may never open — and defaults to a plain look-it-over
  view with no axis arrows. Expanding a row's Extensibility panel switches
  that row's already-open preview (if any) to show X/Y/Z arrows overlaid at
  the product's own true size instead, so a seller can see which physical
  direction each axis points before picking one; collapsing it switches back
  to the plain view. Picking an axis (or changing it) turns that arrow
  bright yellow and mutes the other two to gray; an orbit-only camera (no
  pan, no auto-rotate) lets the seller drag to look around.
- **Rename** sends just `{ name }` through `PATCH /api/catalog/:templateId`
  (no `metadata` involved, so the merge-vs-replace caveat below doesn't
  apply here).
- **Duplicate** is a plain `POST /api/catalog` carrying the same
  `dimensions`/`color`/`modelUrl`/`metadata` under a fresh server-generated
  `templateId`, with `" (copy)"` appended to the name. The model file itself
  is never re-uploaded — the copy just references the same `modelUrl` — so
  this is safe to do freely: a builder can try a risky edit (like marking
  something extensible for the first time) on a duplicate without any
  chance of disturbing the original or any instances already placed from it.
- **Delete** is a plain `DELETE /api/catalog/:templateId`, gated only by a
  `confirm()` — deleting a template only ever removes its `catalog_templates`
  row, never the underlying R2 object, so it's recoverable by re-registering
  the same `modelUrl` (just not from this UI). `placed_instances.template_id`
  is a foreign key into `catalog_templates`, so the database itself refuses
  to delete a template still referenced by an instance somewhere (a generic
  409 from `databaseHttpError`, reworded on the frontend into "still placed
  somewhere — remove those instances first, or Duplicate to edit a copy
  instead") rather than silently orphaning that instance's rendering.

The Extensibility panel itself shows one row per axis (Width/x, Depth/y,
Height/z) — a checkbox plus a minimum-length field each, independent of the
other two, since a template can be extensible on any subset of its three
axes at once (see "Extensible products (crop)" above). Save writes every
checked axis's `{ minM }` in one request, via a plain
`PATCH /api/catalog/:templateId` with the *entire* merged `metadata`
object — the endpoint replaces `metadata` wholesale rather than
deep-merging it, so the frontend reads the existing value first and only
replaces the `extensible` key (built fresh from all three rows' current
state) before sending it back.

### Editing a product's size

A seller can correct a mis-measured (or since-outgrown) real-world size
after the fact from the row's own "Edit Size ▾" toggle — three
proportionally-linked inputs pre-filled with the template's current
`dimensions`, the same proportional-linking behavior as the upload wizard's
own dimensions step (editing one axis rescales the other two off the
template's *current* size, not whatever's mid-edit in the other fields, so
repeated edits can't compound rounding error).

Saving does one of two things depending on whether the template has a real
uploaded model:

- If `modelUrl` starts with `/uploads/` (a real seller-uploaded model, not a
  placeholder box), the actual model file is fetched, rescaled via
  `rescaleModelFile` (the same helper the upload wizard uses when a seller
  adjusts a freshly-measured size before creating the product, so declared
  dimensions always exactly match the model's own rendered size), and
  re-uploaded before the template is patched with both the new `dimensions`
  and the new `modelUrl` in one request.
- If there's no real model (a placeholder-box product), only `dimensions`
  is patched — there's no geometry to rescale.

Either way this is a plain `PATCH /api/catalog/:templateId`, so the same
request that changes the declared size is what triggers
`notifyBuildersOfDimensionChange` server-side (see "Notifications" above) —
the frontend doesn't separately call anything to notify affected builders.

Edit Size's own DOM elements (`.seller-size-panel`, `.seller-size-row`,
`.seller-size-input`, `.seller-size-save-btn`, `.seller-size-status`) are
deliberately not shared with the Extensibility panel's classes above despite
looking identical — several tests select "the" Extensibility row/input/save
button/status by class alone, assuming exactly one (or exactly three) per
row, and a second, earlier-in-DOM panel under the same class would silently
break those assumptions.

## World settings

World settings hold the dev-only singleton state needed to start modeling the
expanding circular world. This is not procedural world generation yet; it is the
small API surface that stores the values future generation code will consume.

### Automatic world growth

The world now grows itself. `worker/index.js`'s `scheduled()` export runs on
a Cloudflare Cron Trigger (`wrangler.jsonc`'s `triggers.crons`, every 10
minutes) and calls `autoGrowWorldIfNeeded`, which checks the same condition
`POST /api/world/expand` gates on — the greenbelt-to-total ratio dropping
below `greenbeltMinRatio` — and if so, expands the world to enclose any
already-generating land, or (if nothing greenbelt exists at all) generates
and completes a fresh ring of land at the current boundary. It's a second
caller of the same internal primitives the manual endpoints below use
(`expandWorldOnce`, `generateLandletRingCandidates`,
`completeRingGenerationInternal`), not a replacement for them — those stay
available, admin-gated, for manual troubleshooting.

Before this existed, growing the world was a *player*-triggered action: the
claim flow's own "Grow the world" button called these same endpoints
whenever nothing was claimable. That was always a stated dev-mode stand-in
("a real deployment would want this driven by an actual world-building
process") — this is that real process. No request, no session, nothing to
authenticate: `scheduled()` runs as the trusted server itself, so none of
the session/admin gates below apply to it. A Cron Trigger doesn't fire
inside a plain local `wrangler dev` process, which is why the e2e suite
carries its own stand-in (`growWorldAsAdmin` in `e2e/helpers.mjs`) that logs
in as an admin and drives the manual endpoints directly instead.

The same `scheduled()` run also calls `pruneExpiredAuthState`, an unrelated
piece of janitorial cleanup riding the same cron rather than one of its
own: it deletes expired `sessions` rows, expired `email_verification_tokens`/
`password_reset_tokens` rows, and `rate_limit_events` rows older than the
rate limiter's own window. None of these are ever swept otherwise — a
session or token only gets deleted today via an explicit logout or
password-reset flow, and `checkRateLimit` only ever prunes the one bucket
it's currently checking, so a bucket keyed to a target nobody retries (e.g.
one email's signup/reset attempts) would otherwise sit in the table
forever.

The same cron also runs `checkMigrationDrift` (#499, follow-up to #488: a
real 4-day production outage where `wrangler d1 migrations apply --remote`
silently failed partway through a batch and nothing noticed until an owner
bug report). It compares a live `SELECT name FROM d1_migrations` against
`worker/migrations-manifest.json` — a list of `migrations/*.sql` filenames
generated at build/deploy time (`npm run generate:migrations-manifest`,
wired into `deploy`/`deploy:ci`) since `scheduled()` has no filesystem
access to read `migrations/` directly. `scripts/check-migrations-manifest-
fresh.mjs` runs as a `pretest` check so the checked-in manifest can't
silently drift from `migrations/` itself. On finding production missing any
migration the manifest expects, it logs a loud `console.error` (always
visible in `wrangler tail`/the dashboard) and, if the optional `OPS_ALERT_EMAIL`
Worker secret is configured, also emails that address via the existing
`sendEmail`/Resend integration — same dev-mode-friendly "no secret, no
network call" fallback as `RESEND_API_KEY` itself. This is a detection net,
not a replacement for `scripts/check-migration-drift.mjs` (#492), which
still catches the same drift immediately at deploy time; this catches it
within the next 10-minute cron tick even when nobody deploys for a while.

### World object

```json
{
  "worldId": "default-world",
  "radiusM": 31.6227766017,
  "expansionIncrementM": 10,
  "greenbeltMinRatio": 0.1,
  "coordinateRotationDeg": 210,
  "dayCycleHours": 4,
  "landletCounts": {
    "total": 1,
    "greenbelt": 0,
    "claimed": 1,
    "generating": 0,
    "water": 0,
    "greenbeltRatio": 0
  },
  "metadata": {},
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

### `GET /api/world`

Fetches the singleton world settings object and aggregate landlet status counts.
`water` counts landlets with `landType: "water"` (#218,
docs/SPEC.md §1's "Water cannot be owned") — included in `total` (it's real,
generated world content) but excluded from `greenbelt` and therefore from
`greenbeltRatio`'s numerator, since that ratio specifically means "available
to claim," not "not currently claimed."

### `PUT /api/world`
### `PATCH /api/world`

Requires a session logged in as an admin (`403` otherwise — see "Admin
role" under "Authorization model" above). Updates world settings. The
current implementation merges request fields with the existing world
settings before validation.

Request body example:

```json
{
  "radiusM": 41.6227766017,
  "expansionIncrementM": 10,
  "greenbeltMinRatio": 0.1,
  "coordinateRotationDeg": 210,
  "dayCycleHours": 4,
  "metadata": {
    "note": "dev-only world settings"
  }
}
```

Validation notes:

- `radiusM` must be zero or greater.
- `expansionIncrementM` and `dayCycleHours` must be greater than zero.
- `greenbeltMinRatio` must be between `0` and `1`.

`dayCycleHours` is retained but currently unused by the frontend — see
"Day-night cycle — removed" below.

### `POST /api/world/expand`

Requires a session logged in as an admin (`403` otherwise). This is the
manual/troubleshooting path now — see "Automatic world growth" above for
the mechanism that calls it (well, its internals) day to day. Expands the
circular world boundary by exactly one configured
`expansionIncrementM` when the current greenbelt-to-total-landlet ratio is below
`greenbeltMinRatio`. If the reserve is already at or above the threshold, the
endpoint returns `409` and does not change the radius.

After expanding, generation-complete landlets that are fully enclosed by the
new circle become greenbelt and receive a `claimableAt` timestamp. Incomplete
landlets remain generating even when the boundary fully encloses them. Polygon
points are interpreted as plot-local meter coordinates relative to `center`.
For placeholder landlets without a polygon, the enclosure calculation uses a
same-area circle as a temporary approximation.

The same expansion also materializes queued land candidates the moment the new
circle first overlaps any part of their polygon. They enter the `generating`
state with no claimability timestamp; generation completion remains a separate
operation.

The response contains the updated world plus an expansion summary:

```json
{
  "expansion": {
    "previousRadiusM": 31.6227766017,
    "newRadiusM": 41.6227766017,
    "incrementM": 10,
    "promotedLandletIds": ["edge-candidate"],
    "startedGeneratingLandletIds": ["queued-edge-candidate"],
    "readyRingIds": []
  }
}
```

`readyRingIds` contains rings whose final pending candidate materialized during
this expansion, so generation workers do not need to poll every ring member.

## Land candidates

Land candidates are lightweight records for planned puzzle pieces outside the
current world boundary. They avoid creating full landlet records before those
pieces are needed.

Every mutating endpoint below requires a session logged in as an admin
(`403` otherwise) — see "Admin role" under "Authorization model" above.
`generate-ring` specifically is also called internally (bypassing HTTP
entirely, so no session applies) by the automatic world-growth job — see
"Automatic world growth" under "World settings" above.

### `POST /api/land-candidates/generate-mosaic`

Creates a deterministic Eroded Mosaic patch of exactly 16 class-1 lands centered on
the world origin. The request contains `prefix` and `count`; `prefix` also seeds
the blue-noise site placement and stable IDs. Every land is exactly 1,000 m².
The stored template was produced offline from a shared equal-area power diagram,
with the same sampled S-curve used by both polygons along every seam. Request
handling only applies a deterministic rigid rotation seeded by `prefix`; it does
not solve the diagram synchronously. This keeps generation compatible with the
Cloudflare Workers free-tier CPU budget. The zero-signed-area bends preserve
plot area while preventing gaps and overlaps.

One of the 16 template cells always covers the world origin — the same point
`starter-landlet` sits on, since the template is only rotated by `prefix`'s
seed, never translated. Rather than inserting a competing candidate there,
that cell's polygon is written onto `starter-landlet` directly (its
`center`, `polygon`, and `metadata` update in place). Unlike its 15
siblings, `starter-landlet` already exists as a landlet row rather than a
fresh candidate, so it skips the normal materialize-then-generation-complete
pipeline — this call promotes it straight to `greenbelt`/claimable (the same
end state the other cells eventually reach) whenever it's currently
unowned, so it claims and releases exactly like any other land. A landlet
already genuinely claimed by a real builder is left alone. The response's
`candidates` array therefore contains the other 15 cells, not 16, and
`starterLandletId` names the landlet that received the 16th. Candidates
among those 15 that intersect the current availability circle materialize
as generating landlets immediately; remaining complete shapes stay queued
and non-selectable until a later expansion reaches them. The response
contains `candidates`, `materializedLandletIds`, and `starterLandletId`.

Reusing a prefix returns `409`. So does any generated cell overlapping an
existing landlet or candidate — checked by real polygon intersection, not
just a radial band like `generate-ring` uses, since this generator has no
radial structure for a band check to work with (every call covers the same
disc around the origin, only rotated). In practice this means the endpoint
is only callable once per world: a second call, with any prefix, still
covers that same disc and will conflict with the first call's land.

This endpoint is the current organic-generation prototype. New world data
should use it instead of the legacy annular endpoint below. Larger land classes
remain a future extension; this first version deliberately emits only exact
1,000 m² class-1 lands.

### `POST /api/land-candidates/generate-ring`

Procedurally creates one gap-free band of class-1, 1,000 m² land candidates.
The generated wedge-shaped polygons use shared sampled edges, are centered on
their polygon centroids, and are deterministic for the same inputs. This is a
bounded dev-only generation primitive rather than a background job: `count`
must be between 3 and 100, and the complete ring is inserted atomically.

```json
{
  "prefix": "north-ring",
  "count": 12,
  "innerRadiusM": 100,
  "startAngleRad": 0,
  "distribution": "power-law"
}
```

`prefix` is required and supplies stable IDs such as `north-ring-001`.
`innerRadiusM` defaults to the current world radius and cannot be smaller than
it; `startAngleRad` defaults to zero. By default every candidate is a 1,000 m²
class-1 landlet. Set `distribution` to `power-law` to apply the specification's
authoritative class ratios: each larger class count is rounded down, leftovers
are assigned to class 1, and larger plot sizes are drawn uniformly within their
class. The prefix seeds those draws, making retries reproducible. Variable-area
wedges retain shared edges and exact requested polygon areas.

Candidates touching the current boundary materialize immediately. The response contains the candidates,
`materializedLandletIds`, `readyForGenerationCompletion`, and the calculated
inner and outer radii. The readiness flag is true when every ring candidate has
materialized and ring-wide completion can begin. Reusing a
prefix fails atomically with `409` rather than partially duplicating a ring.
Generation also returns `409` when the requested annular band would overlap an
existing land candidate. Exactly adjacent rings may share a boundary.
Because boundaries are polygonal samples rather than mathematical arcs,
adjacent rings must also use matching angular seams (the same fixed-size count
and start angle). A mismatched adjacent request returns `409` instead of
creating small geometric gaps or overlaps. Power-law rings generally require a
non-adjacent buffer because their seeded variable sizes change those seams.
To extend any existing ring without a buffer, set `adjacentToRingId` and keep
`count` equal to that ring's count. The backend derives the new inner radius,
start angle, distribution, and per-plot areas from the referenced ring, so even
power-law boundaries match exactly. Do not send `innerRadiusM` or
`startAngleRad` with this option. A missing adjacent ring returns `404`.
Each accepted band is also stored as a single ring reservation. A D1 trigger
enforces the same exclusion rule atomically, so concurrent requests cannot both
create overlapping rings after passing their application-level preflight.

## Land candidate rings

### `GET /api/land-candidate-rings`

Lists generated ring reservations in stable creation order. `limit` accepts 1
to 100 and defaults to 100. Follow the opaque `nextCursor` to fetch subsequent
pages without changing the page size requirements.

Set `adjacentToRingId` to list the derived outward child of one reservation.
Keep this filter unchanged while following `nextCursor`.

Each listed ring contains `ringId`, `innerRadiusM`, `outerRadiusM`, `candidateCount`,
`distribution`, `startAngleRad`, `adjacentToRingId`, and `createdAt`.
`adjacentToRingId` records the parent reservation when the ring was derived via
the adjacency option. This endpoint exposes the
reservation rather than repeating its potentially large candidate collection;
use the land-candidate listing to inspect individual plots.

### `GET /api/land-candidate-rings/:ringId`

Fetches one generated ring reservation or returns `404`. The detail response
also includes `lifecycle` counts for stored, pending, and materialized
candidates plus generation-complete and greenbelt landlets. These counts make
it possible to determine whether ring-wide generation completion is ready
without loading every candidate. The detail response additionally includes
`adjacentChildRingId`, allowing a
ring chain to be traversed in either direction without scanning the listing.
Reservations are
read-only because deleting one independently of its candidate geometry would
make overlap protection incorrect.

Generated ring candidates are likewise immutable through the individual
candidate `PUT`, `PATCH`, and `DELETE` routes. D1 triggers also protect their
geometry from direct writes while still allowing lifecycle fields such as
`materializedAt` to advance normally. Generate a replacement ring under a new
prefix instead of editing or removing one member of a reserved band.

### `POST /api/land-candidate-rings/:ringId/generation-complete`

Requires a session logged in as an admin (`403` otherwise) — also called
internally, bypassing HTTP, by the automatic world-growth job (see
"Automatic world growth" under "World settings" above). Marks every
materialized landlet in a generated ring complete with one bounded
D1 update. All candidates in the ring must already be materialized; otherwise
the endpoint returns `409` without changing any landlet. The operation is
idempotent, preserving existing `generatedAt` timestamps on retry. Completed
landlets remain `generating` until fully enclosed by the current world circle,
or become greenbelt and claimable immediately when already enclosed.

The response contains the ring reservation with updated lifecycle counts and
its complete landlet array.

### `GET /api/land-candidates`

Lists candidates in stable creation order. `materializedAt` is null while a
candidate is waiting and is set once its landlet begins generating.

Optional query parameters:

- `state`: filters to `pending` candidates that have not started generation or
  `materialized` candidates whose landlets are generating.
- `ringId`: filters to candidates belonging to one procedurally generated ring.
  Manually queued candidates have a null `ringId` in their response.
- `limit`: page size from 1 to 100; defaults to 100.
- `cursor`: opaque `nextCursor` value from the preceding page.

The response includes `nextCursor`, which is `null` after the final page. Keep
the same `state` and `ringId` filters while following a cursor.

```json
{
  "candidates": [],
  "nextCursor": null
}
```

### `GET /api/land-candidates/:landletId`

Fetches one candidate or returns `404`.

### `DELETE /api/land-candidates/:landletId`

Removes a pending candidate that has not started generation. This supports
correcting or replacing queued procedural-generation output before the world
circle reaches it. Materialized candidates already have a corresponding
generating landlet and return `409` instead of deleting either record.

Response:

```json
{
  "deleted": true
}
```

### `PUT /api/land-candidates/:landletId`
### `PATCH /api/land-candidates/:landletId`

Corrects a pending candidate's `name`, `areaM2`, `center`, `landClass`,
`polygon`, or `metadata` before generation begins. The current implementation
merges request fields with the existing candidate before validation. The route
ID cannot be changed. Materialized candidates return `409`; their geometry is
already represented by the corresponding generating landlet.

As with candidate creation, moving or reshaping a pending candidate so it now
overlaps the current world circle immediately materializes it. The response
contains both `candidate` and `landlet`; `landlet` is null if it remains queued.

### `POST /api/land-candidates`

Queues a candidate using the same `name`, `areaM2`, `center`, `landClass`,
`polygon`, and `metadata` fields as a landlet. If it already overlaps the
current world circle, the API immediately creates its generating landlet.
Otherwise it remains lightweight until a later expansion first overlaps it.

The `201` response contains both `candidate` and `landlet`; `landlet` is null
while the candidate remains queued.

Rejects with `409` if the candidate's footprint would overlap any existing
landlet or land candidate (#570) — the same check `generate-mosaic` already
applies to its own generated cells, extended here since this endpoint takes
arbitrary admin input rather than a self-consistent generator's output. A
candidate with no explicit `polygon` is treated as a circle of radius
`sqrt(areaM2 / π)` around its `center`, matching how the rest of the backend
(`landletMinWorldRadius`/`landletMaxWorldRadius`) already reads such a row —
not an unchecked zero-area point.

### `POST /api/land-candidates/batch`

Atomically queues between 1 and 100 candidates for efficient world-generation
work. The request wraps candidate objects matching the single-create endpoint:

```json
{
  "candidates": [
    {
      "landletId": "generated-001",
      "name": "Generated 001",
      "areaM2": 1000,
      "center": { "x": 50, "y": 0 },
      "polygon": []
    }
  ]
}
```

All candidates are validated before the D1 batch executes. IDs must be unique
within the request, and any database conflict rolls back the complete batch.
Candidates already overlapping the current world circle are materialized as
generating landlets in the same batch. The `201` response returns all created
`candidates` and a `landlets` array containing only those materialized
immediately.

Rejects the whole batch with `409` (#570) under the same overlap rule as the
single-create endpoint above — checked against existing land *and* against
the other candidates in the same batch request, since a manually-submitted
batch (unlike `generate-mosaic`'s own output) isn't guaranteed internally
non-overlapping.

## Landlets

Landlets are the first persistent world/plot records. They currently support
dev-only CRUD so future plot selection, greenbelt availability, and generation
state can build on a stable backend shape.

### Landlet object

```json
{
  "landletId": "starter-landlet",
  "name": "Starter landlet",
  "areaM2": 1000,
  "center": {
    "x": 0,
    "y": 0
  },
  "status": "claimed",
  "ownerBuilderId": null,
  "landClass": 1,
  "landType": "buildable",
  "polygon": [],
  "generatedAt": null,
  "claimableAt": null,
  "activeVersionId": null,
  "metadata": {},
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

### `GET /api/landlets`

Lists landlets in stable creation order. Results are cursor-paginated so the
growing world does not require an unbounded D1 read.

Optional query parameters:

- `status`: filters by exact status (`greenbelt`, `claimed`, or `generating`).
- `ownerBuilderId`: filters by placeholder builder owner ID.
- `limit`: page size from 1 to 100; defaults to 100.
- `cursor`: opaque `nextCursor` value from the preceding page.

The response includes `nextCursor`, which is `null` after the final page. Keep
the same `status` and `ownerBuilderId` filters while following a cursor.

```json
{
  "landlets": [],
  "nextCursor": null
}
```

### `GET /api/landlets/:landletId`

Fetches one landlet.

### `POST /api/landlets`

Creates a landlet. `landletId` is optional; if omitted, the Worker generates
one. Creating an unowned landlet (`ownerBuilderId` omitted or `null` —
`status: greenbelt`/`generating`) stays unauthenticated dev/world-generation
tooling, same as `PUT`/`PATCH` on one (see that endpoint's own notes).
Creating one with a non-null `ownerBuilderId` requires a session (`401`
without one) and only ever as *yourself* — `403` unless `ownerBuilderId`
matches the calling account's own builder id. This mirrors `PUT`/`PATCH`'s
existing ownership gate rather than introducing a new one: without it,
anyone could fabricate an already-claimed landlet (any polygon, any
location) under any builder's id straight from the request body, bypassing
every invariant `POST .../claim` enforces.

Request body example:

```json
{
  "landletId": "dev-greenbelt-001",
  "name": "Dev greenbelt 001",
  "areaM2": 1000,
  "center": {
    "x": 20,
    "y": 0
  },
  "status": "greenbelt",
  "ownerBuilderId": null,
  "landClass": 1,
  "landType": "buildable",
  "polygon": [
    { "x": -15.811, "y": -15.811 },
    { "x": 15.811, "y": -15.811 },
    { "x": 15.811, "y": 15.811 },
    { "x": -15.811, "y": 15.811 }
  ],
  "generatedAt": null,
  "claimableAt": null,
  "metadata": {}
}
```

Required fields:

- `name`
- `areaM2`

Validation notes:

- `areaM2` must be greater than zero.
- `center.x` and `center.y` default to `0` and must be finite numbers.
- `status` defaults to `greenbelt` and must be `greenbelt`, `claimed`, or
  `generating`.
- `landClass` defaults to `1` and must be a positive integer.
- `landType` defaults to `buildable` and must be `buildable` or `water`.
  Deliberately a separate field from `status` (see migrations/0064's own
  comment for why) — a `'water'` landlet still goes through the ordinary
  `generating` -> `greenbelt` lifecycle for rendering/geometry purposes
  (docs/SPEC.md §1's "Macro-geography"), it just can never become `claimed`
  (`POST .../claim` rejects it with `409`, see below). Nothing in world
  generation produces a `'water'` landlet yet — this field exists so the
  claim system and data model are ready for whenever it does.
- `polygon` defaults to an empty array. When present, each point must contain
  finite `x` and `y` values in meters.

### `POST /api/landlets/:landletId/claim`

Requires a session (`401` without one). Claims an available greenbelt landlet
for the calling account's own builder profile — no body needed at all;
`builderId` is derived entirely from the session, never from a
client-supplied field (see "Authorization model" above), since claiming "as"
a builderId the caller merely typed in would let anyone claim land on
another builder's behalf just from their publicly-visible ID. This is the
preferred way to perform the initial ownership transition instead of
changing `status` and `ownerBuilderId` independently with the generic update
endpoint.

The claim is a conditional database update: the landlet must still have
`status: "greenbelt"`, must have no owner, must have `landType: "buildable"`
(a `"water"` landlet — docs/SPEC.md §1's "Water cannot be owned" — always
`409`s with a dedicated message, checked before the generic conflict
reasons), and the builder must not already own a claimed landlet. This
preserves the MVP rule that each builder can claim one
free *starter* landlet even when two requests arrive close together — it's
purely an application-level check now (migration 0058 dropped the partial
unique D1 index that used to enforce it for every write path), because a
builder legitimately ends up owning more than one claimed landlet once they
win a land-acquisition auction (docs/SPEC.md §0/§5) on top of their starter
one, and the DB-level version blocked that too.

A claimed landlet with its own **active** auction on it doesn't count
against this lock once the seller has committed to giving it up (#199): a
`startingBidCents: 0` auction is that commitment from the instant it
starts (see "Land acquisition auctions" below), so it stops locking
immediately; any other starting bid becomes the same commitment as soon as
the auction's first bid lands, since a bid guarantees the land eventually
transfers either way. The seller keeps nominal ownership (and the landlet
stays `status: "claimed"`, owned by them) for build/display purposes until
the auction actually resolves — this only changes *claim eligibility*, computed
live from the auction/bid data already on hand (`LANDLET_RELEASED_VIA_AUCTION_SQL`
in `worker/index.js`), not anything stored on the landlet itself.

Returns the newly claimed landlet. Errors are:

- `401` when nobody is logged in.
- `404` when the landlet does not exist.
- `409` when the landlet is unavailable or the builder already owns a claimed
  landlet.

### `POST /api/landlets/:landletId/generation-complete`

Admin-only (`401`/`403` otherwise) — same as its ring-level sibling,
`POST /api/land-candidate-rings/:ringId/generation-complete`. Records that
asynchronous generation work has completed. The endpoint is idempotent:
retries return the existing landlet once `generatedAt` is set.

Generation completion and geometric enclosure are independent requirements. If
the world circle already fully encloses the landlet, completion immediately
makes it greenbelt and claimable. Otherwise it remains `generating` with a
`generatedAt` timestamp until a later world expansion encloses it. Calling this
endpoint for a landlet that is neither generating nor already complete returns
`409`.

### `PUT /api/landlets/:landletId`
### `PATCH /api/landlets/:landletId`

Once a landlet has an owner, requires a session logged in as that owner
(`403` otherwise) — an unowned (greenbelt/generating) landlet stays open to
unauthenticated requests, since this generic endpoint's real usage is
admin/world-gen tooling, not the player-facing claim/build flow. Updates a
landlet. The current implementation merges request fields with the existing
landlet before validation, except `ownerBuilderId`: that field is always
force-preserved at its existing value regardless of what the request body
sends, the same way `PUT /api/catalog/:templateId` never reassigns
`sellerId` — reassigning ownership only happens through claim or auction
resolution. For the same reason, on an unowned landlet `status` is also
force-preserved at its existing value regardless of what the request body
sends — otherwise an unauthenticated caller could flip a landlet to
`status: "claimed"` with no owner ever assigned, permanently removing it
from the claimable pool with no way back. Claimed-state transitions only
ever happen through claim or auction resolution too.

The write itself is guarded on `status`/`ownerBuilderId` still matching what
this request originally read, so a claim (or auction resolution) landing
concurrently can't be silently clobbered back to the stale unowned values
this request pinned them to — a lost race returns `409` instead of the `200`
it would otherwise report despite having reverted the claim underneath it.

### `DELETE /api/landlets/:landletId`

Once a landlet has an owner, this always fails with `409` — this raw delete
has no cascade cleanup for placed instances/version history (unlike
`DELETE /api/builders/:builderId`'s careful release path), so even the true
owner using it would corrupt data; release land via deleting the builder or
losing an auction instead. Deletes an unowned landlet outright, with no
session required (see the note on `PUT`/`PATCH` above for why) — guarded the
same way against a concurrent claim landing first, returning `409` instead
of deleting land out from under its brand-new owner.

Response:

```json
{
  "deleted": true
}
```

## Live landlet layout

### `GET /api/landlets/:landletId/live`

Returns the layout selected for the shopper-facing landlet without exposing the
builder's mutable draft. The response includes the landlet, a `published`
boolean, active version metadata, and the immutable snapshotted instances.

When no version has been activated yet, the endpoint still returns `200` with
`published: false`, `version: null`, and an empty `instances` array. Once a
version is active, draft edits do not affect this response until the builder
explicitly activates another saved version.

```json
{
  "published": true,
  "version": {
    "versionId": "7f49dfe8-3a5d-4a40-8d0e-a8fabfbddc92",
    "versionNumber": 1,
    "name": "Tree by the entrance",
    "instanceCount": 1
  },
  "instances": [
    {
      "instanceId": "versioned-tree",
      "templateId": "placeholder-tree",
      "x": 3,
      "y": 4,
      "z": 0,
      "rotationZ": 0.5
    }
  ]
}
```

## Landlet drafts

The draft endpoints provide a landlet-scoped alternative to issuing one request
per placed instance. They operate on the same mutable `placed_instances` rows
used by the individual instance CRUD endpoints.

### `GET /api/landlets/:landletId/draft`

Returns all mutable draft instances for the landlet.

### `PUT /api/landlets/:landletId/draft`

Requires a session logged in as the landlet's owner (`403` otherwise) —
there's no `builderId` field on this endpoint to spoof in the first place,
so ownership is resolved through the landlet itself. Atomically replaces
the complete mutable draft. The request body is:

```json
{
  "versionName": "Initial furnished draft",
  "versionMetadata": {},
  "instances": [
    {
      "instanceId": "draft-tree",
      "templateId": "placeholder-tree",
      "x": 1,
      "y": 2,
      "z": 0,
      "rotationZ": 0.25
    }
  ]
}
```

`landletId` values supplied on individual entries are ignored in favor of the
route landlet. Instance IDs must be unique within the request, and a request may
contain at most 250 instances. An empty array clears the draft. D1 applies the
draft replacement and immutable version snapshot as one batch, so a validation
or foreign-key failure leaves both the previous draft and version history
intact. `versionName` and `versionMetadata` are optional; the default name is
`Version N`. `versionName` is capped at 100 characters (`400` past that,
#480 — see the versions endpoint below for why).

**Upsert, not delete-then-recreate:** the replacement is an upsert keyed on
`instanceId` (an `INSERT ... ON CONFLICT(instance_id) DO UPDATE`), with a
real `DELETE` only for instance IDs genuinely absent from the new array —
not a blanket delete-everything-then-reinsert. This matters because
`sign_posts`/`calendar_events` both cascade-delete on their own
`instance_id` ("Community signs"/"Community calendar" below): a plain
delete-all would silently wipe every post and event on the landlet on
*every* draft save, even for an instance that kept the exact same
`instanceId` across the save (the common case — a builder nudging an
existing sign's position, say) and so looked untouched in the response.
Resending an unchanged `instanceId` now updates that row in place instead,
leaving its posts/events alone; only actually dropping an `instanceId`
from the array deletes it (and, correctly, cascades away whatever was
posted to it). The request's `isCommunitySign`/`isCommunityCalendar` per
instance are written through on both the insert and the update path — an
earlier version of this endpoint dropped both back to `false` on every
save regardless of what a prior `PATCH /api/instances/:id` had set.

Every successful save creates a version, including a save with an empty array.
The response contains both the replacement `instances` and new `version`
metadata. SQLite JSON expansion inserts the validated instance array in one
statement, keeping the complete draft-and-snapshot save to four D1 statements
regardless of draft size for free-tier efficiency.

Individual instance CRUD calls remain low-level editing operations; this draft
replacement endpoint is the explicit save boundary that guarantees version
history.

## Landlet versions

Landlet versions are immutable snapshots of a landlet's placed instances. The
mutable `placed_instances` rows remain the builder's current draft, while a
landlet's `activeVersionId` points at the snapshot intended for shoppers.

**Frontend wiring:** the Settings modal's Build tab (`renderBuildSettingsSection`
in `src/main.js`) is the only UI surface for any of this. "Publish" saves the
current draft as a new version and activates it in one step (the common
case); each history row also offers "Set Live" (activate that version alone,
`POST .../activate`, current draft untouched) and "Restore to Editor"
(`PUT .../draft` with that version's own `instances`, replacing the live
draft — confirmed first, since it discards unsaved live edits, though the
restore itself creates one more version, so it's not actually destructive).
Shop mode (`loadShopLandletInstances`) renders a landlet's active version
when `activeVersionId` is set, and falls back to the live draft
(`GET /api/instances`) when it's `null` — i.e. a landlet that's never been
published shows shoppers the same thing a builder currently sees, which is
also what every landlet did before this feature existed.

### `GET /api/landlets/:landletId/versions`

Lists snapshot metadata newest-first. Each record includes `versionId`,
`versionNumber`, `name`, `instanceCount`, `metadata`, and `createdAt`.

Optional query parameters:

- `limit`: page size from 1 to 100; defaults to 100.
- `cursor`: opaque `nextCursor` value from the preceding page.

The response includes `nextCursor`, which is `null` after the oldest version.

### `POST /api/landlets/:landletId/versions`

Requires a session logged in as the landlet's owner (`403` otherwise).
Saves the landlet's current placed instances as a new immutable snapshot.
`name` and `metadata` are optional; omitted names default to `Version N`.
`name` is capped at 100 characters (`400` past that, #480) — the same
`labelValue`/`optionalLabelValue` short-label cap already applied to
`authorLabel`/`buyerLabel` (#337) and bundle `name` (#358); a version's
`name` is echoed straight into the Version History panel and the live
landlet's own UI, same exposure those fixes closed off elsewhere. The
draft-save endpoint's own `versionName` (above) gets the identical cap.

```json
{
  "name": "Tree by the entrance",
  "metadata": {}
}
```

Returns `201` with the newly created version metadata.

Version numbers are allocated inside the same atomic D1 batch that creates the
snapshot. Concurrent saves for one landlet therefore receive distinct,
sequential numbers rather than racing on a number calculated by an earlier
standalone read.

### `GET /api/landlets/:landletId/versions/:versionId`

Returns version metadata plus its snapshotted `instances` array. Later edits or
deletions in the mutable draft do not alter this array. Each instance's
`isCommunitySign`/`isCommunityCalendar` are captured in the snapshot too
(`migrations/0060`, mirroring how `0034`/`0036` carried `crop`/`scale` into
`version_instances` alongside `placed_instances` — `0041`/`0042` had added
the two flag columns only to `placed_instances`, so every published/live
landlet lost its community signs and calendars entirely until this closed
the gap) — a sign flagged in the draft stays flagged once published, and
`GET /api/landlets/:landletId/live` (above) reflects it.

### `POST /api/landlets/:landletId/versions/:versionId/activate`

Requires a session logged in as the landlet's owner (`403` otherwise).
Moves the landlet's active-version pointer to an existing snapshot belonging to
that landlet. This endpoint does not overwrite the builder's current draft.
The response includes both the updated landlet and selected version metadata.

## Placed instances

Placed instances represent objects placed into a landlet from catalog templates.
Their response shape intentionally includes both `instanceId` and `id` so the
frontend can bridge from the original localStorage instance shape during the
migration.

### Placed instance object

```json
{
  "instanceId": "2ddc1202-30d5-48fe-9ba3-8a8a7d9d9c8a",
  "id": "2ddc1202-30d5-48fe-9ba3-8a8a7d9d9c8a",
  "landletId": "starter-landlet",
  "templateId": "placeholder-tree",
  "x": 1.25,
  "y": -2.0,
  "z": 0.0,
  "rotationZ": 0.5,
  "label": null,
  "crop": {},
  "scale": 1,
  "isCommunitySign": false,
  "isCommunityCalendar": false,
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

`crop` holds per-axis length overrides (e.g. `{ "x": 0.6 }`) for a template
that declares itself extensible — see "Extensible products (crop)" under
Catalog templates. An axis missing from `crop` renders at the template's full
declared size. Every write endpoint below (single and batch create/update, and
the draft-replace `PUT`) validates `crop` against the referenced template's
declared extensible axes and `minM`/max-dimension bounds, rejecting anything
outside them or naming an axis the template didn't declare extensible.
`PATCH`/`PUT` on an existing single instance only re-runs this check when the
request's `crop` and/or `templateId` actually differ from the instance's
stored values, not merely whether the request body includes those keys —
the frontend always resends an instance's full current state (crop
included) on every edit, so a presence check alone would re-validate on
every request. If a seller shrinks a template (or raises its `minM`) after
an instance's crop was already validly set, that instance's carried-over
crop is not re-validated against the template's new bounds on some later,
unrelated field-only edit (moving it, renaming its label) that resends the
same crop unchanged; only a request that actually changes `crop` to a new
value, or switches `templateId` (even while reusing the same crop values,
now measured against different bounds), is checked against the template's
current bounds.

`scale` is a real uniform scale factor, unrelated to `crop` — see "Legacy
per-instance Resize scale" for why this field exists and why it's read-only
from the frontend's perspective now. `1` (the default) means "rendered at
the template's own declared size." Validated only loosely server-side (must
be a positive finite number); no UI writes a new value anymore, only the
now-removed Resize gizmo ever did, bounded then to `[0.001, 1000]`.

`isCommunitySign` flags this one specific placement as a "community sign"
— see "Community signs" below for the posts API it unlocks and the
Shop-mode rendering it drives. `isCommunityCalendar` is the same idea for
a "community calendar" (see "Community calendar" below) — the two flags
are independent, and an instance can be both at once.

### `GET /api/instances`

Lists placed instances for one landlet in stable creation order. Results are
cursor-paginated to keep draft reads bounded.

Optional query parameters:

- `landletId`: filters instances by landlet. Defaults to `starter-landlet`.
- `templateId`: optionally filters the selected landlet to instances of one
  exact catalog template.
- `limit`: page size from 1 to 100; defaults to 100.
- `cursor`: opaque `nextCursor` value from the preceding page.

The response includes `nextCursor`, which is `null` after the final page. Keep
the same `landletId` and `templateId` while following a cursor.

Response:

```json
{
  "instances": [
    {
      "instanceId": "2ddc1202-30d5-48fe-9ba3-8a8a7d9d9c8a",
      "id": "2ddc1202-30d5-48fe-9ba3-8a8a7d9d9c8a",
      "landletId": "starter-landlet",
      "templateId": "placeholder-tree",
      "x": 1.25,
      "y": -2.0,
      "z": 0.0,
      "rotationZ": 0.5,
      "label": null,
      "createdAt": "2026-07-29T07:30:06.519Z",
      "updatedAt": "2026-07-29T07:30:06.519Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /api/instances/:instanceId`

Fetches one placed instance.

### `POST /api/instances/batch`
### `PUT /api/instances/batch`
### `DELETE /api/instances/batch`

Atomically writes between 1 and 100 placed instances. Requires a session,
and every landlet touched — each instance's target `landletId`, plus (for
`PUT`) any existing instance's current `landletId`, since it can move an
instance between landlets — must belong to the calling session's builder
(`403` otherwise). Instances have no `builderId` field of their own to
check; ownership is always resolved through the landlet they sit on, the
same as every other instance endpoint below. The request body wraps
normal instance-create objects under `instances`. Instance IDs must be unique
within the request, and every referenced catalog template and landlet is
validated with bounded set queries before insertion. `POST` is create-only and
returns `201`; a duplicate stored ID returns `409`. `PUT` replaces stored IDs,
creates missing IDs, and returns `200`, making bounded draft synchronization
idempotent. An invalid reference returns `400`; any failure leaves the entire
batch unchanged. Success returns the instances in request order.
Returned instances are read back from D1, so database-managed `createdAt` and
`updatedAt` timestamps are included just as they are on normal instance reads.

`DELETE` accepts 1–100 unique IDs under `instanceIds`. Every ID is preflighted
before deletion; a missing ID returns `404` and leaves the entire batch
unchanged. Requires a session, and every one of the deleted instances'
`landletId`s must belong to the calling session's builder (`403` otherwise).
Success returns `deletedInstanceIds` in request order.

### `POST /api/instances`

Requires a session logged in as the target landlet's owner (`403`
otherwise). Creates a placed instance. `instanceId`/`id` is optional; if
omitted, the Worker generates one. `landletId` defaults to `starter-landlet`.
The response is read back from D1 and includes database-managed timestamps.

Request body:

```json
{
  "landletId": "starter-landlet",
  "templateId": "placeholder-tree",
  "x": 1.25,
  "y": -2.0,
  "z": 0.0,
  "rotationZ": 0.5,
  "label": null
}
```

Required fields:

- `templateId`
- `x`
- `y`

`z` defaults to `0`. `rotationZ` defaults to `0`. Position and rotation fields
must be finite numbers.

### `PUT /api/instances/:instanceId`
### `PATCH /api/instances/:instanceId`

Requires a session logged in as the owner of the instance's current
landlet, and (if the update moves it) its new target landlet too (`403`
otherwise). Updates a placed instance. The current implementation merges
request fields with the existing instance before validation.

### `DELETE /api/instances/:instanceId`

Requires a session logged in as the owner of the instance's landlet (`403`
otherwise). Deletes a placed instance.

Response:

```json
{
  "deleted": true
}
```

## Notifications

Builder-facing notifications. The table is deliberately generic (a plain
`message` string, not a typed event per notification kind) so new sources
can be added without their own table or endpoints — current sources are:

- A seller changing a placed template's real-world dimensions (see "Editing
  a product's size" under "Managing extensibility — the Seller modal"
  above) — the original and only source with a `templateId` set (below).
- Land acquisition auctions (see "Land acquisition auctions" below): a new
  bid (seller notified), being outbid (previous highest bidder notified),
  an auction selling (seller and winning bidder both notified), an auction
  ending with no bids (seller notified either way — kept the land, or
  released to greenbelt if it had a $0 starting bid), and an auction voided
  because the seller's account was deleted (every bidder notified).
- A product sale or its refund (see "Simulated purchases" below): the
  builder hosting the sold instance is notified of the commission earned,
  or clawed back on refund.
- A friend request or its acceptance (see "Friendship object" below): the
  recipient is notified of a new request, and the requester is notified
  once it's accepted.

There's no pagination cursor — one builder's outstanding count is expected
to stay small — and no `DELETE`, since a read notification is still useful
history ("wait, when did that change?").

### Notification object

```json
{
  "notificationId": "notification-3f1a9c20-9e44-4b7a-8c3d-1a2b3c4d5e6f",
  "builderId": "builder-7f3a1c20-9e44-4b7a-8c3d-1a2b3c4d5e6f",
  "message": "\"Oak Table\" was resized by its seller to 1.20m x 0.80m x 0.75m — you have one placed. Check that it still fits where you put it.",
  "templateId": "3c2b1a90-...",
  "createdAt": "2026-08-24T00:00:00.000Z",
  "readAt": null
}
```

`templateId` is set null (not cascaded) if the referenced template is later
deleted — the message text already names the product, so the notification
stays meaningful without a live template to point back at.

### `GET /api/notifications`

Requires a session. Lists the calling account's own notifications, newest
first, cursor-paginated (issue #320) the same way as this API's other
paginated lists (e.g. `/catalog`, `/auctions`) — `limit` (default and max
100) and `cursor`/`nextCursor`, ordered `created_at DESC, notification_id
DESC` (the tiebreak matters here since several notifications can share the
same `created_at`, unlike this API's ascending-ordered lists). `builderId`
is an optional query parameter — omitted, it defaults to the session's own
builder; if present, it must equal the session's own builder ID (`403`
otherwise — this was a spoofable "whose notifications" field before
session-based authorization, see "Authorization model" above).
`unreadOnly=true` narrows the list to `readAt IS NULL` server-side, for the
frontend's full history list (the unread badge count uses
`GET /api/notifications/unread-count` below instead, which has no page
cap at all, rather than paging through this list just to count).

### `GET /api/notifications/unread-count`

Requires a session. Returns `{ "count": N }` — the calling account's own
unread notification count via a plain `SELECT COUNT(*)`, with no cap.
Exists because reading `GET /api/notifications?unreadOnly=true`'s own
list — even now that it's paginated — would mean paging through
potentially many requests just to count "how many unread" (e.g. a popular
auction generating one bid notification per bid); the frontend's
notification badge uses this endpoint instead, never that list's length.

### `PATCH /api/notifications/:notificationId`

Requires a session logged in as the notification's own builder (`403`
otherwise). Marks one notification read. Request body: `{ "read": true }`.
Returns `404` if the notification doesn't exist.

### `POST /api/notifications/mark-all-read`

Requires a session. Marks every one of the calling account's own unread
notifications read at once. No body — `builderId` is derived from the
session, never a client-supplied field.

### How a notification gets created

`PATCH /api/catalog/:templateId` (see "Catalog templates" above) compares
the request's `dimensions` against the template's stored values before
applying the update. If any axis actually changed (beyond float rounding
noise), it looks up every distinct builder who owns a landlet with a placed
instance of that template (`placed_instances` joined to `landlets` on
`owner_builder_id`), and inserts one notification per affected builder in a
single `db.batch()` alongside the update — so a pure rename, price change,
or extensibility edit creates no notifications at all, only an actual size
change does.

## Friend requests

docs/SPEC.md §2: "Friend/group systems: standard friend requests; social
map shows friends' approximate location." One `friendships` row (see
`migrations/0049_friendships.sql`) per relationship, shared by both
builders — direction preserved (`requesterBuilderId`/`recipientBuilderId`)
so the frontend can tell "I sent this" from "I received this" without a
second table, and `status` flips from `pending` to `accepted` in place
rather than deleting and recreating the row on accept. `PATCH` (accept) is
gated to the recipient's own session, and `DELETE` to either party's — see
each endpoint's own note below.

**"Social map ... approximate location" is deliberately simplified** to
each accepted friend's own claimed lándlet center, not a live position —
this app has no avatar presence tracking at all (Shop-mode camera position
is never persisted anywhere), so there is no real "current location" to
report regardless of how this endpoint were built. A builder's claimed
lándlet is the one stable, already-known location the backend actually
has for them. The frontend renders this as plain text in the Friends
modal, not an actual graphical map widget — a real map would need its own
renderer/camera the way the claim flyover does (a full WebGL scene), which
isn't justified just for a small modal list. Shipping the underlying "where
do my friends live" data first, with a graphical map as a possible later
enhancement, follows the same "honest simplest form first" precedent as
the scheduled-event confetti effect and its own one-shot trigger.

### Friendship object

```json
{
  "friendshipId": "friendship-3f1a9c20-9e44-4b7a-8c3d-1a2b3c4d5e6f",
  "requesterBuilderId": "builder-alice",
  "recipientBuilderId": "builder-bob",
  "status": "pending",
  "createdAt": "2026-08-25T00:00:00.000Z",
  "otherBuilderId": "builder-bob",
  "otherLabel": "Bob",
  "direction": "outgoing",
  "otherLandlet": { "landletId": "starter-landlet", "name": "Starter landlet", "center": { "x": 0, "y": 0 } }
}
```

The last four fields (`otherBuilderId`/`otherLabel`/`direction`/
`otherLandlet`) are computed relative to whichever `builderId` the request
was made as — the same row looks different depending on who's asking (see
`GET` below). `otherLandlet` is `null` if that builder hasn't claimed a
lándlet yet, and picks the first one found if they somehow own more than
one (auctions can transfer extra ones in) — good enough for "approximate
location," not a claim about which one is their "real" home.

### `GET /api/friendships?builderId=X`

Requires a session. Lists every friendship involving `X`, both directions,
both `pending` and `accepted`, newest first. `builderId` is optional —
omitted, it defaults to the session's own builder; if present, it must
equal the session's own builder ID (`403` otherwise).

### `POST /api/friendships`

Requires a session. Sends a friend request as the calling account's own
builder — `requesterBuilderId` is never read from the request body (a
spoofable "who's sending this" field before session-based authorization);
`recipientBuilderId` stays a genuine request field, since naming a target
isn't a claim of identity.

```json
{ "recipientBuilderId": "..." }
```

`400` if `recipientBuilderId` is the caller's own builder, or doesn't
reference an existing builder. `409` if a friendship or pending request
already exists between the two builders **in either direction** — sending
B→A when A→B is already pending doesn't create a second row; the existing
one has to be accepted or declined first. Returns `201` with the new
`pending` friendship. Notifies `recipientBuilderId` (the generic
notification system below, not a dedicated channel). `429` after 20
requests per 15 minutes from the same calling builder (see "Rate limiting"
above) — the 409 above only guards a repeat against the same recipient, so
this is what stops one account cycling through fresh recipients to spam
notifications.

### `PATCH /api/friendships/:friendshipId`

Requires a session logged in as the friendship's `recipientBuilderId`
(`403` otherwise — only the recipient can accept a request; the requester
accepting their own would skip the other side's consent entirely). Accepts
a request: `{ "status": "accepted" }` is the only valid body — `400` on
anything else. `404` if the friendship doesn't exist. There is no
"decline" status; declining a pending request or removing an accepted
friendship are both just `DELETE`. Notifies the `requesterBuilderId`.

### `DELETE /api/friendships/:friendshipId`

Requires a session logged in as either the `requesterBuilderId` or the
`recipientBuilderId` on this friendship (`403` otherwise). Removes a
friendship outright — covers declining a still-pending request, canceling
one you sent, and unfriending an accepted one, all the same way. `404` if
it doesn't exist.

### Frontend wiring

`#friends-btn` sits in a second row under Identity/Notices/Settings (a
measured layout check found only ~38px of clearance between `#settings-btn`
and `#mode-nav` on a narrow viewport — not room for a fourth pill there),
badged with the pending-incoming count exactly like `#notifications-btn`.
`#friends-modal` has three sections — Requests (incoming pending, Accept/
Decline), Sent (outgoing pending, Cancel), and Friends (accepted, with the
approximate-location text and a Remove button) — all sharing one
`.friend-row` look with different actions per section. "+ Add Friend"
`prompt()`s for the other builder's exact label, resolves it against the
full builder roster (`fetchBuilders()`, case-insensitive exact match), and
sends the request — an unmatched or ambiguous label surfaces as a status
message rather than a dead end. The badge (like Notices' own) only
refreshes on bootstrap and on modal close, not while a request arrives with
the modal already open or the app otherwise idle — no live updates
anywhere else in this app either.

### Testing note

`worker/profiles.test.js`'s "Friendships" describe block owns the full
contract: self-request rejection, unknown-builder rejection, the send/
list/accept lifecycle with direction and `otherLandlet` verified from both
sides, duplicate-request rejection in either direction, decline (`DELETE`
while pending) freeing the pair to request again, removing an accepted
friendship, and the invalid-status-transition `400`. `e2e/friends.test.mjs`
drives two real browser sessions (mirroring `e2e/land-auctions.test.mjs`'s
own two-party pattern) through the actual UI: Alice sends Bob a request via
the real "+ Add Friend" prompt, Bob sees and accepts it, both sides then
show each other with their lándlet's location, and a separate pending
request to a third builder is canceled from the sender's own Sent list.
Answering the "+ Add Friend" prompt with a different name than the
session's own identity name needed `page.removeAllListeners('dialog')` to
swap in a one-off handler, since `helpers.mjs`'s own dialog handler answers
every prompt in a session with one fixed string.

## Bundles

A bundle is a named, persisted group of placed items a builder can stamp
down together again later — a durable version of the same relative-offset
shape the frontend's own Copy/Paste already builds in memory for one
session (`relativeItemsForMeshes`/`placeClipboardItems` in `src/main.js`;
see docs/SPEC.md §3's "group items to move together"). Private by default;
`shared` is the spec's own "explicit opt-in sharing to a community bundle
tab" — see `migrations/0040_bundle_sharing.sql`. A shared bundle is still
owned by whoever created it: `shared` only controls whether *other*
builders can see and place it, never whether they can rename/reshare/delete
it: `GET`/`POST`/`PATCH`/`DELETE` are all gated to the calling session's
own builder (see "Authorization model" above) — sharing never transfers
ownership.

### Bundle object

```json
{
  "bundleId": "bundle-7f3a1c20-9e44-4b7a-8c3d-1a2b3c4d5e6f",
  "builderId": "builder-3c2b1a90-...",
  "name": "Brick Pair",
  "items": [
    { "templateId": "brick", "dx": -0.1, "dy": 0, "dz": 0, "rotationX": 0, "rotationY": 0, "rotationZ": 0, "crop": {}, "scale": 1 },
    { "templateId": "brick", "dx": 0.1, "dy": 0, "dz": 0, "rotationX": 0, "rotationY": 0, "rotationZ": 1.57, "crop": {}, "scale": 1 }
  ],
  "shared": false,
  "createdAt": "2026-08-24T00:00:00.000Z",
  "updatedAt": "2026-08-24T00:00:00.000Z"
}
```

Each item's `dx`/`dy` are offsets from the group's centroid and `dz` is
height above the group's lowest bottom surface (its "base") — not absolute
coordinates — so the same bundle can be re-anchored anywhere a builder taps
next. `rotationX`/`rotationY`/`rotationZ`, `crop`, and `scale` carry each
item's own orientation/crop/uniform-scale through unchanged. This is
exactly the shape `POST /api/instances/batch` and the frontend's own
`placeClipboardItems` already expect for "here's a group, anchor it here" —
loading a bundle needs no translation before it can be placed.

### `GET /api/bundles`

Two independent listings, not one filtered by both:

- `?builderId=X` (or no query at all) — requires a session; `X` must equal
  the session's own builder ID if present (`403` otherwise), and defaults
  to it if omitted. That builder's own bundles, newest first, capped at 100
  (shared or not — a builder's own shared bundles keep showing here too,
  they just *additionally* surface in the community listing below).
- `?shared=true` — the community tab: every builder's shared bundles,
  newest first, capped at 100, no session required. `builderId` is
  ignored/not required here.

Exactly one of the two query parameters is expected per call; there's no
mode that combines "this builder's bundles, restricted to shared ones."

### `POST /api/bundles`

Requires a session. Creates a bundle owned by the calling account's own
builder — `builderId` is derived from the session, never a client-supplied
field. Request body: `{ "name", "items", "shared"? }`.
`shared` defaults to `false` (private) if omitted or not literally `true`.
Each item's `templateId` must reference an existing catalog template
(checked in one batched query, same pattern as the instance batch
endpoints); `items` must be a non-empty array, capped at 250 entries like an
instance batch save. `dx`/`dy`/`dz` and the rotation fields may be negative
or zero — only `crop`/`scale` reuse the stricter validation a placed
instance itself gets (`validateCropShape`/`validateScale`), since those two
are genuinely sign-constrained.

### `PATCH /api/bundles/:bundleId`

Requires a session logged in as the bundle's own builder (`403`
otherwise). Updates `name` and/or `shared` — both optional and independent;
omitting one leaves it at its current value rather than requiring the full
object back — the frontend's Rename button only ever sends `{ name }`.
There's no way to edit a saved bundle's `items` — the frontend has no
UI for that; delete and re-save from a fresh selection instead.

### `DELETE /api/bundles/:bundleId`

Requires a session logged in as the bundle's own builder (`403`
otherwise). Deletes a bundle. Response: `{ "deleted": true }`. Returns `404` if it
doesn't exist.

### Frontend wiring

A "Save Bundle" button sits next to Copy in `#gizmo-mode-controls`,
available under the same conditions Copy is (≥1 item selected, single- or
multi-select). Naming the bundle (a plain `prompt()`, same as every other
dev-mode rename in this app) is followed by a `confirm()` asking whether to
share it — private stays the one-tap default, sharing is the explicit extra
step the spec calls for.

Add Item's catalog picker gets a bundle section below the ordinary product
grid, with "My Bundles" / "Community" tabs (`renderBundlePicker` in
`src/main.js`) — hidden entirely only when *both* lists are empty, so a
builder who's never saved a bundle themselves still gets to discover
Community if a neighbor has shared one. Tapping a tile arms placement with
`enterPlacementMode({ type: 'clipboard', items: bundle.items })`, the exact
same pending-placement shape a Paste uses, so `handlePlacementClick`'s
existing clipboard-placement path needs no changes to place a bundle.

A tile only shows its rename (✎), share-toggle (⇧/⇩), and delete (×)
buttons when `bundle.builderId` matches the active builder — the one place
the frontend actually enforces the ownership the backend doesn't (see this
section's own opening paragraph). All three use separate CSS classes
(`.bundle-tile-rename` / `.bundle-tile-share` / `.bundle-tile-delete`)
despite an identical look, not a shared one — a selector meant for one must
never accidentally hit another (this bit a test once already — see the
share-toggle's own comment in `src/main.js`).

## Community signs

docs/SPEC.md §6's in-world social feed: "Builders flag any placed object as
a 'community sign' — becomes a content-bearing slot. Shopper-authored posts
fade in/out based on proximity — zero explicit clicking required" (the
"no flat 2D UI layer, ever" rule the spec states right above that). Unlike
flooring (`metadata.flooring` on a catalog *template*, migrations/0035),
`isCommunitySign` lives on the placed *instance* itself
(`migrations/0041_community_signs.sql`) — any single placement of any
product can become a sign independently of every other copy of it, since
flagging is a builder decision about one specific spot, not about the
product.

### Instance shape

`isCommunitySign` (boolean, defaults `false`) is just another field on the
ordinary placed-instance object (see "Placed instances" above) —
set/cleared through the same `PATCH /api/instances/:id` every other
per-instance change already goes through, nothing new on that endpoint
itself.

### `GET /api/instances/:instanceId/posts`

Lists the newest 200 posts on that sign, oldest first (within that window),
plus a real `totalCount` (uncapped `COUNT(*)`) so a client can tell the
list is truncated — `#356` fixed this from an earlier uncounted `LIMIT 200`
with no `DESC`, which always selected the *oldest* 200 posts overall once a
sign passed 200, silently hiding every post made after that (the newest
ones always fell outside that window and could never appear). The response
array's own order is unchanged (oldest first) — only which 200 rows the
`LIMIT` window selects changed — since `rebuildSignSprites` (`src/main.js`)
depends on that ordering to grab the *most recent* posts via
`.slice(-SIGN_MAX_VISIBLE_POSTS)`. `404` if the instance doesn't exist.
Returns `{ "posts": [...], "totalCount": <number> }` where each post is:

```json
{
  "postId": "post-...",
  "instanceId": "placeholder-tree-...",
  "authorLabel": "A Shopper",
  "text": "Great little shop!",
  "createdAt": "2026-08-24T00:00:00.000Z"
}
```

### `POST /api/instances/:instanceId/posts`

Body: `{ "authorLabel", "text" }`, both required, `text` capped at 280
characters and `authorLabel` at 100 (same cap `buyerLabel`/review
`authorLabel` share, see "Simulated purchases"/"Product reviews" below).
`400` if the target instance isn't currently flagged `isCommunitySign` —
a post can't outlive or predate the flag that makes it visible at all.
`404` if the instance doesn't exist. Unauthenticated and rate-limited per
client IP, the same as the purchase endpoint below.

### `DELETE /api/instances/:instanceId/posts/:postId`

Moderation — "Builder controls the sign's physical form and moderates."
Requires a session logged in as the owner of the sign's own hosting
landlet (`403` otherwise) — not the post's author, since `authorLabel` is
free text with no account behind it. `404` if the post doesn't exist (or
belongs to a different instance). Deleting the sign instance itself
cascades to every post on it (`ON DELETE CASCADE`, migrations/0041) — no
orphaned posts left behind.

`GET`/`POST` above stay open to any shopper — posting to a community sign
is exactly the shopper-facing feature this exists for, and `authorLabel`
is plain free text, not an authenticated identity.

### Frontend wiring — Build mode

A "Community Sign" toggle sits in `#gizmo-mode-controls` next to Save
Bundle, enabled only for a single-item selection (same reasoning as Trim —
"which one sign" has no group answer). The first click flips
`mesh.userData.isCommunitySign` to `true` and re-syncs the mesh through
the ordinary `syncUpdate` path (see `instanceFromMesh`) — no dedicated
endpoint call, identical to how an ordinary move/rotate persists. Once
already flagged, clicking the *same* button again opens `#sign-posts-modal`
(below) instead of un-flagging directly — un-flagging moved inside that
modal's own "Remove Community Sign" button.

This two-purposes-one-button design replaced an earlier version with a
separate, always-present "Manage Posts" button next to it. That version
shipped a real layout bug: on a phone-width viewport, `#gizmo-mode-controls`
wraps its buttons across several rows, and one more button was enough to
push the row's total height down far enough to physically overlap the 3D
canvas beneath it — silently swallowing taps meant for a placed item
(caught by `e2e/bundles.test.mjs`, an unrelated test, suddenly failing to
select a placed tree). Folding the two actions into one button removes
that extra row. The container was also given an explicit `width: 94vw`
alongside its existing `max-width: 94vw` for the same reason: a wrapping
flex row with only `max-width` set shrinks to whatever *narrower* "optimal
line-breaking" width the browser picks (it minimizes line count, not
row width), which packs noticeably fewer buttons per row — and therefore
grows noticeably taller — than the actual space budget allows.

`#sign-posts-modal` is the same modal shell `#notifications-modal` already
establishes, reused for its shape but not its classes (`.sign-post-row`,
not `.notification-row` — see that CSS rule's own comment on why this
project keeps a class per genuinely different element even when the look
is identical). Build mode itself never renders a sign's post sprites
(those are Shop-mode-only, see below), so this modal is the only place a
builder ever sees what's actually been posted. Each row's only action is
a delete (×) button calling `DELETE .../posts/:postId` and re-rendering
the list; the modal's own "Remove Community Sign" button un-flags the
instance (`isCommunitySign = false`, synced the same way the initial flag
was set) and closes the modal.

### Frontend wiring — Shop mode

Every loaded sign gets its posts fetched once as it enters the scene
(`registerShopSign` in `src/main.js`) and rendered as one canvas-texture
`THREE.Sprite` per post (`makeSignPostSprite`), stacked vertically above
the sign's own footprint (using `meshDimensions` for the base height, the
same shared function flooring's own fix keeps consistent — see "Ground/
flooring products" above). Sprites always face the camera on their own
(a `THREE.Sprite` built-in), so no manual billboarding is needed.

`updateSignFade`, called every Shop-mode frame (not throttled like
`updateShopProximity`, so the fade itself reads smoothly rather than in
400ms steps), does two things: sets every visible sign's post-sprite
opacity from a linear falloff between `SIGN_FADE_NEAR_M` (4m, fully
opaque) and `SIGN_FADE_FAR_M` (20m, fully transparent) — the spec's own
"size/opacity as a function of distance" — and tracks whichever single
sign (if any) is within the much tighter `SIGN_INTERACT_RADIUS_M` (8m),
showing `#shop-sign-hint` ("Leave a Note") only for that one.

Leaving a note is two `prompt()` calls — a name (remembered afterward in
`localStorage` under `higglehaven.shopperLabel` so a returning or prolific
poster isn't re-asked every time) and the note text — then
`createSignPost` followed by an optimistic local append and
`rebuildSignSprites`, rather than re-fetching the whole list. This is the
one place in Shop mode that's a plain browser dialog rather than in-world
geometry; the spec's "no flat 2D UI, ever" rule reads as being about the
persistent *feed itself* (which this fully honors — no panel, no list, no
scrollable UI), not about a one-shot text-entry prompt, and every other
dev-mode naming flow in this app already uses the identical pattern.

Signs and their sprites are torn down alongside the rest of their
landlet's objects in `unloadShopLandletInstances` — a sign is exactly as
"loaded" as anything else on its landlet, not tracked on its own load
radius.

### Testing note

`e2e/community-signs.test.mjs` covers the Build-mode toggle-then-manage
button (flag on, second click opens the panel), the Manage Posts panel
itself (row count/content, deleting a post through its own × button and
confirming that persists server-side, and un-flagging via "Remove
Community Sign"), and the full posts API
(create/list/delete/cascade-on-instance-delete, plus the "can't post to a
non-sign" 400 — that last one in `worker/land.test.js` instead, not the
browser suite, since deliberately triggering a non-2xx `fetch` there logs
a console error the suite's own errors-must-be-empty convention would
misread as a real bug) end to end through the browser. The
Shop-mode camera-distance fade and the `prompt()`-driven "Leave a Note"
flow are **not** covered by the automated suite, for the same reason raw
TransformControls drags aren't (see "Frontend-only alignment assist"
above) — real camera movement and native browser dialogs are exactly the
kind of interaction this project's e2e suite has consistently avoided
automating, in favor of an equivalent non-drag write path where one exists
(here, the same `POST .../posts` the button itself calls). Verified
manually instead: a temporary `window.__debugAlign.camera` hook (removed
before committing) let a script set the shopper's position directly,
confirming sprite opacity reads ~0 far away and ~1 up close, `#shop-sign-
hint` shows/hides exactly at `SIGN_INTERACT_RADIUS_M`, posts fetch and
render correctly, and clicking through both prompts appends a real post
and a matching new sprite. That same manual pass caught a real bug before
it shipped: `#shop-sign-hint`'s first CSS placement (`bottom: 68px`,
centered) directly overlapped `#shop-vertical-controls` (`bottom: 78px`,
also centered) — the up/down flight buttons' own invisible-when-inactive
hit area silently ate every tap intended for the note button. Fixed by
moving it to `bottom: 180px`, clear of that column entirely.

## Community calendar

docs/SPEC.md §6: "Community calendar reuses the identical pattern
[as community signs], **builder-authored** (event postings, creative-tool
support like a scheduled confetti-cannon trigger)." A near-twin of
"Community signs" just above — same per-instance opt-in flag
(`isCommunityCalendar`, `migrations/0042_community_calendar.sql`), same
nested-under-the-instance events collection (`calendar_events`, a separate
table from `sign_posts`), same toggle-then-manage Build-mode button — but
**not** identical on POST: the spec's own wording explicitly distinguishes
calendar events (builder-authored) from sign posts (shopper-authored), and
`POST .../events` enforces that distinction, unlike `POST .../posts`
above. Deliberately kept as its own independent flag/table rather than
merged into one generic "community board" concept — see migrations/0042's
own comment: calendar events are the more likely of the two to grow real
fielded data later (an actual date/time, RSVPs), at which point a shared
abstraction would need reworking anyway, so duplicating a small,
well-understood pattern now is cheaper than guessing at that shared shape
today. The "creative-tool support like a scheduled confetti-cannon
trigger" half of the spec sentence is explicitly out of scope here — a
stated example of where the feature *could* grow, not a requirement of it.

An instance can be a sign and a calendar at once (independent flags,
independently toggled and moderated) — nothing in the spec says a builder
must choose one or the other for a given placed object.

### `GET /api/instances/:instanceId/events`, `POST .../events`, `DELETE .../events/:eventId`

Same shape as the sign posts endpoints above, with `event`/`events` in
place of `post`/`posts` and `eventId` in place of `postId`:
`{ eventId, instanceId, authorLabel, text, createdAt }`, `text` capped at
280 characters, `GET` newest-200-plus-`totalCount` the same way (`#356`),
`POST` rejected with `400` unless the target instance is currently flagged
`isCommunityCalendar`, deletion cascades when the instance itself is
deleted.

**`POST` is not open the way sign posts' is.** Requires a session logged
in as the hosting landlet's own owning builder (`401`/`403` otherwise, via
`requireSessionBuilder` + `requireOwnedLandlet` — the same ownership gate
`DELETE` on either endpoint already uses) — the client no longer sends
`authorLabel` at all; it's derived server-side from that builder's own
`label`. Without this, any shopper could post an event under an
arbitrary/spoofed `authorLabel` — including a real builder's own name —
directly contradicting docs/SPEC.md §6's "builder-authored" distinction
from sign posts' genuinely anonymous, shopper-authored `authorLabel`.

### Frontend wiring

"Community Calendar" sits in `#gizmo-mode-controls` right after Community
Sign, with the identical toggle-then-manage design (first click flags it,
a second click while already flagged opens `#calendar-events-modal`
instead of un-flagging — moderation and un-flagging both live inside that
modal, mirroring `#sign-posts-modal`). In Shop mode, `registerShopCalendar`/
`rebuildCalendarSprites`/`updateCalendarFade` mirror their sign
counterparts exactly, down to reusing `makeSignPostSprite` directly (it's
generic single-line text-sprite rendering with nothing sign-specific in
its implementation) and the same `SIGN_FADE_NEAR_M`/`SIGN_FADE_FAR_M`/
`SIGN_INTERACT_RADIUS_M`/`SIGN_MAX_VISIBLE_POSTS` constants — these are
generic "how far can you read floating in-world text" thresholds, not
anything sign-specific, so there was nothing calendar-specific to tune
separately. `#shop-calendar-hint` ("Add an Event") sits at a different
fixed vertical offset (`bottom: 230px`) than `#shop-sign-hint`
(`bottom: 180px`) so both can show at once near an overlapping sign and
calendar without colliding — each is a plain fixed-offset placement rather
than the dynamic flex-wrap layout that caused the overlap bug described
in "Community signs" above, so this pairing doesn't share that risk.

One deliberate divergence from the sign flow: `#shop-sign-hint`'s click
handler calls the anonymous `shopperLabel()` prompt, but `#shop-calendar-
hint`'s calls `ensureBuilderIdentity()` instead (the same sign-up/log-in
flow Build/Sell mode entry already uses) — matching the POST endpoint's
own builder-only enforcement above. A logged-in builder who isn't that
landlet's owner still sees the hint (Shop mode has no per-instance
ownership context to gate the hint's visibility on) and gets a clear `403`
surfaced through the existing `alert(err.message)` on attempting to post —
a known, deliberately out-of-scope gap (hiding the hint itself for
non-owners) rather than a silent failure.

### Testing note

`e2e/community-calendar.test.mjs` mirrors `e2e/community-signs.test.mjs`
exactly (see that file's own testing note for what it covers and why the
Shop-mode fade/posting flow is verified manually instead of automated).
The manual pass here also confirmed `#shop-calendar-hint` shows/hides
correctly at `SIGN_INTERACT_RADIUS_M` and that adding an event via the
button appends both a real event and a matching new sprite, using the
same temporary `window.__debugAlign.camera` hook (removed before
committing).

## Product reviews

docs/SPEC.md §5's "Review incentives: small higgle bonus for genuine,
substantive reviews, capped per account/period." The higgle-bonus half is
explicitly out of scope here, same reasoning "Community calendar" gave for
carving out its own out-of-scope half: there is no shopper account/balance
concept anywhere in this app to credit a bonus to — only builders ever hold
higgles, and only for their own commission earnings. This covers the
reviewable-content half only.

**Purchase-gated (standard marketplace practice):** only a shopper who has
actually bought the product can review it. There's no real account system
here to check purchase history against, so eligibility is matched the same
free-text-label way a purchase's own optional `buyerLabel` already is
elsewhere (migrations/0051_purchases.sql) — `POST .../reviews` requires a
real row in `purchases` for this `template_id` whose `buyer_label` matches
the review's `authorLabel`, case-insensitively (`400` otherwise). An
anonymous purchase (`buyerLabel` left blank, "buy one, anonymously") can't
back a review under anyone's name — the shopper needs to have used the
same label both times, the same "no accounts, just labels" constraint this
identity system carries everywhere else it's used. `authorLabel` is capped
at 100 characters, same as `buyerLabel` and sign-post `authorLabel`. Any
purchase counts,
refunded or not — but a `template_id`/`author_label` pair (case-insensitive)
can only ever back **one** review (migrations/0059, a `UNIQUE INDEX`
enforced at the DB level): the purchase gate above is a one-time
eligibility check, not a per-review consumption check, so without this cap
the same purchase could otherwise back an unbounded number of reviews
under one label, directly skewing `averageRating`. The existence check and
the `INSERT` are folded into one atomic statement (`INSERT ... SELECT ...
WHERE NOT EXISTS (...)`, same idiom `checkRateLimit` uses) rather than a
separate `SELECT` then `INSERT`, which would be a check-then-act race
between two concurrent submits under the same label — `409` either way,
never a raw constraint error. Deleting the existing review frees that
label to review again. This matches docs/SPEC.md §5's review
incentives being "capped per account/period" — the purchase-matched
`author_label` is this app's closest thing to an account.

**Corrected design (this section originally attached reviews to a
builder-flagged placed instance, cloning the community sign/calendar
pattern — see `migrations/0048_product_reviews_on_template.sql` for the
fix):** a review is inherently about the *product*, not about wherever a
particular placed copy of it happens to be displayed. Reviews attach to the
catalog **template** — `product_reviews.template_id` references
`catalog_templates`, not `placed_instances` — with **no opt-in flag at
all**: every catalog template is already product-like by definition (see
"Catalog templates" above), so every one of them is reviewable, the same
way any real marketplace listing can be reviewed regardless of who displays
it. This also means the same review list is shared by every placement of a
given product, and moderation lives with the **seller** in the Seller
modal, not with whichever builder happens to have placed a copy of it — the
seller is the one with an actual stake in the product's reputation, and
(unlike community signs/calendar, which really are about a builder's own
curated space) there's no reason a review would belong to a builder who
merely bought/placed the item.

### `GET /api/catalog/:templateId/reviews`, `POST .../reviews`, `DELETE .../reviews/:reviewId`

Nested under the catalog template, same shape as sign posts/calendar
events, with one addition: `rating`, a required integer from 1 to 5 (`400`
outside that range or non-integer). `text` is genuinely optional here — a
bare star rating is already a complete, useful review — capped at 280
characters when present. `POST`/`DELETE` return `404` for a template that
doesn't exist. `POST` additionally requires a matching purchase (see the
purchase-gating paragraph above) — `400` without one, `409` if that same
purchaser label has already reviewed this template. `DELETE`
(moderation) requires a session (`401` without one) and is gated to the
template's own seller once it has one — `403` for anyone else — the same
`if (existing.seller_id)` ownership check the catalog template's own
PATCH/DELETE handler uses; a template with no seller stays unrestricted,
since there's no owner to check against.

```json
POST /api/catalog/:templateId/reviews
{ "authorLabel": "...", "rating": 5, "text": "Lovely product!" }
```

`GET`'s response carries the raw list plus a computed summary, so no caller
needs to re-derive it from the list itself:

```json
{ "reviews": [ { "reviewId": "review-...", "templateId": "...", "authorLabel": "...", "rating": 5, "text": "Lovely product!", "createdAt": "..." } ], "averageRating": 4, "count": 2 }
```

`averageRating` is `null` when there are no reviews yet (never `0`, which
would misleadingly read as "rated, and rated at the bottom"). `reviews`
itself is capped at 200 (oldest first), but `averageRating`/`count` are
computed via a separate, unlimited aggregate query — the product's real,
all-time summary regardless of how many reviews it has, not just the
returned page's. Deleting a catalog template cascades its reviews.

### Frontend wiring

Moderation lives in the Seller modal's own per-product row (`#seller-list`,
see "Sellers" above for how that row itself is built): a collapsed "Reviews"
panel, the same idiom as that row's existing Extensibility panel — fetched
lazily on first open, showing the averaged star summary plus each review
with its own delete button. There is no Build-mode toggle or modal for
this at all; a builder placing a copy of a reviewable product has nothing
to opt in or moderate.

In Shop mode, every loaded placed instance registers into `shopReviews`
unconditionally (`registerShopReview`, keyed by the instance's underlying
`templateId` rather than its own `instanceId`) — no flag gates this the way
`isCommunitySign`/`isCommunityCalendar` gate their own registration.
`rebuildReviewSprites`/`updateReviewFade` otherwise mirror the sign/
calendar machinery exactly, reusing `makeSignPostSprite`,
`SIGN_FADE_NEAR_M`/`SIGN_FADE_FAR_M`/`SIGN_INTERACT_RADIUS_M`/
`SIGN_MAX_VISIBLE_POSTS`, and the per-frame `updateShopMovement` hook.
`#shop-review-hint` ("Rate this Product") sits one slot higher than
`#shop-calendar-hint` (`bottom: 280px` vs. `230px`/`180px`) so it can show
alongside a sign/calendar hint without colliding — since every instance is
now reviewable, this hint is visible near almost anything a shopper walks
up to, which is the intended (if occasionally busy) result of reviews being
about the product rather than a curated slot.

Each placement fetches its product's review list independently rather than
sharing a per-template cache across every loaded instance of the same
product — a shopper posting a review near one placement won't instantly
update another loaded instance of the same product elsewhere, an edge case
rare and purely cosmetic enough that the added bookkeeping isn't worth it.

Rating is collected via a `prompt()` asking for a whole number 1-5
(re-prompted with an `alert()` on anything else), then an optional second
`prompt()` for a text comment — mirroring the calendar hint's own optional
third step for scheduling. In-world, each review renders as floating fading
text reading `"<author> ★★★☆☆: <text>"` (or just the author/stars when no
text was left), stacked the same way sign posts/calendar events are.

### Testing note

`worker/reviews-auth.test.js`'s "Product reviews" describe block owns the full
contract against freshly-created catalog templates (empty list, validation,
rating bounds, optional text, averaged summary, averageRating/count staying
correct past the list's own 200-row cap, moderation delete (both an
unowned template's unrestricted delete and a seller-owned template's
`401`/`403`/owning-seller-succeeds gate), independence between two
different templates' review lists, cascade delete
when the template itself is deleted, and the purchase gate itself — no
purchase, an anonymous-only purchase, and a real matching purchase
including the case-insensitive label match — including the `404` for
posting to a template that doesn't exist). `e2e/product-reviews.test.mjs`
uploads a real seller-owned priced product (same flow as
`e2e/flooring.test.mjs`), "buys" it via the same API the in-world
"Simulate Purchase" hint calls (once per reviewer label, satisfying the
gate), posts reviews directly via the API, and confirms the Seller modal's
own "Reviews" row panel displays and moderates them correctly. The in-world
Shop-mode "Rate this Product" hint isn't reachable without real camera
movement (same limitation as signs/calendar), so its visibility and the
actual on-screen star-rating sprite rendering were verified manually
instead, using a temporary `window.__debugReviews` hook (removed before
committing, confirmed via `grep`) to reposition the camera and screenshot
the sprite close-up — including confirming a plain, un-flagged placed
instance is reviewable with no builder action needed at all. The purchase
gate's own rejection path (a shopper who hasn't bought the product tapping
"Rate this Product") isn't covered in the e2e suite for the same reason
prohibited-content/no-returns rejections aren't — a real 400 trips the
shared `errors.length === 0` check — and instead relies on the frontend's
existing generic `catch (err) { alert(err.message) }` around every review
submission, which needed no new code to surface this specific rejection.

## Scheduled calendar events + creative-tool trigger

docs/SPEC.md §6's own example of where "Community calendar" could grow —
"creative-tool support like a scheduled confetti-cannon trigger" — explicitly
called out of scope in "Community calendar" above at the time that feature
shipped. `migrations/0046_calendar_scheduled_events.sql` adds it: every
calendar event can now optionally carry a real scheduled instant instead of
just freeform text. `scheduled_at` stays `NULL` for a plain announcement
("Market day Saturday!" typed as text, same as before this migration) and is
only set when the author actually wants a real one-shot visual moment tied to
a specific time. `triggered_at` records that the effect has fired for real,
once, ever.

Posting an event now accepts an optional `scheduledAt` (any string
`Date.parse` can read; validated and normalized to ISO-8601, `400` on an
unparseable value):

```json
POST /api/instances/:instanceId/events
{ "text": "...", "scheduledAt": "2026-08-26T20:00:00.000Z" }
```

The response's `event` object gains `scheduledAt`/`triggeredAt` (both `null`
unless set/fired) alongside the existing `eventId`/`instanceId`/
`authorLabel`/`text`/`createdAt`.

### `POST /api/instances/:instanceId/events/:eventId/trigger`

The lazy-resolution pattern this codebase already uses for auction
resolution (see "Land acquisition auctions" below), applied here too: there
is no Cloudflare Cron Trigger anywhere in this app, so nothing fires a
scheduled event on a schedule. Instead, any Shop-mode session that happens to
have the event loaded polls this endpoint periodically, and whichever caller
happens to hit it first, after `scheduled_at` has passed, is the one that
fires it:

- Not found → `404`.
- Not yet due (`scheduled_at` is `NULL`, in the future, or already
  triggered) → `200` with `{ event, triggered: false }`, a pure no-op.
- Due and not yet triggered → sets `triggered_at` to the current time via a
  `WHERE ... AND triggered_at IS NULL` guard, then returns
  `{ event, triggered: true }`.

That `IS NULL` guard is what makes concurrent calls safe: if two sessions
both notice the same event is due at once, only one `UPDATE` actually lands
first and flips the row, so only one of the two calls ever gets
`triggered: true` back. This is a deliberate, honest simplification, not an
oversight — this app has no live multiplayer presence at all (no
sockets, no shared session state between concurrent shoppers), so there is
no way to synchronize a shared live moment across simultaneous viewers
regardless of how the trigger is implemented. Whoever's client notices it's
due first triggers it for good; every visitor afterward, including the one
who lost the race, just sees an ordinary past event with `triggeredAt` set
and no replay.

### Frontend wiring

The in-world "Add an Event" flow (`#shop-calendar-hint`'s click handler) now
asks a third, optional `prompt()` after the existing author/text ones:
"Schedule a special moment? Enter a date/time ..., or leave blank for just a
note." Left blank, posting behaves exactly as it did before this feature. An
unparseable date/time posts as a plain note instead of failing, with an
`alert()` explaining why — a mistyped schedule shouldn't cost the shopper
their whole post.

Every loaded calendar's already-fetched events are checked once every
`SCHEDULED_EVENT_CHECK_INTERVAL_MS` (10s), inside the same per-frame
`updateShopMovement` loop signs/calendars/alignment already hook into
(`checkScheduledCalendarEvents`). This checks local, already-cached
event data rather than re-fetching the events list — a stale local cache
missing a brand-new event from another session is an acceptable gap for a
purely cosmetic effect, and a network round trip per calendar every 10
seconds regardless of whether anything's due would not be. Any event whose
`scheduledAt` has passed and isn't yet `triggeredAt` calls the trigger
endpoint above; when the response says `triggered: true`, a confetti burst
spawns at that calendar's position.

The confetti itself (`spawnConfettiBurst`/`updateConfettiBursts`/
`disposeConfettiBurst`) is a small, dependency-free particle system: 24
flat `THREE.PlaneGeometry` squares in random bright colors, launched
outward and upward from the calendar with random per-particle velocity and
spin, integrated by hand (gravity, position, rotation, fade-out opacity)
inside the same per-frame loop, and disposed once their ~2.5s lifespan ends
or their landlet unloads. This is not a literal "confetti cannon" — the
spec's own phrase is one illustrative example of "creative-tool support,"
not a specific effect to replicate pixel-for-pixel — just the same idea in
the simplest form this app's existing rendering toolkit (plain
`THREE.Mesh`, no particle-system library) can produce cheaply. Particles are
added as children of the calendar's own Shop-mode group and positioned
using the calendar mesh's local (not world) position, since both are
siblings under that same group.

The Build-mode "Manage Events" panel (`renderCalendarEvents`) shows a
scheduled-but-not-yet-due event as "⏳ Scheduled for <date>", and a fired
one as "🎉 Fired at <date>" once `triggeredAt` is set — giving a builder a
way to see the state of a scheduled event without needing to be present in
Shop mode when it fires.

### Testing note

The due→fires→one-shot lifecycle needs a timestamp forced into the past,
which `worker/land.test.js` can do directly via `env.DB` (D1's own test
binding) but `e2e/community-calendar.test.mjs` cannot — there is no public
API for rewriting an event's `scheduled_at`, by design. The split this
produces mirrors the auction lazy-resolution tests: `worker/land.test.js`'s
"Community calendar" describe block owns the full contract (accepting and
validating `scheduledAt`, a future-scheduled event triggering as a no-op,
forcing `scheduled_at` into the past via direct `env.DB.prepare(...)` and
confirming triggering it then fires it exactly once — a second trigger
attempt returns the same `triggeredAt` unchanged — and a 404 for a
nonexistent event id), while `e2e/community-calendar.test.mjs` covers what's
actually reachable through the real UI/HTTP surface without D1 access:
posting a far-future (`2099`) scheduled event, confirming the Manage Events
panel renders it as "Scheduled for," and confirming the trigger endpoint is
a real no-op before it's due.

The confetti particle system itself and the full scheduled→due→trigger→
spawn pipeline (including the actual on-screen visual result) were verified
manually: a temporary `window.__debugConfetti` hook (removed before
committing, confirmed via `grep`) exposed `spawnConfettiBurst`,
`checkScheduledCalendarEvents`, `shopCalendars`, and `confettiBursts` to a
Playwright script that posted a near-future scheduled event, entered Shop
mode, invoked the check once the schedule had passed, confirmed the server
returned `triggered: true` exactly once, confirmed a burst appeared in
`confettiBursts` and cleared itself after its lifespan, and repositioned the
camera to screenshot the burst mid-flight — visually confirming colored
tumbling squares actually render, rather than just confirming the
data/state changes a DOM-only assertion could see.

## Land acquisition auctions

docs/SPEC.md §5's "simplified auction system" — the mechanism only, not
the full cash economy around it (see "Deliberate scope boundary" below).
`migrations/0045_auctions.sql` adds `auctions` and `auction_bids` tables
plus a `builders.higgles_balance_cents` ledger.

### Deliberate scope boundary

Two things the spec ties to auctions are **not** implemented, because
neither has anywhere to attach to in this dev-mode backend yet:

- **Land cap** (a per-builder max-total-area limit that grows only via
  demonstrated commission earnings) is real and live — see "Land cap"
  below (`migrations/0050_land_cap.sql`, `recomputeLandCap`) — but is
  deliberately tracking-only, never enforced against starting or winning
  an auction. That section covers why: a hard block was implemented,
  tested, and reverted after e2e testing surfaced a bootstrapping trap
  (every builder starts at exactly 100% of their cap, and auction sale
  proceeds are the only higgle-earning path this dev-mode backend actually
  has).
- **Balance-gated bidding.** Every builder starts at `higglesBalanceCents:
  0` with no way to earn any except winning an auction as the *seller* —
  requiring a sufficient balance to *bid* would make the feature
  untestable today (nobody could ever place a first bid). Bids are
  validated only against the minimum-increment rule below, never against
  the bidder's balance. `higglesBalanceCents` is still a real, persisted
  ledger (not a UI-only number) so a winning seller's proceeds land
  somewhere meaningful, ready for balance-gating to be added later without
  a schema change.
- ~~Inactivity-triggered auto-listing~~ — implemented (#325):
  `autoAuctionInactiveLandlets` runs on the same Cloudflare Cron Trigger
  as automatic world growth (see `scheduled()` near the top of
  `worker/index.js`) and auto-starts a `startingBidCents: 0` auction
  (same immediate land-cap release as a voluntary `$0` start, per "Land
  cap" below) on any claimed landlet whose owner's `builders.last_active_at`
  is more than `INACTIVITY_AUCTION_DAYS` (30, the owner's own call) in the
  past — skipping any builder whose `last_active_at` is still `NULL`
  (never tracked, not "long inactive" — see that column's own note
  above). The spec's "default 24-hour duration for inactivity-triggered
  listings" still just applies as the uniform default for every auction,
  voluntary or not — there's no separate duration for this path.
- **No scheduled resolution job.** There's no Cloudflare Cron Trigger
  wired up. Resolution is purely lazy: `GET /api/auctions` sweeps and
  resolves due auctions before returning results (`resolveDueAuctions` in
  `worker/index.js`), capped at `AUCTION_SWEEP_LIMIT` (25) oldest-due-first
  per call so one request can't be forced into unbounded sequential
  resolution work — a backlog larger than that clears over a few calls
  instead of blocking any single one. Any single-auction read or bid
  attempt resolves that one auction first if it's due
  (`resolveAuctionIfDue`). An explicit `POST .../resolve` exists for a
  frontend "time's up, finalize it" action without waiting for a future
  read to trigger it as a side effect.

### Auction object

```json
{
  "auctionId": "auction-7f3a1c20-...",
  "landletId": "starter-landlet",
  "sellerBuilderId": "builder-3c2b1a90-...",
  "startingBidCents": 0,
  "status": "active",
  "endsAt": "2026-08-26T00:00:00.000Z",
  "winningBidId": null,
  "highestBidCents": null,
  "bidCount": 0,
  "createdAt": "2026-08-25T00:00:00.000Z",
  "updatedAt": "2026-08-25T00:00:00.000Z"
}
```

`highestBidCents`/`bidCount` are computed on every read from
`auction_bids`, not stored columns — cheap at dev scale, and guarantees
they can never drift out of sync with the actual bid rows the way a
denormalized counter could. `status` is `active` or `ended`; there's no
`cancelled` state — a voluntary auction, once started, always runs its
full course. The one exception isn't a status at all: if the seller
deletes their account mid-auction, the auction row (and its bids) are
removed outright by a DB-level cascade, not transitioned to `ended` — see
`DELETE /api/builders/:builderId` above.

### `POST /api/landlets/:landletId/auction`

Requires a session (`401` without one). Starts a voluntary auction as the
calling account's own builder — `builderId` is derived from the session,
never a client-supplied field. Body: `{ "startingBidCents"?,
"durationHours"? }`. `startingBidCents` defaults to `0`, capped at
100,000,000 (the same money-field sanity bound as `priceCents` above);
`durationHours` defaults to `24` (docs/SPEC.md §5's own default), capped
at `8760` (one year) as a sanity bound against a malformed request, not a
spec requirement. `400` unless the calling builder is the landlet's
current owner and the landlet is `claimed`. `409` if that landlet already
has an active auction — one at a time per landlet.

Per docs/SPEC.md §5, what `startingBidCents` is decides the unsold
outcome, read directly off the stored value at resolution time rather
than a separate flag: **"$0 = explicit willingness to relinquish for free
if no bids arrive. ≥$0.01 = wants to retain if unsold."**

Starting a `$0` auction also frees the seller's own "one claimed landlet"
claim-eligibility lock immediately, rather than waiting for resolution —
see `POST /api/landlets/:landletId/claim` above and "Claim-lock release
timing" below (#199).

### `GET /api/auctions`

Lists auctions, cursor-paginated like every other list endpoint in this
API. Optional `status` (`active`/`ended`) and `landletId` filters. Sweeps
and resolves every due auction first (see "Deliberate scope boundary"
above), so an expired-but-not-yet-resolved auction never appears in an
`active` listing.

### `GET /api/auctions/:auctionId`

A single auction, resolving it first if it's due. `404` if it doesn't
exist.

### `GET /api/auctions/:auctionId/bids`

Every bid on this auction, highest first (ties broken by earliest),
capped at 200. `404` if the auction doesn't exist.

### `POST /api/auctions/:auctionId/bids`

Requires a session (`401` without one). Places a bid as the calling
account's own builder — `builderId` is derived from the session, never a
client-supplied field. Body: `{ "amountCents" }`, capped at 100,000,000
(the same money-field sanity bound as `priceCents` above). Resolves the
auction first if it's due, then `409` if it's not (or is no longer)
`active`. `400` if the bidder is the seller, or if `amountCents` is below
the minimum acceptable amount:

- No bids yet: must be `>= startingBidCents` (so a `$0`-starting auction
  accepts a `$0` first bid — a real bid, not "no bid," and per the spec's
  own "any bid guarantees eventual transfer," it wins the land for free
  rather than releasing it to greenbelt).
- At least one bid already: must be strictly greater than the current
  highest.

**#629 (owner-confirmed, 2026-09-10): a bid must be affordable, and holds
what it needs until outbid or the auction closes.** A winning bid used to
credit the seller's `higglesBalanceCents` with the full amount regardless
of whether the bidder ever held it — harmless before #625 gave a higgles
balance a real Stripe cash-out, a real unbacked-money exploit after.
Placing a bid now checks the bidder's `higglesBalanceCents` and land cap
**net of what their own currently-highest bid on every other active
auction is already holding** (computed live from `auction_bids` — nothing
is stored as a separate escrow/hold column, so a hold releases itself the
instant a higher bid supersedes it):

- `400` if `heldElsewhere + amountCents` exceeds the bidder's
  `higglesBalanceCents`.
- `409` if the bidder's owned area + `heldElsewhere` area + this
  landlet's area would exceed their land cap (the existing land-cap gate,
  extended the same way).

This is a best-effort, non-atomic-across-different-auctions check (unlike
the same-auction "must beat the current highest" guard, which stays fully
atomic) — see "Resolution" below for the real, atomic enforcement.

A fresh builder starts at `0` `higglesBalanceCents`, so any test placing a
real bid needs to fund one first — `POST /api/builders/:builderId/higgles-
grants` (admin-gated, `{ "amountCents" }`, additive) is the balance-side
counterpart to the existing land-cap-grants fixture above: it never
touches the earnings ledger (it's not standing in for real income, just a
balance top-up), the same deliberate independence `annualGrossIncome`'s
own gross-vs-net split holds elsewhere in this doc.

A reserved (`> $0` starting bid) auction's first accepted bid also frees
the seller's claim-eligibility lock immediately — see "Claim-lock release
timing" below (#199).

### `POST /api/auctions/:auctionId/resolve`

Resolves this auction if it's currently due (`ends_at` has passed);
otherwise `409`. Calling it again on an already-ended auction is a
harmless no-op — `200` with the same (unchanged) already-ended state, not
an error, matching ordinary idempotent-action expectations rather than
penalizing a redundant call.

### Resolution

`resolveAuction` in `worker/index.js` — the same logic whether triggered
lazily or via the explicit endpoint:

**#629: the highest bid isn't automatically the winner anymore.** Bids are
walked highest-first; each candidate's `higglesBalanceCents` is atomically
debited (`UPDATE ... WHERE higgles_balance_cents >= amount`, guarded on
`meta.changes`) and their land cap re-checked before they're accepted as
the winner — the first candidate who actually clears both is the winner.
This is the real, atomic enforcement behind bid-time's own best-effort
check above: a candidate whose balance or land cap no longer covers their
bid by resolution time (e.g. another of their own auctions resolved first
in the same sweep) is skipped with zero side effects — the debit attempt
itself is a no-op if it fails, and a land-cap failure explicitly refunds
the just-taken debit — never crediting a seller with money nobody actually
had. If no candidate can cover their bid, the outcome is the same as no
bids at all.

- **A winning bid clears both checks:** ownership transfers to that
  bidder (`landlets.owner_builder_id`), the landlet's build is cleared
  (placed instances, versions, `active_version_id`) exactly like `DELETE
  /api/builders/:id` already clears a reclaimed landlet's build — a new
  owner gets the land, not the previous owner's stuff on it — and the
  seller's `higglesBalanceCents` is credited the winning bid amount
  (docs/SPEC.md §5: "Higgles raised in a successful auction go to the
  previously-inactive builder's account"). `auctions.status` becomes
  `ended`, `winningBidId` records which bid won.
- **No bids, or no bidder could actually cover their bid, and
  `startingBidCents` was `0`:** the landlet releases to `greenbelt` (owner
  cleared, build cleared, `claimable_at` refreshed) — the seller's own
  explicit "relinquish for free" choice. (A non-empty bid list where every
  bidder failed the resolution-time check is treated the same as the
  seller keeping the land below, not greenbelt — see the next bullet.)
- **No bids, `startingBidCents` was `> 0`, or bids existed but none could
  be covered:** the landlet stays exactly as it was — the seller wanted to
  retain it if unsold (or nobody could actually pay), so nothing about
  ownership or the build changes, only `auctions.status` becomes `ended`.

### Claim-lock release timing

Project-owner design decision (#199), replacing an earlier idea of a
separate "relinquish land" action: starting a voluntary auction is itself
that relinquish action, so the seller's "one claimed landlet" claim-
eligibility lock (`POST /api/landlets/:landletId/claim`'s `NOT EXISTS`
check) frees up the moment they've genuinely committed to giving the land
up, not only once the auction actually resolves:

- **`startingBidCents: 0`** — freed the instant the auction starts. A `$0`
  starting bid is itself "willing to give this up for nothing," so there's
  nothing left to wait for.
- **Any other starting bid** — freed the instant the first bid lands
  (`POST /api/auctions/:auctionId/bids`). A bid guarantees the land
  eventually transfers to *someone* either way (a higher bid, or this one
  if it stands), so the same commitment exists from that point on.

The landlet itself doesn't change at all — it keeps `status: "claimed"`
and its current `ownerBuilderId` for build/display purposes exactly as
before, right up until `resolveAuction` actually runs. Only claim
*eligibility* changes, computed live rather than stored: the claim
endpoint's lock query excludes any of the builder's claimed landlets that
have an active auction meeting either condition above
(`LANDLET_RELEASED_VIA_AUCTION_SQL` in `worker/index.js`, shared with
`explainClaimConflict`'s error-message check so the two stay in sync). No
new landlet status or column — deliberately, since both conditions are
fully derivable from `auctions`/`auction_bids` rows that already exist,
and the landlet's real state genuinely doesn't change yet.

One consequence: a builder can end up owning several claimed landlets at
once this way (their original one, mid-auction-and-released, plus a newly
claimed one) — already possible via winning an auction (`migrations/
0058`), just reachable now from the seller side too. Land cap (see "Land
cap" below) is the intended long-run check on this kind of accumulation,
but per its own "Deliberate scope boundary" note it's deliberately
tracking-only and not enforced yet — not something this issue's scope
extended to changing.

### Notifications

Bidding and resolution both feed the existing builder-facing notifications
system (see "Notifications" above) wholesale — a plain message, no new
type or schema, since it was already built generic for exactly this
("future notification kinds don't need their own table," per that
table's own migration comment). No frontend changes were needed either:
`renderNotifications` only ever reads `notification.message`, so these
just show up.

- **`notifyOfNewBid`** (called right after a bid is recorded, not batched
  atomically with it — best-effort, the same convention
  `notifyBuildersOfDimensionChange` already follows): notifies the
  seller of every new bid, and separately notifies the *previous* highest
  bidder that they've been outbid — skipped if the same builder just
  raised their own bid, since there's no one to notify in that case.
- **`resolveAuction`** notifies, batched atomically with the rest of
  resolution: on a win, the seller ("sold for $X") and the winner
  ("you won"); on an unsold `$0` auction, the seller that it released to
  greenbelt; on an unsold reserved auction, the seller that they keep the
  land.

Covered by `worker/commerce.test.js` (a notification-content assertion added
to each existing resolution-outcome test, plus a dedicated case for the
new-bid/outbid pair) and `e2e/land-auctions.test.mjs` (the seller's real
notification, read through the actual Notifications modal after the
bidder's bid — confirms the whole path works end to end, not just that
a row landed in the table).

### Frontend wiring

Settings' Build tab, alongside Land Cap (`renderAuctionSection` in
`src/main.js`, called from `renderBuildSettingsSection` — #197: auctioning
a landlet is a Build-mode concern, not a Sell one, per the project owner
directly, so it moved out of a standalone "Auctions" tab rather than
staying separate on the theory that bidding on someone *else's* landlet
isn't a "your own Build session" action the way publishing is). Neither
section is gated on `currentLandletId`, so both still render even outside
an active Build session — same as Land Cap above them. Two independent
sections:

- **Sell Your Land** — a landlet picker (#249) when the active identity
  currently owns more than one claimed landlet at once (a normal state
  since #199 lets a seller claim a second landlet the moment they start
  a $0 auction, or get a first bid on any starting amount, on their
  current one — before that auction even resolves), defaulting to
  whichever landlet the builder is currently in Build mode on. Below the
  picker (or standing alone, with no picker, for the common one-landlet
  case): if the selected landlet has no active auction on it, a small
  form (starting bid in dollars, duration in hours) and a Start Auction
  button; once it has an active auction, this collapses to a one-line
  summary instead of offering a second start form. Switching the picker
  re-renders this status/form for whichever landlet is newly selected.
- **Active Auctions** — every currently-active auction world-wide, each
  row showing the landlet, current high bid (or the starting bid if none
  yet), time remaining, and the unsold outcome in plain language. A
  bid input + Place Bid button appears on every row except the viewer's
  own listing (nothing useful to bid on your own auction). A "Resolve
  Now" button appears instead, on any row already past its end time but
  not yet resolved — a narrow gap that can only happen between one
  client's fetch and another's, since `GET /api/auctions` itself already
  resolves anything due before this list is ever built.

### Testing note

`worker/commerce.test.js`'s own `Auctions` describe block covers the full
mechanism, including resolution in all three outcomes (win transfers
land + build clears + seller paid; `$0` unsold releases to greenbelt;
reserved unsold stays with the seller) and the lazy-resolution paths —
each forces an auction into the past by setting `ends_at` directly via
the D1 test binding, the same test-only escape hatch used elsewhere in
that file, rather than waiting a real hour or mocking `Date` globally.
`e2e/land-auctions.test.mjs` covers starting an auction and placing a bid
through the real two-party UI (two independent browser pages, the same
pattern `e2e/bundle-sharing.test.mjs` already uses) — but deliberately
**not** resolution itself: every resolution path requires the auction to
actually be past its end time, and the shortest duration the API accepts
is 1 hour, so waiting for a real one isn't practical in an e2e run.

## Land cap

docs/SPEC.md §3: "Land cap — the growth-gating mechanic (distinct from
land acquisition, §5): Per-builder max total m², gating hosting burden.
Grows via a formula converting trailing-30-day higgle earnings per
1,000 m² owned into cap increases. Ratcheting: once increased, never
decreases." Also: "Two independent constraints (do not conflate): 1. Land
cap — how much total area, grows only via earnings formula. 2. Higgle
balance — which specific already-claimed lands can be acquired via auction
(§5)." This section (`migrations/0050_land_cap.sql`) had no implementation
at all before it — `builders.land_cap_m2` (defaults to `1000`, matching the
free starter lándlet exactly) and a per-event `higgles_earnings_events`
ledger (needed for a genuine trailing-30-day *window*, which the existing
lifetime `higgles_balance_cents` total, migrations/0045, can't answer on
its own).

**This is deliberately tracking-only, not enforced against auction bids —
an explicit, tested, and reverted design decision, not an oversight.** A
hard block ("reject a bid that would push the bidder over their cap") was
implemented and then removed after real e2e testing (not speculation)
surfaced a genuine bootstrapping trap:

- Claiming a lándlet is mandatory to use Build mode at all —
  `resolveLandletId` in `src/main.js` forces the claim flow for any
  builder who doesn't already own one. There is no "skip claiming" path.
- The default cap (`1000`) exactly equals the mandatory starter lándlet's
  own size. So every builder, the moment they exist, is already at 100% of
  their cap.
- docs/SPEC.md §5 makes clear the *intended primary* higgle-earning path is
  commerce commissions — "Higgles credit instantly to builders on sale
  completion" (of a *product*, not of land). But this dev-mode backend has
  no real checkout/commerce system at all (out of scope, same as real
  payments generally elsewhere in this project). Auction sale proceeds are
  the *only* higgle source actually implemented.
- Hard-enforcing the cap against that one lone source would make growing
  past your starter lándlet structurally impossible for *every* builder:
  nobody can ever earn without first having cap headroom to acquire
  something to resell, and nobody has headroom without having already
  earned. That's not a faithful implementation of "growth is earned
  through demonstrated performance" (docs/SPEC.md §0) — it's a dead end
  that would make the auction system (shipped and working) self-defeating.

The formula, the ratchet, and the per-event ledger are all real and
correctly implemented regardless — `recomputeLandCap` in `worker/index.js`
runs lazily (the same "no Cloudflare Cron Trigger anywhere in this app"
pattern auction resolution and scheduled calendar events already use) on
every `GET /api/builders`, so `landCapM2` on the builder object (see
"Builders" above) is always current. This is real, visible infrastructure
ready to gate actual land acquisition the moment a real commerce/commission
loop exists to make that gate navigable — not a stub.

### The formula (placeholder pending real validation)

```
normalizedThousands = max(ownedAreaM2, 1000) / 1000
trailingEarningsDollars = SUM(higgles_earnings_events.amount_cents WHERE created_at >= now - 30 days) / 100
earningsPerThousandM2Owned = trailingEarningsDollars / normalizedThousands
increaseM2 = floor(earningsPerThousandM2Owned * 100)
candidateCap = 1000 + increaseM2
landCapM2 = max(landCapM2, candidateCap)  // ratchet — never decreases
```

The `100` (m² of cap per dollar of trailing earnings per 1,000 m² owned)
is exactly the kind of number docs/SPEC.md §10's own open item —
"Lándlet hosting cost validation ... needs validation against real
measured costs once live" — flags as not yet settled. This is a
placeholder pending that, not a claimed-final ratio. Spec's own "adjusts
at most once/month, small increments" describes an *operator* tuning this
constant over time; there is no mechanism here (or need for one) for the
backend to change it on its own.

`higgles_earnings_events` gains one row whenever `resolveAuction` credits a
seller's `higgles_balance_cents` on a successful sale — same event, same
amount, recorded twice for two different purposes (a lifetime running
total vs. a queryable time-windowed ledger).

### Frontend wiring

Settings' Build tab shows a "Land Cap" field (`renderLandCapField` in
`src/main.js`) above Publish/Version History — a builder-account fact, not
tied to the currently-active landlet, so it renders whenever a builder
identity is active regardless of `currentMode`/`currentLandletId` (unlike
Publish, which needs an active Build-mode landlet). It shows `ownedAreaM2`
against `landCapM2`, both read straight off the builder object from
`GET /api/builders` — not, as an earlier version of this panel did, a
frontend-side sum over `GET /api/landlets?status=claimed&...` alone, which
silently missed every level's own `cap_consumed_m2` once vertical
construction shipped (#312). `ownedAreaM2` is the exact same
ground-plus-levels total `recomputeLandCapsBatch` already computes
server-side to grow `landCapM2` itself (see "The formula" above) — read
back here rather than re-derived, so the two numbers can never drift out
of sync with each other.

### Testing note

`worker/land.test.js`'s "Land cap" describe block covers the default,
the formula's own math, the ratchet surviving earnings aging out of the
trailing window, the per-event ledger actually being credited on a real
auction sale, the starter claim being unaffected, and — explicitly — that
a bid exceeding cap is **not** rejected, confirming the tracking-only
decision is what's actually shipped rather than a leftover TODO.
`e2e/land-cap.test.mjs` covers the Settings display through the real UI.

## Vertical construction — levels

docs/SPEC.md §1: vertical construction is "tied to land cap, not a
separate resource," with asymmetric per-level cost — "a fixed-angular-
footprint lándlet extended radially through the Earth is a cone
converging on Earth's center, not a cylinder... each level above ground
consumes increasingly more land cap per level (cross-sectional area grows
moving away from Earth's center); each level below ground consumes
increasingly less (area shrinks toward the center)." This is the data
model + API for that, plus the two hard limits on digging down §3 also
specifies (issues #168/#164, sub-issues of #167's tracking issue) — the
Build-mode UI and cross-lándlet cone boundary continuity are deliberately
separate, still-open sub-issues.

`migrations/0063_landlet_levels.sql` adds a `landlet_levels` table.
Level `0` (the ground level every lándlet already has, accounted for by
its own `areaM2`) never gets a row — this table only tracks *additional*
levels beyond that baseline. Positive `levelIndex` is above ground,
negative is below. Levels stack with no gaps: level 2 can't exist without
level 1 already existing in the same direction, so `POST` always extends
the current range by exactly one and `DELETE` always removes the
outermost level still standing (`409` otherwise) — a builder can't leave
a floating, disconnected level partway up or down.

Each level's `capConsumedM2` is computed once at creation (not
recomputed live) via `worker/earthCurvature.js`'s `footprintScaleAtHeight`,
sampled at the level's own outer boundary from ground (`levelIndex *
LEVEL_HEIGHT_M`, matching `LANDLET_HEIGHT_M` in `src/main.js` — the
height of the one buildable level that exists today) — the strictest
point within that level, since the cone's cross-section only shrinks or
grows monotonically across one level's height. `recomputeLandCap`/
`recomputeLandCapsBatch` now fold every owned lándlet's levels into the
same "owned area" figure the land-cap growth formula already normalizes
against, so building up or down genuinely counts as more area owned, the
same as claiming more lándlets horizontally does.

### `GET /api/landlets/:landletId/levels`

Public, no session required (matches `GET /api/landlets/:landletId`'s own
unauthenticated read access). Returns every level on the lándlet, ordered
ground-outward in both directions.

### `POST /api/landlets/:landletId/levels`

Requires the session-authenticated owner of the lándlet. Body:
`{ "direction": "up" | "down" }` — adds exactly one new level extending
the current range in that direction (from `0` if none exist yet) and
recomputes the owning builder's land cap. Errors: `401` no session, `403`
not the owner, `400` invalid/missing `direction`, `404` lándlet not found.

Digging down (never up — the cone only narrows in that direction) is
capped by docs/SPEC.md §3's two hard limits, both `409`: the new level's
own cross-sectional area (the same `capConsumedM2` calculation above)
falling below a 10 m² minimum footprint, and reaching Earth's center
(`levelIndex * LEVEL_HEIGHT_M <= -earthRadiusM`) — in practice the 10 m²
floor always binds first for any lándlet with a positive area, so the
center-of-Earth check exists mainly to satisfy the spec's literal "hard
depth limit: Earth's radius" requirement as its own explicit guard.

Found via backlog audit (#395): the `INSERT` is guarded atomically against
the lándlet's *current* extent in this direction (not just a plain insert
off the request-time read) — a second, genuinely concurrent add in the
same direction gets a clean `409` ("This lándlet's levels changed —
please retry") instead of a raw D1 constraint-violation `500`.

### `DELETE /api/landlets/:landletId/levels/:levelIndex`

Requires the session-authenticated owner. Only the outermost existing
level (in whichever direction `levelIndex` is on) can be removed —
`409` otherwise, or if `levelIndex` is `0` (never a real row) or the
lándlet has no levels at all. Frees the level's `capConsumedM2`
immediately by recomputing the owning builder's land cap afterward.
Found via backlog audit (#395): "still the outermost" is re-checked as
part of the `DELETE`'s own atomic guard, not just the initial read, so a
concurrent add extending past this level between the read and the delete
can't leave a gap in the level sequence.

#522 (owner-confirmed, 2026-09-09): any `placed_instances` row left
sitting in the z-range this level was providing is removed from active
shoppable space along with it — nothing else ever re-checks an
already-placed instance's z once a level it depended on is removed
(`assertInstanceZWithinLevels` only runs on that instance's own
create/move). Uses the same allowed-range formula (and half-level-height
slack) as that function, computed against the levels that remain after
the delete, so an instance already within tolerance of the new boundary
isn't swept up unnecessarily.

#633 (sub-issue of #631, owner-confirmed): this isn't a bare delete —
every instance swept out this way is snapshotted first into a new
`saved_level_layouts` row (one per removal that actually sweeps at least
one instance; nothing is created if there's nothing to sweep) plus a
`saved_layout_instances` row per instance, mirroring `version_instances`'
own snapshot column shape (`template_id`, `x_m`/`y_m`/`z_m`, rotation,
`label`, `crop_json`, `scale`, community-sign/calendar flags). Unlike
`landlet_versions`/`version_instances` (parented to a landlet),
`saved_level_layouts` is parented to the **builder** — a saved layout is
meant to outlive its source landlet, since the whole point (per the
owner's own framing) is later reusing it on a *different* landlet.

### `GET /api/builders/me/saved-layouts`

#634 (sub-issue of #631): lists the session-authenticated builder's own
`saved_level_layouts` rows, newest first, each with an `instanceCount`
(a `LEFT JOIN`/`COUNT` against `saved_layout_instances`, the same shape
`GET /api/landlets/:landletId/versions` already uses for its own
per-version instance counts). Cursor-paginated the same way
`GET /api/notifications` is — `?limit=` (1-100, default 100) and an
opaque `?cursor=` from a previous page's `nextCursor`, descending on
`(createdAt, savedLayoutId)` so "older than the last row already seen"
is a strict less-than on both. Never returns another builder's saved
layouts — always scoped to the caller's own `builder_id`.

```json
{
  "savedLayouts": [
    {
      "savedLayoutId": "saved-layout-...",
      "sourceLandletId": "landlet-...",
      "sourceLevelIndex": 1,
      "name": "Level 1 from My Landlet, removed 2026-09-10",
      "createdAt": "2026-09-10T00:00:00.000Z",
      "instanceCount": 3
    }
  ],
  "nextCursor": null
}
```

### `GET /api/saved-layouts/:savedLayoutId`

#635 (sub-issue of #631): fetches one saved layout's full detail —
the same summary fields `GET /api/builders/me/saved-layouts` already
returns, plus every one of its `saved_layout_instances` rows in full
(the shape the faux-layout preview needs to actually render them: each
instance's `templateId`, `x`/`y`/`z`, rotation, `label`, `crop`, `scale`,
and community-sign/calendar flags — mirroring `GET
/api/landlets/:landletId/versions/:versionId`'s own per-instance shape).
`404` if it doesn't exist, `403` if the caller isn't the builder it's
parented to (`401` with no session) — same ownership check as the
`DELETE` below.

```json
{
  "savedLayout": {
    "savedLayoutId": "saved-layout-...",
    "sourceLandletId": "landlet-...",
    "sourceLevelIndex": 1,
    "name": "Level 1 from My Landlet, removed 2026-09-10",
    "createdAt": "2026-09-10T00:00:00.000Z",
    "instanceCount": 1,
    "instances": [
      {
        "instanceId": "instance-...",
        "templateId": "placeholder-tree",
        "x": 1, "y": 1, "z": 15,
        "rotationX": 0, "rotationY": 0, "rotationZ": 0,
        "label": null,
        "crop": {},
        "scale": 1,
        "isCommunitySign": false,
        "isCommunityCalendar": false
      }
    ]
  }
}
```

### `DELETE /api/saved-layouts/:savedLayoutId`

#634: permanently deletes one saved layout. `404` if it doesn't exist,
`403` if the caller isn't the builder it's parented to (`401` with no
session). `saved_layout_instances` rows cascade via their own
`FOREIGN KEY ... ON DELETE CASCADE` (migration 0080) — nothing else to
clean up.

Listing/managing above, single-layout detail, and deletion together
cover everything up through the faux-lándlet preview + rectangle-select
UI (#635, built on top of the detail endpoint above — see
`src/savedLayoutPreview.js` for its ground-sizing/selection math).

### `POST /api/saved-layouts/:savedLayoutId/paste`

#636 (last sub-issue of #631): applies a builder-chosen subset of a saved
layout's instances onto a landlet the builder owns, as brand-new
`placed_instances` rows. The saved layout itself is left completely
intact by this — nothing here deletes from `saved_layout_instances`, so
the same selection (or a different one) can be pasted again later, any
number of times.

```json
{ "instanceIds": ["instance-...", "instance-..."], "landletId": "landlet-..." }
```

`instanceIds` (1-100, unique) must each be a `source_instance_id` already
present on this saved layout — `400` otherwise. `landletId` must be a
landlet the caller owns (`404`/`403`/`401` follow the same
`requireOwnedLandlet` shape every other instance-touching endpoint in
this file uses).

A pasted instance is validated exactly like a normal instance create —
`assertCropWithinTemplateBounds` and `assertInstanceZWithinLevels` both
run against the *target* landlet's current state, not the source
landlet's state at save time. Per #631's own scoping ("not treated as
already paid for" just because an equivalent instance existed once
elsewhere), this means a target whose current levels don't reach the
saved `z` (`400`, same message `POST /api/instances` would give), or
whose template has since shrunk below the saved crop, correctly rejects
the paste rather than silently bypassing either check. Every instance
gets a fresh `instanceId` (never the original `source_instance_id`,
which the source landlet's own `placed_instances` row for it no longer
even exists to collide with) via the same ownership-reraced batch insert
`POST/PUT /api/instances/batch` already uses (`409` if the target
landlet changed hands in the interim).

```json
{ "instances": [ { "instanceId": "instance-...", "landletId": "landlet-...", "templateId": "placeholder-tree", "x": 2, "y": 3, "z": 15, "rotationX": 0, "rotationY": 0, "rotationZ": 1.25, "label": null, "crop": {}, "scale": 1, "isCommunitySign": false, "isCommunityCalendar": false } ] }
```

### Ownership-change cleanup

A lándlet's levels are reset (`DELETE FROM landlet_levels`) everywhere
its build already gets cleared on an ownership change — the builder-
deletion release-to-greenbelt path and both `resolveAuction` branches
(transfer to a winning bidder, release to greenbelt on an unsold `$0`
auction) — matching the existing "a new owner gets the land, not the
previous owner's stuff on it" reasoning already applied to
`placed_instances`/`landlet_versions` there.

### Instance placement is bounded by purchased levels (#394)

Every instance create/update path (`POST/PUT/PATCH /api/instances*`,
including the batch and draft-save endpoints) rejects a `z` outside the
lándlet's currently *purchased* vertical extent — `400` if `z` falls
outside `[min(0, ...levelIndices) * LEVEL_HEIGHT_M - LEVEL_HEIGHT_M / 2,
max(0, ...levelIndices) * LEVEL_HEIGHT_M + LEVEL_HEIGHT_M / 2]` (the half-
level slack accounts for an instance's own thickness carrying it slightly
past a level's exact boundary). A lándlet with no `landlet_levels` rows
still has the implicit ground level at index `0`, so its instances must
sit within one level's height of the ground. This closes a gap where
placing an instance directly could build arbitrarily high or deep without
ever calling `POST /api/landlets/:landletId/levels` — the only place land
cap is actually charged for going vertical.

## Purchases

Land cap's own commentary above flags the actual gap directly: this
backend originally had no real commerce/checkout system at all, only
auction sale proceeds as a higgle source, even though docs/SPEC.md §5's
*intended primary* earning path is "Higgles credit instantly to builders
on sale completion" of a *product*. `POST
/api/instances/:instanceId/purchase` (`migrations/0051_purchases.sql`)
lets a shopper "buy" a priced, placed product.

**Two paths, chosen automatically per product, per the owner's #331
answer:**

- **Dev-mode simulation** (the original, and still the default for the
  vast majority of products): no real payment is ever processed and a
  shopper is charged nothing. What *is* real is the commission math: a
  successful purchase credits an actual builder's `higgles_balance_cents`
  and `higgles_earnings_events` ledger (migrations/0050), so it feeds land
  cap's own formula for real.
- **Real-money checkout** (#453, sub-issue of #347/#324): once a
  product's seller has *fully completed* Stripe Connect Custom onboarding
  (`stripe_onboarding_status = 'complete'`, see "Stripe Connect" above)
  and this server has `STRIPE_SECRET_KEY` configured, this same endpoint
  instead creates a real Stripe PaymentIntent — see "Real-money checkout"
  below.

Which path a given call takes is entirely server-side, based on the
product's own seller — nothing in the request body selects one or the
other, and a seller who hasn't connected (or hasn't finished onboarding)
keeps the exact simulated behavior this endpoint always had.

### Request/response

```
POST /api/instances/:instanceId/purchase
{ "quantity": 2, "buyerLabel": "A Shopper" }   // both optional
```

Both fields are genuinely optional (unlike every other POST body in this
API) — a missing or empty body just means "buy one, anonymously," not a
400, since a purchase has no other required input beyond which instance is
being bought. When present, `buyerLabel` is capped at 100 characters, same
as sign-post/review `authorLabel`. On the simulated path, returns `201`
with the created `purchase`; on the real-money path, returns `200` with
`requiresPayment: true` instead — see "Real-money checkout" below.

```json
{
  "purchase": {
    "purchaseId": "purchase-...",
    "instanceId": "...",
    "templateId": "...",
    "builderId": "...",
    "sellerId": "...",
    "buyerLabel": "A Shopper",
    "unitPriceCents": 2500,
    "quantity": 2,
    "totalCents": 5000,
    "commissionCents": 100,
    "builderShareCents": 50,
    "platformShareCents": 50,
    "createdAt": "...",
    "refundedAt": null,
    "paymentIntentId": null
  }
}
```

`paymentIntentId` is only ever non-null for a purchase that went through
the real-money path below.

`404` if the instance or its underlying catalog template doesn't exist,
`400` if the template has no price set (`priceCents == null` — nothing to
buy), the instance sits on an unclaimed lándlet (no builder to credit), or
`quantity` exceeds `1000` — a sanity bound (not a spec requirement, same
reasoning as auctions' `durationHours` cap above) against this deliberately
unauthenticated endpoint turning one request into an unbounded
`higgles_balance_cents`/land-cap credit. `429` past 30 calls per 15 minutes
from one client IP (see "Rate limiting" above) closes the other half of
that gap — repeated smaller requests instead of one large one.

`GET /api/purchases?builderId=...` requires a session logged in as that
builder (`403` otherwise); lists everything hosted on that builder's own
land, most recent first — their "did I earn commission" view.
`GET /api/purchases?templateId=...` lists every sale of one product
instead, across every builder who happens to host an instance of it — a
seller's own "did my product sell" view, used by the Seller modal's "Sales"
panel (see "Refunds" below). If the template has a `sellerId`, this
requires a session logged in as that seller (`403` otherwise) — a
seller-less template stays open to unauthenticated reads. Exactly one of
the two query params is required (`400` without either).

`instance_id`/`template_id`/`seller_id` are deliberately NOT foreign keys —
a purchase is a permanent historical receipt, not cascade-deleted if the
instance, template, or seller it references is later removed, the same
"keep the record, drop the live reference" reasoning `notifications.template_id`
already uses.

### Commission math

docs/SPEC.md §5's "Universal commission formula": "2% standard for
seller-listed products," "Universal 50/50 split ... 50% higglehaven, 50%
Builder," "0.5% floor protecting builders on low-commission affiliate
products."

```
commissionCents = round(totalCents * 0.02)
builderShareCents = max(round(commissionCents * 0.5), round(totalCents * 0.005))
platformShareCents = max(commissionCents - builderShareCents, 0)
```

The floor exists to protect the *builder*, not to guarantee higglehaven's
own take — if it pushes the builder's share above the commission itself
(only possible at an unusually low commission rate; not reachable at this
formula's fixed 2%/50%, but the code doesn't assume that won't change),
the platform's own share is `0`, never negative. This math is identical on
both the simulated and real-money paths (`computePurchaseAmounts` in
`worker/index.js`) — what differs between them is only *where the money
actually goes*, covered next.

### Real-money checkout (#453)

When `POST /api/instances/:instanceId/purchase` picks the real-money path
(the product's seller has `stripe_onboarding_status: 'complete'` and this
server has `STRIPE_SECRET_KEY` configured — see "Stripe Connect" above),
it does not write a `purchases` row at all yet. Instead it creates a
Stripe PaymentIntent and returns `200`:

```json
{
  "requiresPayment": true,
  "clientSecret": "pi_..._secret_...",
  "paymentIntentId": "pi_...",
  "publishableKey": "pk_..."
}
```

`publishableKey` (this server's `STRIPE_PUBLISHABLE_KEY`) is safe to hand
to the browser by design — it's how Stripe.js identifies which Stripe
account to talk to, and can't authorize a charge on its own. The
PaymentIntent's `amount` is `totalCents`; its `application_fee_amount` is
the *entire* `commissionCents` (not just `platformShareCents`) with
`transfer_data.destination` set to the seller's own connected account, so
Stripe transfers the remaining ~98% (`totalCents - commissionCents`)
straight to the seller. The Builder's own `builderShareCents` is
unaffected by any of this — it's still credited as higgles, never real
money, exactly as the simulated path always did (per the owner's own #331
answer: "They never receive higgles for the sale of the product... paid to
the builder in higgles"). Every amount this PaymentIntent needs later is
stored in its own Stripe-side `metadata` at creation time (`instanceId`,
`templateId`, `builderId`, `quantity`, `buyerLabel`, and all five cent
amounts) — locked in against the price *right now*, so a later price
change on the template can't create a mismatch between what Stripe
actually charged and what gets credited once the purchase is finalized.

The frontend then collects payment with Stripe Elements/`clientSecret`
(`stripe.confirmCardPayment`) and, once that succeeds client-side, calls:

```
POST /api/purchases/finalize
{ "paymentIntentId": "pi_..." }
```

This never trusts that client-side success signal on its own. It
re-fetches the PaymentIntent from Stripe directly (server-side, using this
server's own secret key, which the client never has) and only writes the
`purchases` row — crediting the builder's higgles exactly as the simulated
path does — once Stripe itself reports `status: 'succeeded'`, using the
amounts from that PaymentIntent's own metadata rather than any fresh
client input. Validation (`paymentIntentId` must be a non-empty string)
runs first, so a malformed call gets a real `400` rather than a `503`
masking it — same ordering "Stripe Connect" above already established.
Idempotent: calling this again for a `paymentIntentId` that already backs
a `purchases` row (a retry after a network blip, or a double-tap) just
returns that same purchase rather than crediting the builder twice; the
`payment_intent_id` column's own `UNIQUE` index (`migrations/0069`) is the
last line of defense if two such calls ever raced each other. Returns
`503` if Stripe isn't configured, `400` if the PaymentIntent hasn't
actually succeeded yet.

#### Orphaned real-money purchases (#472)

By the time this endpoint runs, Stripe has already moved real money — the
buyer was charged and the seller's connected account already received its
transfer via `transfer_data`, independent of anything in this app's DB.
If the purchased instance, its template, or the landlet's claim has since
vanished (a concurrent delete, or an auction resolving mid-payment), this
no longer 409s with the `purchases` row left unwritten — that would mean
real money moved with zero record of it, and no way to even find it again
(the idempotency check above has nothing to match against). Instead it
always writes a `purchases` row, using only what's locked into the
PaymentIntent's own metadata at checkout time (no live lookups needed for
what's already meant to be a permanent historical receipt). `builderId` is
only used if it still resolves to a real builder account (the same `NULL`
state an ordinary purchase already reaches when its builder self-deletes
*after* a normal purchase, `migrations/0062`) — otherwise the row is
written with a `null` `builderId` and no higgle credit, since there's no
one to credit. This deliberately does **not** decide what should happen
next for a sale like this (auto-refund, manual reconciliation, re-crediting
if the instance reappears, ...) — that's a reconciliation-policy call left
for separate design/owner input; it only guarantees the money is never
unaccounted for.

Refund/reversal against a real-money purchase's PaymentIntent is handled by
`POST /api/purchases/:purchaseId/refund` — see "Refunds" below (#348).

### Frontend wiring

Shop mode's proximity-tracked nearest-instance hint column
(`updateReviewFade` in `src/main.js`, shared with "Product reviews" and
"Product pricing" above) gains a "Buy" button (`#shop-buy-hint`), shown
only when the nearest instance's template has a price set. Clicking it
confirms the purchase, then calls `purchaseInstance` (`src/api.js`). If
the response is an already-completed `purchase` (the simulated path),
that's the whole flow — same as before this feature existed. If it's
`requiresPayment` instead, `runCheckoutFlow` opens `#checkout-modal`,
lazily loads Stripe.js (`https://js.stripe.com/v3/`, only the first time
it's actually needed) and mounts a card `Element`, then on "Pay" calls
`stripe.confirmCardPayment` followed by `finalizePurchase` above.

### Testing note

`worker/commerce.test.js`'s "Simulated purchases" describe block covers the
404s, the unpriced/unclaimed 400s, reading `quantity`/`buyerLabel` from the
request body (including the anonymous-default-quantity-1 case for a missing
body), the commission math (including the 0.5% floor edge case and
confirming `platformShareCents` never goes negative), the real ledger/
balance credit, the `GET /api/purchases` listing, and a malformed-JSON body
failing cleanly rather than with a raw parse error.
`e2e/simulated-purchases.test.mjs` exercises the same flow through the real
Seller-modal upload UI for the priced product, then the purchase API the
in-world hint calls — the hint's own in-world click isn't reachable without
real camera movement, same convention as product reviews/pricing (verified
manually instead, via a temporary debug hook removed before commit).

`worker/commerce.test.js`'s "Real-money checkout (#453)" describe block
covers what's actually testable without a real Stripe account (this test
suite, like local dev, never configures `STRIPE_SECRET_KEY`): a fully
connected seller's purchase still takes the simulated path when Stripe
isn't configured, `POST /purchases/finalize`'s validation-before-503
ordering, and its idempotency short-circuit for an already-finalized
`paymentIntentId` (which needs no live Stripe call at all, so it's fully
exercisable here). The actual PaymentIntent-creation/confirmation round
trip against Stripe's real API — including the "Orphaned real-money
purchases" fallback above, which only runs after that round trip — is not
covered by any automated test in this repo.

### Refunds

docs/SPEC.md §5: "Returns/refunds return real currency, not higgles ...
**Requires a higgle-commission clawback mechanism** (builder's instant
commission on a returned sale is deducted, potentially creating a negative
balance to settle)." "Returns return real currency" describes *real*
commerce and doesn't apply here — a simulated purchase never moved real
currency in the first place. What does need undoing is the one real
side-effect a purchase has: the builder's commission credit.

`POST /api/purchases/:purchaseId/refund` (`migrations/0052_purchase_refunds.sql`)
requires a session logged in as the purchase's own `sellerId`, if it has
one (`403` otherwise). A purchase of a seller-less template (an
admin/system-owned catalog item can still be priced) does **not** stay
open the way the `GET` above does — unlike a read, a refund claws back
real higgles from a builder's balance, so it falls back to requiring an
admin session instead (`401`/`403`), never no check at all. Marks a
purchase refunded and
deducts exactly `builderShareCents` (not the
full sale total — that was never the builder's money) from
`builders.higgles_balance_cents`. **No floor** — this can and deliberately
does push a builder's balance negative, matching the spec's own "potentially
creating a negative balance to settle." `404` if the purchase doesn't
exist, `400` if it's already been refunded, `400` if the product's seller
has opted into "no returns" (`metadata.noReturns === true`, docs/SPEC.md
§5's "No-returns-policy respected as seller-set default" — absent/false is
the spec's own default of accepting returns).

#### Real-money refunds (#348)

A purchase with a `paymentIntentId` (see "Real-money checkout" above —
#453) went through Stripe, not just the dev-mode simulation, so refunding
it needs to actually reverse the Stripe charge, not just flag the local
row. Alongside the higgle-commission clawback above, this issues a Stripe
refund against the original PaymentIntent with `reverse_transfer: true`
(pulls the seller's ~98% share back out of their connected account's
balance — the real-money mirror of clawing back the builder's higgle
share) and `refund_application_fee: true` (reverses higglehaven's own cut
too, so nobody keeps money on a refunded sale). `503` if
`STRIPE_SECRET_KEY` isn't configured. If Stripe's refund call fails for
any reason, the purchase is left exactly as it was before this
request — not marked refunded, builder's higgle balance untouched — so a
failed real-money reversal never looks like a successful refund and stays
retryable; only once Stripe confirms the refund does the higgle clawback
above happen at all.

A purchase's `builderId` can itself be null (migrations/0062 — the host
builder's account was later deleted; `SET NULL`, not `CASCADE`, keeps the
purchase record itself alive, matching this table's "permanent historical
receipt" design). In that case the balance clawback and the refund
notification are both skipped (nothing to credit back, and no account
left to notify) — the purchase is still marked refunded.

**Deliberately does not touch `higgles_earnings_events`** (migrations/0050)
or land cap — that ledger exists only to feed land cap's trailing-earnings
formula, and land cap's own ratchet ("once increased, never decreases")
means a refund shouldn't claw back cap growth it already produced, only the
higgles balance itself.

**Refunding is seller-initiated, not shopper self-service** — the Seller
modal's own per-product "Sales" panel (mirroring "Reviews" above,
`renderSales` in `src/main.js`) lists every purchase of that product via
`GET /api/purchases?templateId=...`, each with a "Refund" button unless
already refunded. This stands in for a real customer-service-initiated
refund (docs/SPEC.md §6's no-personal-support-contact policy) rather than
letting a shopper refund their own purchase directly — this dev-mode
identity system gives shoppers no account to authenticate a "my purchases"
view against in the first place (the same gap that makes §5's "Review
incentives" — a bonus credited to the *reviewer* — not yet buildable here
either).

A seller opts a product out of returns via its own row's "Edit Returns
Policy" panel (a single `metadata.noReturns` boolean, same
platform-controlled-key simplicity as digital goods' disclaimer) —
`.seller-no-returns-toggle`/`.seller-no-returns-panel` in `src/main.js`.

`worker/commerce.test.js`'s "Simulated purchases" describe block covers the
refund 404/already-refunded/no-returns 400s, the exact clawback amount, the
negative-balance case, the `templateId` listing filter, and — for a
seller-less purchase specifically — that refunding it is rejected with no
session or a non-admin session and only succeeds with one.
`e2e/purchase-refunds.test.mjs` covers the Sales panel's refund button and
the Edit Returns Policy panel through the real UI — the no-returns
*rejection* path isn't covered there for the same reason prohibited-content
rejection isn't in `e2e/digital-goods.test.mjs`: a real 400 trips the
shared `errors.length === 0` check.

## Tax reporting

docs/SPEC.md §7: 1099-NEC generation once a seller/builder crosses the
reporting threshold, W-8BEN/W-9 collection, and folding higgles-commission
income into the same taxable-income framework as real-money seller
payouts. Tracked as issue #350 (sub-issue of #324), broken into
sub-issues #612-#616 per the owner's Control Room direction (build
in-house; don't block app usage on paperwork until a payee actually
crosses the reporting threshold; block only earnings above the threshold
once crossed; one shared reporting pipeline showing the two income
sources — real-money seller payouts and higgles commissions — separately,
with a combined total). The foundational aggregation layer (#612),
progressive threshold-crossing notices (#613), and W-9/W-8BEN collection
with encrypted-at-rest storage (#614) are built so far — no gating on
submission (#615) and no actual 1099 generation (#616) exist yet.

### `GET /api/tax/summary`

Requires a session (`401` otherwise). Returns the calling account's gross
income for one calendar year, split by source:

```json
{
  "year": 2026,
  "builderHigglesCents": 15000,
  "sellerPayoutCents": 42000,
  "totalCents": 57000,
  "thresholdCents": 2000000,
  "noticeLevel": "early"
}
```

`year` defaults to the current UTC calendar year; pass `?year=2025` for a
past one (`400` if it isn't a plain 4-digit year between 2000 and 2100).

`builderHigglesCents` sums `higgles_earnings_events.amount_cents`
(migrations/0050) for the account's own builder profile — every account
has one (see "Builders"), so this is never absent, just possibly `0`.

`sellerPayoutCents` sums `purchases.total_cents` — the full buyer-paid
transaction amount, **not** the seller's own net share after commission —
for every non-refunded, real-money (`payment_intent_id NOT NULL`) purchase
of the account's own seller profile, if it has one (`0` if it doesn't).
This is deliberate, not an oversight: Form 1099-K's own "gross amount"
instructions define gross as the full transaction total "without regard to
any adjustments ... for fees," so the commission higglehaven keeps is not
netted out here even though it never reaches the seller's own Stripe
balance (contrast with `GET /api/sellers/me/payouts`'s `availableCents`
above, which *is* the net, post-commission share — a different question:
"what can I withdraw" vs. "what does the IRS say I grossed").

Both totals key off `purchases.created_at`/`higgles_earnings_events.created_at`
(the transaction date), not `paid_out_at` — this may need revisiting once
#616 (actual 1099 generation) settles the precise IRS-correct date to
report against, per that sub-issue's own open questions.

`thresholdCents` is the federal 1099-K reporting threshold as of the OBBBA
rollback ($20,000 — the $600 ARPA threshold was reversed; see #350's own
research comment), applied here to the *combined* `totalCents` per the
owner's own "share a reporting pipeline" direction, even though the real
1099-K threshold technically has a second leg (200 transactions) that only
applies to the card-settled seller side, and the correct threshold/form for
the higgles side specifically still needs a tax professional's confirmation.
`noticeLevel` is a purely informational, non-blocking signal (#613) — one
of `"none"` (below 50% of `thresholdCents`), `"early"` (50-79%),
`"approaching"` (80-99%), or `"crossed"` (100%+). Nothing in the API
actually gates on this yet — see #615 for the not-yet-built earnings gate.

The account menu (`#account-menu-tax-notice`, next to the existing land-cap
line — see "Frontend-only account menu") shows a plain-text notice matching
`noticeLevel` whenever it isn't `"none"`, refreshed the same "on menu open,
no live polling" way the land-cap line already is; `"crossed"` renders in
`--danger` for visibility. Nothing about this notice blocks any action.

### `POST /api/tax/id-form`

Requires a session (`401` otherwise). Submits a W-9 (US persons) or W-8BEN
(non-US persons) tax-identification form for the calling account. `503` if
`TAX_ID_ENCRYPTION_KEY` isn't configured on the server — same guarded-secret
shape as `STRIPE_SECRET_KEY`/`DIDIT_API_KEY` (see "Real-money purchases" and
"Government-ID verification"), never configured in local dev or the
automated test suite.

Body:

```json
{
  "formType": "w9",
  "legalName": "Ada Lovelace",
  "addressLine1": "1 Analytical Engine Way",
  "city": "London",
  "state": "CA",
  "postalCode": "90210",
  "taxIdNumber": "123-45-6789"
}
```

`formType` must be `"w9"` or `"w8ben"` (`400` otherwise) — they genuinely
require different fields, not just a relabeled copy of the same form.
`legalName`, `addressLine1`, and `city` are required for both. A `"w9"`
submission additionally requires `state`, `postalCode`, and `taxIdNumber`
(the SSN or EIN). A `"w8ben"` submission instead requires `country`,
`countryOfCitizenship`, and `foreignTaxId`. Any missing required field is a
`400` naming the field.

Returns `{ "taxFormType": "w9", "taxFormCompletedAt": "<ISO timestamp>" }`.
A later resubmission (e.g. a corrected SSN, or switching from an
already-filed W-8BEN to a W-9 after becoming a US person) overwrites the
prior submission outright — this isn't gated on anything yet, since #615
(the sub-issue that actually restricts access based on whether a form is on
file) doesn't exist yet, so there's nothing a resubmission could conflict
with.

The entire submitted form (name, address, and the SSN/EIN or foreign tax
ID) is encrypted as one JSON blob with AES-256-GCM before it ever reaches
D1 — a database dump alone can't expose it. The key is `TAX_ID_ENCRYPTION_KEY`,
a 256-bit value given as 64 hex characters, imported fresh per call via
Workers' native `crypto.subtle` (no dependency needed). Storage format is
self-describing — `` aesgcm$<ivHex>$<ciphertextHex> `` — the same idiom
`hashPassword`'s own `` pbkdf2$<iterations>$<saltHex>$<hashHex> `` string
uses elsewhere in this codebase; the IV is freshly random per encryption,
since reusing one with the same key breaks AES-GCM's confidentiality
guarantee. Only the form type and completion timestamp are stored in plain
`users` columns (`tax_form_type`, `tax_form_completed_at` — migrations/0077)
since #615's future gating logic and the account view need those without
ever decrypting anything; nothing currently decrypts the stored blob back
(no admin/export endpoint exists yet — that's out of scope for #614).

`GET /api/auth/me` also now returns `taxFormType`/`taxFormCompletedAt` on
the `user` object (`null`/`null` until a form is submitted), so the account
view can show submission status without a separate endpoint.

#### Testing note

`worker/commerce.test.js`'s "Tax summary (#612)" describe block (nested
inside "Seller payouts", reusing its `createConnectedSeller`/
`makeRealMoneyPurchase` helpers) covers the `401`, the all-zeros default,
higgles-commission counting, the seller's gross-vs-net distinction, excluding
a refunded purchase, year filtering, the malformed-`year` `400`, and (#613)
the `noticeLevel` progression through all four breakpoints via the admin
land-cap-grants escape hatch. `e2e/land-cap.test.mjs` covers the account
menu notice staying hidden for a fresh builder with no earnings, alongside
its existing land-cap display check — the actual notice text for a
nonzero `noticeLevel` isn't covered there, since reaching it needs more
real income than that suite's fixture setup produces.

`worker/tax-id-form.test.js` is its own file, not nested in
`commerce.test.js`, specifically so it can set `env.TAX_ID_ENCRYPTION_KEY`
(each `worker/*.test.js` file gets its own isolated D1/worker instance —
see `worker/test-helpers.js`'s own comment) without that leaking into
`commerce.test.js`'s own "Tax summary (#612)" describe block, which relies
on the key staying unset to cover the `503`-unconfigured path for this same
endpoint instead. Between the two files: the `401`, the `503` when
unconfigured, `formType` validation (rejecting neither-w9-nor-w8ben and
each form's own missing required field), a successful W-9 and W-8BEN
submission each, the stored ciphertext never containing the plaintext SSN
or address, resubmission overwriting a prior submission, and
`taxFormType`/`taxFormCompletedAt` showing up on `GET /api/auth/me`.

## D1 schema overview

The migrations currently create seventeen main backend tables:

- `builders`: the shared dev-mode builder identity roster (see "Builders").
- `sellers`: a genuinely separate dev-mode identity roster for sellers (see
  "Sellers") — `catalog_templates.seller_id` references this, not `builders`.
- `catalog_templates`: placeholder product templates and minimum product
  metadata.
- `landlets`: dev landlet records, including greenbelt/claimed/generating
  status, class, polygon metadata, generation timestamps, and placeholder
  owner IDs.
- `placed_instances`: objects placed into a landlet from catalog templates,
  including any per-instance crop override (see "Extensible products (crop)")
  and legacy uniform Resize scale factor (see "Legacy per-instance Resize
  scale").
- `world_settings`: singleton dev world settings for circular expansion and
  shared world constants.
- `landlet_versions`: immutable layout snapshot metadata.
- `version_instances`: instance transforms captured within each snapshot.
- `landlet_candidates`: lightweight planned plots awaiting first circle overlap,
  with optional generated-ring membership.
- `land_candidate_rings`: atomic radial reservations for procedurally generated
  candidate bands, including boundary signatures that keep adjacent polygonal
  rings seam-compatible and optional parent links for derived ring chains.
- `notifications`: builder-facing notices, currently only ever created by a
  seller's product-dimension change (see "Notifications" above).
- `friendships`: one row per friend relationship between two builders,
  direction preserved, status `pending`/`accepted` (see "Friend requests"
  above).
- `higgles_earnings_events`: a per-event, timestamped higgle-earnings ledger
  per builder (see "Land cap" above), distinct from the running
  `builders.higgles_balance_cents` lifetime total.
- `bundles`: a builder's saved, named multi-item groups (see "Bundles" above).
- `sign_posts`: shopper-authored posts on a placed instance flagged
  `isCommunitySign` (see "Community signs" above), cascade-deleted with
  their instance.
- `calendar_events`: builder-authored events on a placed instance flagged
  `isCommunityCalendar` (see "Community calendar" above), cascade-deleted
  with their instance. Optionally carries `scheduled_at`/`triggered_at` for
  the one-shot creative-tool trigger (see "Scheduled calendar events +
  creative-tool trigger" above).
- `product_reviews`: shopper-authored star ratings (+ optional text) on a
  catalog template (see "Product reviews" above), no opt-in flag needed,
  cascade-deleted with their template.
- `auctions`: land acquisition auction listings on a claimed landlet (see
  "Land acquisition auctions" above).
- `auction_bids`: bids placed on an auction, cascade-deleted with it.
- `purchases`: a permanent receipt of each simulated "buy" of a priced
  placed instance (see "Simulated purchases" above), including its full
  commission breakdown and an optional `refunded_at` (see "Refunds" above).
  `instance_id`/`template_id`/`seller_id` are deliberately not foreign
  keys — not cascade-deleted if the thing they reference is later removed.

Land candidates persist their precomputed minimum world-circle overlap radius.
World expansion uses its indexed value to avoid reading every distant pending
candidate before applying the exact polygon overlap check. Candidates created
before that migration retain a conservative zero value until updated, so they
cannot be skipped incorrectly.

Candidates also persist their maximum world-circle radius. Ring generation uses
the indexed radial bounds to reject overlapping annular bands without scanning
and decoding the complete candidate queue. The migration backfills this bound
for existing polygon and polygonless candidates.

Landlets likewise persist their maximum world-circle radius. Expansion uses it
to avoid reading completed generating plots that are still too far away to be
fully enclosed. Pre-migration landlets retain a null value and continue through
the exact geometry check, so existing plots cannot be skipped.

Indexes currently support category filtering, placed-instance lookups by
landlet/template, cursor-paginated landlet status/owner lookups, landlet
position lookups, and the one-claimed-landlet-per-builder rule.

Seed data includes:

- `starter-landlet`
- `placeholder-table`
- `placeholder-chair`
- `placeholder-tree`
- `brick`
- `door` (extensible along `x`, minimum 0.4m)
- `lumber-board` (extensible along `x`, minimum 0.1m)

## Private-preview access gate

Every request — pages, every `/api/*` route, `/uploads/*` — can optionally be
gated behind a single shared passphrase, entirely at the top of the Worker's
`fetch` handler in `worker/index.js`, before any of the routing described
above ever runs.

Configure it by setting the `ACCESS_PASSPHRASE` secret:

```
wrangler secret put ACCESS_PASSPHRASE
```

When that secret is unset (the default — local `wrangler dev`, the vitest
suite, and any deployment that never runs the command above), the gate is
skipped entirely and every route behaves exactly as documented elsewhere in
this file. Setting it activates the gate on the next deploy.

A visitor without a valid session sees a minimal login page (or, for
`/api/*`/`/uploads/*` requests, a `401 {"error": "Unauthorized"}` instead of
HTML) and must submit the passphrase via `POST /__access/login`. A correct
submission sets an `HttpOnly`, `SameSite=Lax` cookie containing an
HMAC-SHA256 token keyed by the passphrase itself (recomputed and compared on
every subsequent request — nothing is stored server-side, so rotating the
passphrase secret instantly invalidates every existing session).

This is a shared-passphrase gate for "let a few people see the preview," not
a replacement for the real per-user authentication described in
"Authentication" and "Authorization model" above — everyone behind it shares
one passphrase and one session shape, and it has no concept of the
`ownerBuilderId`/builder identity used elsewhere in this API. It's a
coarser, all-or-nothing layer that sits in front of that real system, not a
substitute for it: once past the gate, every route still enforces its own
per-user auth exactly as documented elsewhere in this file.

This depends on `wrangler.jsonc`'s `assets.run_worker_first: true`. Without
it, Cloudflare serves static files (`/`, `/assets/*`) directly from the
`ASSETS` binding and never invokes the Worker's `fetch` handler at all, so
the gate would never see those requests.

## Frontend integration notes

- The current API already matches the frontend's Z-up placement convention via
  `x`, `y`, `z`, and `rotationZ` response fields.
- `id` is returned alongside `instanceId` on placed instances for compatibility
  with existing local instance handling.
- Frontend code should treat backend persistence as the source of truth once the
  API is available, with any offline/local fallback kept intentionally separate.
- Future auth should not be inferred from this API. All endpoints are currently
  open by design for dev-only MVP work — the optional private-preview gate
  above controls who can reach the API at all, but doesn't add per-user
  identity, permissions, or ownership checks within it.

## Frontend-only navigation (Shop / Build / Sell)

Shop, Build, and Sell are the three peer top-level views, switched via the
always-visible `#mode-nav` (main.js, not a backend concept). Shop is the
default landing view — a fresh load or a plain browser refresh goes straight
into it, no login gate first, matching how it's always worked (`enterShopMode`
needs no `builderId`). Build now requires a real, logged-in account (see
"Builders") and a claimed landlet, so switching into it runs the same
login/claim flow bootstrap() always ran, just deferred until the nav is
actually clicked instead of unconditionally at startup. Sell only needs
its own seller identity — a genuinely separate one from a builder's, not
reused (see "Sellers" and "Managing extensibility" above) — so it opens as
a plain overlay on top of whichever of the other two is currently active,
no builder identity, mode switch, or claimed landlet required (just the
same login requirement, independently).

Shop and Build are different enough scene setups (per-world absolute
coordinates + flight controls vs. one landlet's local coordinates + build
gizmos) that switching between them goes through a full page reload rather
than a live in-place teardown/rebuild — a deliberate choice, not an
oversight: a live teardown/rebuild between two scene setups this different
was judged riskier than the reload's brief flash. `sessionStorage`'s
`higglehaven.startMode` carries the *next* mode across that one reload;
it's consumed once bootstrap() reads it, so an unrelated refresh with
nothing set always falls back to Shop.

## Frontend-only account menu

docs/SPEC.md §1's "Visual brand direction": "clean, minimalist, simple ...
using expanding/collapsing menus to keep persistent on-screen chrome to a
minimum." The Log In/Notices/Friends/Settings buttons (originally Identity
in place of Log In, back when a free-text dev-mode picker stood in for
real accounts — see "Builders") used to be four independent always-visible
pills across two screen rows (top-left). They're now one collapsed
`#account-menu-toggle` pill that expands `#account-menu-panel` — a small
dropdown holding the same four buttons as plain rows — freeing an entire
row of screen space in the common case where none of them are actually
being used.

**Notices/Friends/Settings are otherwise unchanged** — same IDs
(`notifications-btn`/`friends-btn`/`settings-btn`), same click handlers,
same modals, just normal-flow rows inside the panel instead of independent
`position: fixed` pills. The former `identity-btn` slot is now
`account-auth-btn`, opening `#auth-modal` (real login, or the logged-in
account panel — see "Authentication") instead of the old picker. This
matters for `SHOP_HIDDEN_BUILDER_UI_IDS` (main.js) — Notices/Friends are
still hidden in Shop mode (via `style.display = 'none'` on those specific
row elements), while the login button, Settings, and the menu toggle
itself all stay visible, since checking who's logged in (or logging in at
all) and Settings are both relevant regardless of mode.

A small red dot appears on the collapsed toggle whenever either badge
inside has an unread count — pure CSS
(`#account-menu:has(#notifications-badge:not([hidden])) #account-menu-toggle::after`),
reusing the same `:has()` technique `body:has(#catalog-picker.visible)`
already relies on elsewhere in this file, so it needs no separate JS
bookkeeping beyond the badge `hidden`-attribute toggles
`refreshNotificationsBadge`/`refreshFriendsBadge` already do. The panel
closes itself once any row inside is clicked (each opens its own modal, so
there's no reason to leave the menu open behind it), or on any outside tap.

### Testing note

Every e2e test that used to click `#identity-btn`/`#notifications-btn`/
`#friends-btn`/`#settings-btn` directly now calls `openAccountMenu(page)`
(`e2e/helpers.mjs`) first to expand the panel — Playwright's `.click()`
requires a target to actually be visible, and a row inside a collapsed
(`display: none`) panel isn't. Tests that only ever *waited* for
`#identity-btn`/`#account-menu-toggle` to become visible as a "Build mode
finished loading" sync point (never clicked it) wait for
`#account-menu-toggle` instead, which carries that same
always-in-the-DOM-once-Build-mode-loads property real login didn't change.

## Day-night cycle — removed (fixed bright daylight instead)

docs/SPEC.md §1 originally called for a "shared, compressed 4-hour cycle
(1 hour each: daylight, dusk, night, dawn)." **This has been removed** (not
merely disabled) at the explicit direction of the product owner: a dark
"night" phase read as ominous rather than the lighthearted, bright,
whimsical feel this world is going for, and cycling through three
different lighting conditions put an unreasonable burden on builders to
make their space look good in all of them. The world is now fixed at
permanent bright daylight.

What used to exist: `src/dayNightCycle.js` (a small, dependency-free
phase/color-interpolation module, with its own `src/dayNightCycle.test.js`
coverage) and `updateDayNightLighting()` in `src/main.js`, called every
`animate()` frame to retint `ambientLight`/`sunLight`/`scene.background`
and the Shop-mode wall/dome backdrop against a real-wall-clock-driven
phase. Both files are deleted; `ambientLight`/`sunLight`/`scene.background`
are now just set once, permanently, to what used to be the cycle's own
"daylight" keyframe values — so the lit look itself didn't change, only
the fact that it never stops being this. The Shop-mode wall/dome tint
(previously retinted per frame to match) needed no equivalent fix: their
material's default (unset) color is white, identical to the daylight
keyframe's ambient tint they were being retinted to anyway.

The `world_settings.day_cycle_hours` D1 column and its `dayCycleHours`
field on `GET/PATCH /api/world` are deliberately left in place — removing
a column is a real migration, and an unused-but-harmless field is a far
smaller cost than a schema change purely to tidy up after a frontend
feature removal. Nothing reads or writes it from the frontend anymore.
Revisiting a day-night cycle later (the removal is about the *current*
lighthearted-brand direction, not a permanent architectural decision)
would mean re-adding the frontend piece, not a new migration.

## Frontend-only Shop-mode world boundary

Shop mode's world is bounded by a wall (a cylinder at the gap-free coverage
radius — see `computeGaplessWorldRadius`'s own comment for why that can be
smaller than the world's administrative `radiusM`, especially in sparsely-
generated dev data) capped by a dome, so the world reads as fully enclosed
rather than open-topped. Both share one continuous vertical color gradient
— pale ground-green at the wall's base, through a hazy horizon blend right
at the wall/dome seam, up to a deeper sky blue at the dome's own apex —
painted as vertex colors (`paintVerticalGradient` in main.js) rather than a
texture, so the seam between the two meshes is exactly continuous rather
than approximately matched. The intent is a horizon that recedes into
atmospheric haze and open sky, not a wall the world visibly stops at.

The dome's rise above the wall is independent of the wall's own radius (a
non-uniform mesh scale, not a geometry rebuild) and grows on its own if
anything loaded anywhere in the world is ever discovered taller than it
currently clears (`growShopDomeIfNeeded`, called as each Shop-mode landlet's
instances load in) — reactive to what's actually been loaded so far, not a
global precomputed guarantee, since Shop only loads a landlet's instances
once the camera gets near it.

Shop's "zoom" (mouse wheel / pinch) is a pure camera-lens FOV change, not a
dolly — the camera never actually moves closer or farther, so there's no
clipping-through-geometry risk that would otherwise argue for a narrow
range. The FOV spans 6&deg; (roughly 10x magnification versus the 60&deg;
default) to 100&deg; (past human peripheral vision into genuine ultra-wide
territory).

The camera is also kept a real clearance distance back from the wall's own
radius (`SHOP_WALL_CLEARANCE_M`, scaled down for a small gapless world but
never below `SHOP_WALL_CLEARANCE_MIN_M`) — separate from, and much larger
than, the small `SHOP_WALL_MARGIN_M` overlap that only exists to hide the
ground/wall seam. Standing right up against the wall and swinging the
camera from straight down back up past horizontal could let a viewer
glimpse past it: at a grazing, near-tangent angle the wall's own
paper-thin, single-sided geometry doesn't reliably cover the view the way
a real solid wall would. Real clearance keeps that grazing angle out of
reach of normal look input.

## Frontend-only default avatar and third-person walking

Shop mode gives the shopper a visible body (docs/SPEC.md §2's default
avatar — "a single, standard, deliberately non-gendered avatar assigned
instantly at registration") instead of a bodiless free-flying camera. No
modeled-and-rigged character asset exists yet, so `createShopAvatar` in
`src/main.js` builds a plain placeholder from primitives — capsule torso,
sphere head, cylinder limbs — rather than loading a GLTF. Reskinning it
with a real asset later is a `createShopAvatar` rewrite, not a redesign of
anything below.

Movement is real ground-based walking, not free flight: the move joystick
changes `shopAvatarPosition` (the avatar's own feet position, clamped to
the ground plane) at `SHOP_WALK_SPEED_M_S`/`SHOP_RUN_SPEED_M_S` (1.8/2.7
m/s, docs/SPEC.md §2's confirmed speeds) rather than moving the camera
directly. There's no separate run input — the joystick's own deflection
(0..1) doubles as intensity, linearly interpolating between the two
speeds, so a full push runs and a gentle nudge walks. The same deflection
drives `updateShopAvatarPose`'s walk-cycle: swing amplitude and cycle speed
both scale with it and ease back to a neutral standing pose (rather than
snapping) once the joystick releases.

The camera is no longer the player — it's a third-person rig that orbits a
fixed `SHOP_CAMERA_FOLLOW_DISTANCE_M` around a point roughly at the
avatar's own head height (`positionShopCamera`, `SHOP_CAMERA_ANCHOR_HEIGHT_M`),
subtracting the current look direction from that anchor. Looking down
swings the camera up and back over the avatar's shoulder; looking up swings
it down and in toward the avatar's own back — the standard over-the-
shoulder feel, with no separate collision pass: `clampShopCameraHeight`
(shared with the avatar's own ground clamp) and the wall-radius clamp
(`clampShopRadius`, shared between the avatar's position and the camera's)
still catch the rare look angle that would otherwise dip the camera
underground or swing it past the world wall.

## Frontend-only flight

docs/SPEC.md §2's flight — `updateShopFlight`/`toggleShopFlight` in
`src/main.js` drive a small state machine (`shopFlightState`: `'grounded'`
| `'takingOff'` | `'flying'` | `'landing'`) over `shopFlightAltitudeM`, the
avatar's own altitude (mirrored onto `shopAvatarPosition.z` every frame in
`updateShopMovement`, which the existing camera-follow logic already tracks
for free since it's relative to the avatar's position).

Trigger matches the spec's own wording exactly — "double-tap jump (mobile)
/ double-press spacebar (desktop)" — via `bindShopFlyToggle` (the new
`#shop-fly-btn`) and a `keydown` listener on `Space`, both requiring two
presses within `SHOP_FLIGHT_DOUBLE_PRESS_WINDOW_MS` (400ms) rather than
one, so an ordinary single tap/press never launches the player
accidentally. Takeoff ramps `shopFlightAltitudeM` from 0 to
`SHOP_FLIGHT_HOVER_START_ALTITUDE_M` over `SHOP_FLIGHT_TAKEOFF_DURATION_S`
(spec's "~1s lift"); landing reverses that over
`SHOP_FLIGHT_LANDING_DURATION_S` (spec's "~2s reverse") from whatever
altitude the player was actually at (`shopFlightLandingStartAltitudeM`,
captured the instant landing starts). Both ramps are smoothstep-eased, not
linear. Once actually `'flying'`, a press-and-hold Up/Down pair
(`#shop-vertical-controls`, shown only while airborne via a `shop-flying`
class on `<body>`) climbs/descends at `SHOP_FLIGHT_VERTICAL_SPEED_M_S`,
clamped between a low floor and the same dynamic dome ceiling the camera's
own height clamp already respects (`clampShopCameraHeight`'s formula) —
**not** literally the spec's 500m, since this world's wall/dome backdrop
was never built for a sky that tall; see `SHOP_FLIGHT_SPEED_EXPONENT`'s own
comment in `src/main.js` for why that's a deliberate scope boundary for
this pass, not an oversight.

Horizontal flight speed follows the spec's altitude/speed curve
(`flightSpeedMultiplier`): "each doubling of altitude ≈ 50% more max ground
speed" fixes the curve's shape as a power law with exponent log2(1.5); the
spec's own two data points — "~10x walking speed near building-height" and
"up to ~100x at max altitude" — anchor it and land almost exactly on the
spec's own 500m figure when solved, a strong signal this is the intended
curve rather than an arbitrary fit.

Two spec details are deliberately not built, both because they're
inherently about *other players* seeing you, and this is still
single-player only (docs/SPEC.md §9's phase-4 multiplayer presence hasn't
landed): "flying avatars are invisible to other users" (so takeoff/landing
here are pure altitude ramps, no fade — there's no one else to fade for)
and "occupied landing spots offset to nearest open space" (nothing exists
yet to occupy a spot with).

**First-ever-visit spawn** (docs/SPEC.md §1: "new users spawn zoomed-out in
flight mode above the world") — a genuinely first-ever Shop-mode entry on
this device (`enterShopMode` in `src/main.js`, gated by a
`localStorage.higglehaven.shopVisitedBefore` flag, since Shop mode itself
needs no login to track this against an account) spawns straight into
`'flying'` at a fixed starting altitude, skipping the `'takingOff'` ramp
entirely — that ramp is for a player-initiated toggle mid-session, not this
one-time spawn. Every later Shop-mode entry (same device, flag now set)
starts `'grounded'` as before.

## Frontend-only avatar idle animation

Idle animation (docs/SPEC.md §2: "context-aware idle state machine (sit,
lean, stand) after inactivity, with randomization") — `updateShopAvatarIdle`
covers "stand" only: after `SHOP_IDLE_DELAY_S` with no move-joystick input,
a subtle whole-body weight-shift sway (`shopIdleSwayYawOffset`, added on top
of `shopYaw` when the avatar's own facing is set) plus an occasional head
turn (`headPivot.rotation.z`, its own pivot separate from the body so it can
turn independently) ease in. Both the sway period and the head-turn
target/interval are re-rolled at the end of their own cycle rather than
shared or fixed, so idle motion never repeats identically. Ends the instant
real movement resumes — a hard cut (`shopIdleBlend` snaps to 0), not an
ease-out, since a lingering sway would read as the avatar fighting the
player's own input. "Sit"/"lean" are still open — both need a real
interaction-target concept (e.g. a chair prop with an occupancy slot) that
doesn't exist yet.

## Legacy per-instance Resize scale

Build mode once had a "Resize" gizmo mode — a real uniform scale for a
placed instance, entirely separate from Trim's per-axis `crop`, for a model
whose own source came in at the wrong physical size entirely. It's been
removed (found via backlog audit, #404): the world is meant to be populated
at each product's real, seller-declared size, not resized ad hoc per
placement, so there's no `#mode-resize` button, no scale gizmo, and no
percentage input anywhere in the frontend today.

`mesh.userData.scale`/the instance's `scale` field still exists purely as a
read compatibility path: any instance saved *before* the removal that
carries a non-`1` value keeps rendering at it (`createMeshForInstance`
applies it via `object.scale.setScalar(...)`), and `scale` still factors
into `meshDimensions()` alongside `crop` so collision/bounds-clamping/
stacking see such an instance's real (scaled) footprint. There's no UI path
left to set a new value — only to keep honoring one an instance already
has.

## Frontend-only alignment assist

docs/SPEC.md §3's "Alignment assist: snap-with-escape model — transient
guide near an alignment opportunity, continued movement releases it,
pausing commits it." Purely frontend, touches no persisted state beyond
whatever an ordinary Move drag was already going to write — there's
nothing here for the backend to know about.

Only applies to a single selected item's own Move (translate) drag, not a
group move — a group move already has its own collision/bounds-clamping
logic (`resolveGroupAxisDelta` and friends), and layering alignment
snapping on top of that too was a lot more moving parts for a feature this
deliberately simple isn't worth the risk to. X/Y only, not height — height
alignment (resting on top of another item) is what `snapToSurfaces`
already does.

While dragging, the moved item's own min/center/max along each axis are
compared against every *other* placed item's own min/center/max
(`alignmentTargets`/`findAlignmentSnap` in `src/main.js`) — both computed
as a plain axis-aligned box from `meshDimensions`, ignoring rotation, the
same simplifying assumption the group-move bounds clamp already makes for
every placed item. The closest pair within `ALIGNMENT_SNAP_M` (0.05m — the
spec's own words, "conservative starting threshold, tune via
playtesting," apply literally to this constant) snaps the dragged item's
matching edge/center exactly onto the target, and a dashed magenta guide
line spans the landlet at that coordinate for as long as the snap holds.

The "continued movement releases it, pausing commits it" half is
hysteresis, not velocity tracking: once snapped, the position stays frozen
at the snapped value as long as the *raw* (unsnapped) drag request stays
within a second, wider `ALIGNMENT_RELEASE_M` (0.15m) of the held target —
only once the raw request drifts past that does it let go and start
tracking the pointer directly again (immediately eligible to find a fresh
snap on the very next frame). This is what keeps a snap reading as a
magnet with some real grip instead of flickering on/off right at one
threshold. Alignment assist runs last in the drag pipeline, after the
landlet-bounds clamp and `snapToSurfaces`' own collision resolution — it
only ever nudges within whatever room those two already left, never
contests them for it.

No automated test covers the drag-triggered snap itself, for the same
reason Trim's own drag *handle* doesn't (see "Extensible products (crop)"
above, "Dragging the Trim gizmo") — simulating a precise TransformControls
drag headlessly is fragile on its own terms, and this project's e2e suite
already avoids it in favor of an equivalent non-drag write path where one
exists. Alignment assist has no such equivalent (there's nothing to type
into a field), so it was instead verified manually: two items placed at
known coordinates via the API, a real mouse drag on the Move gizmo,
reading the resulting synced position back out. That pass confirmed the
snap engages exactly on an edge match, holds through several more small
mouse movements, and correctly releases once the drag genuinely moves on
— all three of the behaviors this section describes.

## Ground/flooring products

docs/SPEC.md §3: "placing a specific real flooring/sod product replaces
[the default grass] within that footprint." A seller opts a catalog
template into this behavior via `metadata.flooring: true` (checked by
`isFlooringTemplate()` in `src/main.js`), toggled by a plain "Flooring" /
"Flooring ✓" button on each row of the Seller modal — the same
immediate-PATCH pattern the row's other action buttons already use, not a
collapsed panel with its own Save step, since it's a single boolean rather
than a numeric form like Extensibility or Edit Size.

True texture-masking of the shared ground mesh within an arbitrary
footprint — so a placed sod patch actually looks like grass blending into
the surrounding grass, or a placed tile patch looks like tile — is a real
rendering problem on its own and out of scope here. Flooring instead
always renders as a thin, flat, tinted slab (`FLOORING_THICKNESS_M` =
0.02m, `template.color`) at true ground level, ignoring the template's own
declared height and (if it has one) its uploaded model entirely. This is
the same simplification a placeholder colored box already stands in for
any product with no real model — "this patch of ground is now this
product," not a faithful render of it. `createMeshForInstance` gives
flooring its own short-circuited code path for this reason: no model
loading, no crop/extensibility, no legacy uniform-scale handling, since
none of Trim/Resize apply to a flat ground patch.

The one subtlety worth calling out: `meshDimensions()` — the single
function `clampToLandlet`, collision resolution (`resolveByAxis`), the
group-move bounds clamp, and alignment assist's own half-extent
calculation all read for "how big is this placed mesh" — has to agree a
flooring mesh is genuinely thin, not whatever height the seller declared
for the (unused, for flooring) full-size model it was uploaded from. That
special case is made once, inside `meshDimensions()` itself, rather than
at each call site: `isFlooringTemplate(template)` short-circuits it to
return the fixed `FLOORING_THICKNESS_M` for height regardless of the
template's own dimensions. Getting this wrong is exactly the bug this
feature originally shipped with during testing — `clampToLandlet`'s own
minimum-z floor (`height / 2`) used the crate template's real declared
height before this fix existed, which forced a flooring instance's z up
to 0.5 instead of resting at 0.01 flush with the ground. Fixing
`meshDimensions()` itself, rather than patching `clampToLandlet` alone,
is what keeps every other consumer of "how tall is this mesh" correct too.

Flooring is free to move in X/Y like any other placed item, but the Move
gizmo's Z (blue) arrow is prevented from lifting a "patch of ground" up
into the air: the `objectChange` handler's single-mesh branch pins
`resolved.z` to `FLOORING_THICKNESS_M / 2` whenever the dragged object's
template is flooring, after alignment assist and the landlet-bounds/
collision clamp have already run.

Covered by `e2e/flooring.test.mjs`: marks an uploaded template as
flooring via the Seller modal toggle, places a tree, then places the
flooring instance by tapping directly on the tree's own screen position
(a normal item tapped there would rest on top of the tree via
`snapToSurfaces`) and reads the persisted instance back from the API to
confirm its z lands at the thin ground thickness rather than stacked on
the tree.

## Frontend-only camera navigation (free-look with nothing selected)

Build mode's camera is an `OrbitControls` instance orbiting `controls.target`.
With a product selected, a one-finger rotate re-centers `target` onto that
product's own position right as the rotate begins (`getSelectionPivot`/
`beginTargetTween`) — rotating then orbits at the real distance to that
product, and reads as "look around the thing I'm inspecting." With
*nothing* selected, there's no product to recenter onto, and orbiting
around whatever `target` was last left at (wherever panning or an earlier
selection put it — an essentially arbitrary point) felt difficult and
disorienting: the whole scene visibly swings around a point that isn't
where the builder is actually looking.

**Two earlier fixes were tried and reverted**, both raycasting a stand-in
pivot for this case (once from the gesture's start point, once from the
screen's center) — each fixed the disorientation but introduced a new
problem: the raycast target rarely matched wherever `target` already was,
so the very start of a rotate visibly jumped the camera. The current fix
takes a different approach entirely, matching the request that produced
it: make a one-finger drag with nothing selected feel like Shop mode's own
look controls (camera position never moves, only facing direction
changes) — but by continuously canceling out the relevant part of
OrbitControls' own behavior, rather than replacing OrbitControls with a
second, parallel camera controller the way Shop mode has one.

Mechanically: every `controls` `'change'` event fired during such a drag
restores `camera.position` to exactly where it was when the drag began
(`freeLookAnchorPosition`), and moves the otherwise-invisible `target` to
sit a fixed distance directly ahead of that anchored position along the
camera's (just-rotated) facing direction. Orbiting around a point defined
as "wherever is `lastKnownDistance` ahead of the camera" is, mathematically,
indistinguishable from a pure look-in-place rotation — OrbitControls is
still the one moving things, just around a target that tracks the camera
instead of a fixed world point. This needed to stay *sticky* through
`enableDamping`'s post-release coast-down (`freeLookActive` is deliberately
not cleared on `pointerup`/`pointercancel`, only once a genuinely different
gesture — a pan/dolly, or a rotate that lands on a real selection — is
confirmed), otherwise the last few damped frames of every free-look drag
would snap back to orbiting the stale target for an instant right at the
end. A stray wheel-driven dolly or a fresh touch gesture starting during
that coast-down both explicitly clear `freeLookActive` first (a
`window`-level `capture: true` listener for wheel, since it never fires a
`pointerdown`; the ordinary `pointerdown` counter for touch/mouse) so
neither gets wrongly pinned in place by a flag left over from the previous
drag. Panning and dolly-as-fly-forward (see below) are untouched by any of
this — only the rotate gesture's behavior changes.

With nothing selected, scrolling/pinching is a *dolly* converted into a
*truck*: `controls.target` is continuously redefined as "wherever is
`dollyDelta` ahead of the camera" too, so zooming in never gets stuck
approaching a fixed focus point — it's flying forward, the same as a
walk/fly-camera tool elsewhere. This existing behavior (`MAX_FLY_TARGET_DISTANCE_M`-
clamped so it can't fly the target arbitrarily far from the landlet) is
unchanged by the free-look fix; the two are mutually exclusive per event
(`!freeLookActive` guards it) since they only ever apply to genuinely
different gestures.

### Testing note

Not covered by the automated e2e suite — real camera drag gestures aren't
simulated anywhere in this project (see "Frontend-only alignment assist"
above for the same limitation). Verified manually: a temporary
`page.evaluate` + synthetic `pointerdown`/`pointermove`/`pointerup`
dispatch sequence (no lasting `window.__debug*` hook needed, since
`camera`/`controls` are reachable for inspection without one) confirmed
`camera.position` stays fixed to within floating-point noise across a
multi-step rotate with nothing selected, while `camera.quaternion` visibly
changes; that selecting a product mid-session still recenters and orbits
it normally afterward; and that a wheel-zoom immediately following a
free-look drag flies forward/backward rather than snapping the camera back
to the drag's anchor position.

## Frontend-only Measure

A one-shot ruler for a question none of the placement tools answer on their
own — "is this stack of `Wall - White` courses exactly 10 feet high?" is
easy to eyeball wrong and tedious to work out from individual item heights
by hand. `#toggle-measure` (in the same panel as Multi-Select) is its own
exclusive mode, entirely separate from the Move/Rotate/Trim/Resize gizmo
row and from Multi-Select — turning it on exits whichever of those is
active (see `exitMultiSelectMode`/`exitMeasureMode` in `src/main.js`), and
switching to any of them exits Measure in turn. It touches no persisted
state at all — purely a frontend visual aid, nothing it does is ever sent
to the server.

While it's on, a tap sets a ruler point instead of selecting anything: the
first tap places point A, the second places point B and shows the result.
Each tap resolves to a 3D point via the same "a placed item's own surface
wins over the bare ground beneath it" raycast `handlePlacementClick`
already uses for tap-to-place (see `resolveMeasurePoint`) — so a point can
land precisely on, say, the top face of a stacked course, not only ever on
the ground plane underneath everything. Two small spheres mark the picked
points and a dashed line joins them (`measureMarkerA`/`measureMarkerB`/
`measureLine`) for a few seconds of visual confirmation of what was
actually measured, not just its number.

**Either endpoint can be dragged afterward** to adjust a measurement
without starting over — grabbing and moving point A or B re-resolves a new
3D point under the finger on every `pointermove` (the same
`resolveMeasurePoint` raycast) and live-updates the marker, the line, and
the result text. This is a small dedicated `pointerdown`/`pointermove`/
`pointerup` sequence (`draggingMeasureMarker`/`measureMarkerAHit`/
`measureMarkerBHit` in `src/main.js`), not routed through
OrbitControls/TransformControls at all — a measurement has no undo/
persistence story, so it doesn't need either's machinery, just
`controls.enabled = false` for the drag's duration so a one-finger drag
on an endpoint doesn't simultaneously rotate/free-look the camera
underneath it (see "Frontend-only camera navigation" below for what a
plain one-finger drag does instead). Each visible marker has a larger,
invisible companion sphere (`measureMarkerAHit`/`...BHit`, radius 0.18m
vs. the visible marker's own 0.06m) that's actually raycast against for
grabbing it back — a precise hit against the small visible sphere alone
would be an unreasonably exacting target on a touchscreen. The
`pointerdown` hit-test is registered on `window` with `capture: true`
rather than directly on the canvas, for the same event-ordering reason
"Frontend-only camera navigation" below registers its own wheel listener
that way: OrbitControls attaches its own `pointerdown` handler to the
canvas in its constructor, long before this code runs, and two listeners
on the same element always fire in *registration* order regardless of
capture/bubble — only a capture-phase listener on an ancestor is
guaranteed to see (and act on) the event first. A native `click` can still
fire after a small enough drag despite this; `measureMarkerWasDragged`
suppresses that click from also being read as "place a new point here."

A tap anywhere else once a measurement is already complete (both A and B
placed) starts an entirely fresh one, exactly as before — this only
applies once dragging isn't the more natural way to adjust it.

The result — straight-line distance, plus its X/Y/Z breakdown — is shown in
`#product-info` (which Measure repurposes for its own status text the whole
time it's on; `updateSelectionUI`'s own `measureMode` branch leaves that
element alone while hiding the gizmo row, the same "selection persists,
UI just steps out of the way" hand-off Multi-Select already gets), each
length formatted through the existing `formatLength`/Units machinery so it
reads in whichever of meters or feet Settings has picked, and recomputed
identically (`updateMeasureResultText`) whether the second point was just
placed or an existing endpoint was just dragged. The X/Y/Z breakdown
matters because two taps meant to land exactly one above the other rarely
do in practice — reading Δz directly means a slightly off-center second
tap still measures the intended height correctly instead of forcing a
re-measurement.

### Testing note

No automated coverage — this is exactly the kind of real-camera/real-touch-
gesture behavior nothing else time- or camera-driven in this app has
automated coverage for either (see "Frontend-only alignment assist" above).
Verified manually: a temporary `window.__debugVerify` hook exposing
`measurePointA`/`measurePointB`/the marker meshes/`controls` (removed
before committing, confirmed via `grep`) confirmed dragging endpoint A
moves only that point (B stays put), `controls.enabled` is `false` for the
duration of the drag and back to `true` immediately after release, the
result text reflects the new position once the drag ends, and both
endpoints survive the drag's trailing `click` (i.e. it doesn't get read as
"place a new point" and clear the measurement).

## Frontend-only settings (Units)

`src/settings.js` holds a small `localStorage`-backed preference —
`higglehaven.units`, `'m'` or `'ft'` — set from the Settings modal's General
tab (four tabs exist: General/Shop/Build/Sell; only General has a control
today, the rest are placeholders reserved for future settings). This is
purely a display/input convenience: every length is still measured,
persisted, and sent to the API in meters exactly as described above. Ft
mode only changes how a length is *formatted* for reading (the Trim
field's unit suffix, the Seller modal's dimension/minimum-length text) and
how a typed number is *parsed* back into meters before it reaches any
`crop`/`metadata.extensible` value sent to the server.

## Custom model uploads (not covered above)

Two additional routes exist outside the CRUD endpoints described above, added
to support builder-uploaded photogrammetry/scanned models rather than only
the built-in catalog:

- `POST /api/models` — accepts a `.glb` file as `multipart/form-data` (field
  name `file`), validates it (glTF 2.0 header, declared file length, chunk
  boundaries, required JSON metadata chunk, a 20MB hard size cap,
  and a live application-level 8GB total-R2-storage cap), stores it in the
  `MODELS` R2 bucket under a SHA-256 content-addressed key, and returns
  `{ modelUrl, sourceName, sizeBytes, deduplicated }`. Re-uploading identical
  validated bytes returns the existing immutable object with `200` and
  `deduplicated: true`, without consuming storage headroom or repeating the
  full storage scan. New objects return `201`. Unauthenticated on purpose
  (an upload alone doesn't register a catalog product — see below — so
  there's no owner to spoof), but rate-limited per client IP (see "Rate
  limiting" above) since each call can still burn shared storage headroom.
  The returned `modelUrl` is then used
  as-is in a normal `POST /api/catalog` call to register the product — upload
  and catalog registration are two independent steps. Catalog creates and
  updates validate `/uploads/` model URLs against live R2 metadata and return
  `400` rather than storing a reference to a missing upload. Built-in `/models/`
  URLs and external catalog URLs are unaffected by this upload-specific check.
- `GET /api/models` — **admin-only** (`requireAdmin`, `403` for a logged-in
  non-admin, `401` for no session — same bar as the world/land-candidate
  tooling above). Not a builder/seller-facing endpoint, so it has no business
  enumerating every uploaded (including unregistered, in-progress) model to
  an ordinary session. Lists uploaded R2 models without returning their
  bodies. Results contain `modelUrl`, `sizeBytes`, `etag`, `uploadedAt`,
  `deletable`, and sorted `referencedByTemplateIds`. Reference metadata is
  resolved with one bounded D1 query for the R2 page, allowing cleanup
  tooling to distinguish safe deletions without probing each object.
  Listings use a `limit` from 1 to 100, and return the R2-backed opaque
  `nextCursor` for the next page. This is a dev inventory for finding
  uploads that can be reclaimed.
- `GET /api/models/storage` — **admin-only**, same bar as `GET /api/models`
  above. Scans the paginated R2 metadata inventory and reports `usedBytes`,
  `objectCount`, the application-level `capBytes`, `availableBytes`, and
  `utilizationRatio`. This exposes the same live storage accounting enforced
  before uploads, without downloading object bodies.
- `POST /api/models/cleanup` — **admin-only** (`requireAdmin`, `403` for a
  logged-in non-admin, `401` for no session — same bar as the world/land-
  candidate tooling above). Deletes up to `maxDeletes` unreferenced uploads
  (`1`–`100`, default `100`) after scanning bounded R2 pages and resolving each
  page's catalog references in one D1 query. The response reports
  `targetModelUrls`, `targetCount`, `reclaimedBytes`, and whether the scan
  reached the end of the bucket. Objects are collected before the bulk delete
  so deleting them cannot invalidate an in-progress R2 cursor. Immediately
  before that delete (not only during the earlier per-page scan), the full
  target set is re-checked against `catalog_templates` in one more query, and
  any object referenced by a template created in the meantime is dropped
  from the response and left alone — narrowing (not eliminating; R2 and D1
  aren't a single transaction) the window for a template creation racing
  this cleanup. Set boolean `dryRun` to `true` to return the same proposed
  targets and reclaimed-byte total without deleting anything (including that
  same final re-check); the response echoes `dryRun`.
- `GET /uploads/:key` — serves a previously-uploaded model's bytes back out of
  R2 (not the `ASSETS` static bundle, since only the built-in models ship as
  build assets). Responses are cached indefinitely (`immutable`) since upload
  keys are never reused. `HEAD` is also supported for metadata-only checks, and
  matching `If-None-Match` requests receive `304 Not Modified`. Other methods
  receive `405 Method Not Allowed`.
- `DELETE /uploads/:key` — **admin-only**, same as `POST /api/models/cleanup`
  above (checked before the referenced-model check below, so an unreferenced
  upload still isn't deletable by its own uploader). Removes an unreferenced
  upload from R2 so dev model iterations do not permanently consume the
  application storage allowance. Uploads still referenced by a catalog
  template return `409`; delete the catalog template first. Missing uploads
  return `404`. The referenced-model check runs as the very last step before
  the actual R2 delete (after confirming the object exists), narrowing the
  window against a template referencing this model being created in
  between. `GET`/`HEAD` above stay unauthenticated — serving an
  immutable, content-addressed model back out is not a mutation.

Both require an R2 binding named `MODELS` (see `wrangler.jsonc`).

### Placed-instance tilt (`rotationX` / `rotationY`)

`placed_instances` (and its snapshot mirror `version_instances`, added by the
landlet-versions migration) carry `rotationX`/`rotationY` alongside
`rotationZ`, persisted as `rotation_x_rad`/`rotation_y_rad` columns. These
exist because real scanned models aren't guaranteed to come in level/upright
(the frontend's rotate gizmo allows tilting on all three axes to correct
this), unlike the built-in placeholder catalog which is always axis-aligned.
Collision math (client-side) deliberately still only reads `rotationZ` — see
`src/main.js`'s `footprintCorners` — so a tilted item's on-ground footprint is
approximated as its untilted bounding rectangle; this is an accepted
simplification, not an oversight, since 3D OBB collision isn't implemented.

## Product pricing

`catalog_templates.price_cents` (`priceCents` in the API) existed in the
schema and worker validation from the very start of this project, but
before this section was written, nothing in the frontend ever set it or
displayed it — a seller had no way to give a product a price through the
UI at all, and a shopper had no way to see one. This closes that gap on
both sides, using the field exactly as it already existed server-side (no
migration needed).

### Seller-side: setting a price

The upload wizard's first step (name + `.glb` file) gains an optional
"Price" field, right after Name. A blank field means `priceCents: null`
("no price set"), not `0` — mirroring `priceCents`' own null-means-unset
convention everywhere else in this file. Entered as dollars, converted to
cents (`Math.round(dollars * 100)`) before the `POST /api/catalog` call
that actually creates the template.

For a product that's already been created (uploaded before this feature
existed, or a seller who skipped the price at upload time), each row in
the Seller modal's own list (`#seller-list`, see "Sellers" above) shows its
current price right under its dimensions — `formatPriceCents`, or "Not
priced" when `null` — and gains an "Edit Price" collapsed panel (same
collapsed-panel-with-a-Save-step idiom as that row's existing "Edit Size"
panel): one numeric input, pre-filled from the current price (blank if
unset), and a Save button that `PATCH`es `{ priceCents }` — `null` again if
the field is cleared back to blank, not `0`.

### Shop-side: seeing a price

`#shop-product-info`, a non-interactive text line, shows a tapped placed
instance's own product name and price (`"<name> — <price>"`, or just
`"<name>"` when unpriced). Originally proximity-tracked the same way
Product Reviews' own hint is (nearest in `SIGN_INTERACT_RADIUS_M`), but
that read as noisy — a name/price popup appearing the instant a shopper
walked near anything, whether or not they cared. Now driven by a plain
raycast click/tap handler against every loaded `shopReviews` mesh (the
same "walk up to whichever registered root mesh is this hit's ancestor"
pattern Build mode's own click handler uses against `productMeshes`, see
`findTappedShopProduct`): tapping a product shows its info, tapping
anything else (ground, sky, empty space) dismisses it. `#shop-review-hint`/
`#shop-buy-hint` stay proximity-driven — those are prompts to act on
whatever's nearby, not a display, so showing them on approach still reads
as "you can do something here" rather than clutter. It sits one slot
higher than `#shop-review-hint` (`bottom: 330px` vs. `280px`) so both can
show together without colliding.

### Testing note

`e2e/product-pricing.test.mjs` covers the seller-side contract end to end
through the real UI: setting a price during upload, the row's own display
of it, editing an unpriced product's price afterward via "Edit Price," and
clearing a price back to blank (verified as `null` server-side, not `0`,
at every step). `#shop-product-info`'s tap-to-show/tap-away-to-dismiss
display isn't covered there for the same reason real Shop-mode camera
movement never is in this suite (see "Product reviews" above's own testing
note) — verified manually instead, using temporary `window.__debugSetCameraPos`/
`window.__debugSetShopYawPitch` hooks (removed before committing, confirmed
via `grep`) to aim the camera at a placed instance and simulate a tap at
its on-screen position, confirming the info appears only after that tap
and clears on a follow-up tap at empty sky.

## Prohibited categories and digital goods

docs/SPEC.md §4: "Prohibited categories (baseline, eBay/Etsy-referenced):
weapons capable of serious harm, controlled substances/paraphernalia,
adult content, counterfeit/unauthorized trademarked goods, live animals,"
and "Digital goods — narrow, conditional exception (supersedes earlier
'excluded by default') ... permitted if the listing includes (a) a
representative 3D model and (b) a clear higglehaven-controlled disclaimer
of what's actually delivered." Neither of these existed in any form before
this section — catalog template creation had no content-policy check at
all, and there was no way to mark or disclose a digital good.

### Prohibited categories

A plain phrase blocklist (`PROHIBITED_CONTENT_PHRASES` in `worker/index.js`)
checked against a template's `name`/`category`/`subcategory` (joined,
lowercased, substring match) on every create, update, and batch
create/update — called from inside `validateTemplate` itself, so every
write path gets it automatically rather than needing a check at each route.
A match returns `400` naming which phrase matched:

```json
{ "error": "This listing appears to violate higglehaven's prohibited-categories policy (matched \"assault rifle\")" }
```

This is **not real content moderation** — there is no image or AI review
anywhere in this dev-mode backend, only a baseline keyword check, matching
the spec's own "baseline, eBay/Etsy-referenced" framing rather than a
claim of rigorous enforcement. The phrase list is deliberately multi-word
("assault rifle," not "gun" alone) to keep the false-positive rate low
against a catalog that's mostly ordinary placeholder/furniture names —
"Oak Chair" or "Toy Gun" (fictional example) style names are not, on their
own, going to match a phrase like "handgun" or "firearm." Existing seed
data (the built-in placeholder catalog, inserted directly via migration
SQL) is entirely unaffected — this only runs at the application layer, on
writes made through the API.

### Digital goods

There is no separate `isDigitalGood` boolean — a catalog template *is* a
digital good exactly when `metadata.digitalGoodDisclaimer` is set, the
same single-flag-in-metadata simplicity flooring (`migrations/0035`) and
extensibility already use. The value is one of a small, platform-controlled
set of keys — never freeform seller text, matching the spec's own "clear
**higglehaven-controlled** disclaimer" (not the seller's own wording):

| Key | Disclosed as |
|---|---|
| `gift-card` | "This is a digital gift card to a real business, delivered as a code — not a physical item." |
| `art-file` | "This is a digital art or print file, delivered as a download — not a physical item." |
| `software-tool` | "This is a higglehaven-ecosystem software tool, delivered as a download or activation — not a physical item." |

`assertValidDigitalGoodDisclaimer` (also called from inside `validateTemplate`)
rejects any other value with `400`. It also enforces requirement (a) from
the spec quote above — "a representative 3D model" — by requiring a
non-null `modelUrl` whenever `metadata.digitalGoodDisclaimer` is set:
`modelUrl` is optional for an *ordinary* template (a plain colored box is a
normal, supported fallback look for a regular product — see "Catalog
templates" above), so without this check a disclaimer alone was silently
sufficient to list a digital good with no visual representation at all,
satisfying only half of the spec's own two-part condition. Applies on
create, update, and the batch-import path alike, since all three route
through `validateTemplate`.

Since this dev-mode app has no checkout or delivery mechanism of any kind
(real or digital), "digital goods are excluded by default" has nothing
concrete to be excepted *from* here — the two parts of this spec item with
a real, enforceable rule are exactly the model requirement and the
mandatory controlled disclaimer, both implemented above.

### Frontend wiring

The upload wizard's first step gains a "This is a digital good" checkbox
and a disclaimer `<select>` (revealed only once checked) right after Price.
Submitting builds `metadata.digitalGoodDisclaimer` from the selected option
before the `POST /api/catalog` call. Each Seller-modal row shows "Digital
good: `<disclosure text>`" or "Not a digital good" right under its price,
with its own "Edit Digital Good" collapsed panel (checkbox + select + Save,
same collapsed-panel-with-a-Save-step idiom as that row's "Edit Price" and
"Edit Size" panels, deliberately kept as fully separate classes throughout
— `.seller-digital-good-*` — despite being visually identical, the same
"don't share a class across genuinely different rows/panels" reasoning
Extensibility vs. Edit Size already established) for setting, changing, or
clearing it afterward. Unchecking and saving deletes the metadata key
entirely rather than setting it `false` or `null` — the same clear-to-
absent convention flooring's own toggle uses.

`#shop-product-info` (see "Product pricing" above) appends the disclosure
text in parentheses when the nearest instance is a digital good — a
shopper standing next to one sees `"<name> — <price> (<disclosure>)"`
rather than assuming every placed item is a physical one they could pick
up.

A prohibited-content rejection surfaces through the exact same upload-flow
error path every other validation failure already does (`setUploadStatus`
in the wizard's own catch block) — no special-cased UI for it.

### Testing note

`worker/commerce.test.js`'s "Prohibited categories and digital goods" describe
block owns the full validation matrix: name/category/subcategory phrase
matching, a same-session ordinary-furniture-name control case (proving the
blocklist doesn't false-positive on normal products), rejection via both
`PATCH` (renaming an existing listing into violation) and batch create, an
invalid `digitalGoodDisclaimer` key, a valid one round-tripping through
`GET`, and clearing one via a full `metadata` replace. `e2e/digital-
goods.test.mjs` covers the digital-good checkbox/disclaimer picker and the
Seller modal's "Edit Digital Good" panel through the real UI (set at
upload, edit afterward, clear back to "not a digital good"). The
prohibited-categories rejection is deliberately **not** exercised through
the e2e suite even though the upload wizard is a real, reachable path to
it — triggering that real rejected `fetch` from inside the page logs a
"Failed to load resource" console error (plus this app's own
`console.error` in the upload catch block) that would trip the suite's own
`errors.length === 0` check, the same reasoning already documented for
community signs/calendar's own analogous `400` cases. `#shop-product-info`'s
digital-good text was verified manually alongside its price display (see
"Product pricing" above's own testing note), using the same temporary
debug-hook technique.

### Shipping

docs/SPEC.md §5: "Dimmed-filter approach: shoppers toggle a filter,
non-shippable items are dimmed with a label ('ships to United States
only'), not hidden." "Seller sets shipping cost by destination zone — not
a fixed 'non-domestic party pays' rule." This is the seller-set data layer
only — real per-destination-zone shipping *cost*, live 3D-mesh dimming, and
a shopper-facing filter toggle are all deliberately not built here yet (see
"Deferred" below).

There is no separate `shipsInternationally` boolean — a catalog template
ships internationally by default (the spec's own permissive default) and
is restricted to domestic-only exactly when `metadata.domesticOnly` is
`true`, the same single-flag-in-metadata simplicity `noReturns` (see
"Refunds" above) already uses. `assertValidDomesticOnly` (also called from
inside `validateTemplate`) rejects any non-boolean value with `400`.

A seller opts a product into domestic-only shipping via its own row's
"Edit Shipping" panel (checkbox + Save, same collapsed-panel idiom as that
row's "Edit Returns Policy" panel) — `.seller-domestic-only-toggle`/
`.seller-domestic-only-panel` in `src/main.js`. Unchecking and saving
deletes the metadata key entirely rather than setting it `false`, the same
clear-to-absent convention `noReturns` and flooring's own toggle use.
`#shop-product-info` (see "Product pricing" above) appends "(ships to
United States only)" in parentheses when the nearest instance is
domestic-only-flagged — the same tap-to-inspect disclosure treatment as
the digital-goods disclaimer above.

**Deferred, not built here:** this dev-mode backend has no real shopper
address/geo data anywhere (no checkout, no payment integration — see
`AGENTS.md`'s "Real payments ... are still not built"), so there is
nothing real for a live "does this ship to me" filter to filter against.
Per-destination-zone shipping *cost* is a checkout-time concern that
depends on that same missing real-payments integration. And the spec's
"dimmed" visual treatment (fading a placed item's 3D mesh) has no
precedent anywhere in this codebase yet — every other seller-set
disclosure (`noReturns`, `digitalGoodDisclaimer`) surfaces as tap-to-inspect
text only, not a mesh-level effect. Shipping the underlying seller-set data
first, with live filtering/dimming as a later enhancement, follows the same
"honest simplest form first" precedent already used elsewhere in this
codebase (see "Friend requests" above's own graphical-map deferral).

#### Testing note

`worker/commerce.test.js`'s "Shipping" describe block covers the non-boolean
rejection, a valid value round-tripping through `GET`, the absent-defaults-
to-international case, and clearing one via a full `metadata` replace —
the same matrix "Prohibited categories and digital goods" above covers for
`digitalGoodDisclaimer`. No e2e coverage: the Seller-modal panel is
structurally identical to the already-e2e-covered "Edit Returns Policy"
panel (same collapsed-panel-with-a-Save-step idiom, same
`updateCatalogTemplate` call), so a second full browser-driven test of the
same interaction pattern would be redundant rather than additive.

## Automated tests

Run the Worker integration suite with:

```sh
npm test
```

The suite runs the Worker in Cloudflare's local Workers runtime, applies all D1
migrations to isolated test storage, and exercises the complete backend
lifecycle. Focused unit tests also cover world-circle geometry independently of
D1. Test storage does not modify the local development D1 state.

## Known gaps / future backend work

- Extend procedural generation beyond the current bounded annular-ring
  primitive with macro-geography-aware shapes.
- Real payment processing, multiplayer presence, and content moderation
  are still dev-only/simulated as of this writing (see this doc's own
  "Scope and assumptions" above) — real account auth and a real
  seller/builder identity model, by contrast, are already built and live
  (migrations 0053-0056; see "Authentication," "Authorization model," and
  "Builders" above). Unlike the annular-ring-generation gap above, this
  isn't a small follow-up: see AGENTS.md's "Proposing big feature work"
  for how this project breaks work this size into a claimable backlog.
