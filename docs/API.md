# higglehaven backend API

This document describes the current dev-only Cloudflare Worker + D1 API contract.
It is meant to keep backend and frontend work aligned while higglehaven moves
from browser `localStorage` placeholders toward persistent data.

## Scope and assumptions

- This API is intentionally **dev-only**: no auth, no payments, no multiplayer,
  no moderation, and no production seller/builder identity model yet.
- Internal names use plain `a` (`land`, `landlet`, `daller`) even when display
  copy may eventually use accented customer-facing strings.
- Coordinates and dimensions are decimal meters. Placed object positions use the
  current client convention: `x`/`y` are ground-plane coordinates and `z` is
  vertical.
- The Worker serves JSON under `/api/*` and falls back to Cloudflare static
  assets for all non-API routes.
- The default development landlet is `starter-landlet` until real land selection
  and builder ownership exist.

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
{ "email": "ada@example.com", "password": "correct horse battery staple", "username": "Ada" }
```

`email` is normalized (trimmed, lowercased) and validated against a
deliberately permissive pattern — "does this look roughly like an email,"
not a full RFC-5322 parser, since the only real validation of an address
is actually receiving mail at it, which email verification already does.
`409` if that email is already registered (revealing a duplicate email
here is common, accepted practice — unlike the password-reset-request
endpoint below, which deliberately stays silent about whether an account
exists). `password` must be 8–200 characters. `username` is required (how
users identify each other, not a cosmetic label), at most 40 characters,
and must be unique — `409` if it's already taken, case-insensitively
("Ada" and "ada" are the same username).

Creates the account, logs it in immediately (sets the `hh_session`
cookie — no separate login step needed right after signup), and kicks off
email verification:

```json
{
  "user": { "userId": "user-...", "email": "ada@example.com", "username": "Ada", "emailVerified": false, "createdAt": "...", "updatedAt": "..." },
  "verificationEmailSent": true
}
```

`verificationEmailSent` is `false` (with a `devVerifyUrl` field added
instead) whenever the dev-mode fallback above kicks in.

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
signup it stays deliberately generic. A real account gets a reset email
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

`worker/index.test.js`'s "Authentication" describe block owns the full
contract: signup/login/logout, session-cookie behavior (a fresh session
per login, logging out one device leaving others intact), duplicate-email
and malformed-input rejection, case-insensitive email matching, identical
wrong-password/unknown-email responses, the five-attempt lockout, the full
email-verification lifecycle (valid/invalid/reused token), resending
verification (requires a session, a no-op once already verified, doesn't
invalidate the original token), and the full password-reset lifecycle
(valid/invalid/reused token, old sessions invalidated, old password
rejected afterward). All of it runs against the
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
`RESEND_API_KEY` already use). `403` if `secret` doesn't match it exactly.
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

### `GET /api/builders/me`

Requires a session (`401` without one, the same `requireCurrentUser` gate
"Authentication" above uses). Returns the calling account's own builder
profile, auto-provisioning one if somehow missing (a defensive fallback —
signup already creates it, so this should never actually need to):

```json
{ "builder": { "builderId": "builder-...", "label": "Ada", "isPioneer": false, "pioneerRank": null, "dallersBalanceCents": 0, "landCapM2": 1000, "createdAt": "...", "updatedAt": "..." } }
```

Idempotent — the same profile every call, never a new one.

### Builder object

```json
{
  "builderId": "builder-3c9e9c50-2b10-4ba9-b62c-2abfd48b64f7",
  "label": "Ada",
  "isPioneer": false,
  "pioneerRank": null,
  "dallersBalanceCents": 0,
  "createdAt": "2026-08-16T00:00:00.000Z",
  "updatedAt": "2026-08-16T00:00:00.000Z"
}
```

`isPioneer`/`pioneerRank` are docs/SPEC.md §3's founding/pioneer
recognition — see "Founding/pioneer recognition" below. `dallersBalanceCents`
is docs/SPEC.md §5's land-acquisition-auction proceeds ledger — see "Land
acquisition auctions" below for what can (and can't yet) change it.

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

`label` is required. Returns `409` if `builderId` is already taken.

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
`PIONEER_COHORT_SIZE` — is covered by `worker/index.test.js` instead,
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

`label` is required. Returns `409` if a caller-supplied `sellerId` is
already taken.

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
  "metadata": {
    "placeholder": true
  },
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

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
seller — `403` if any one of them isn't yours.

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
must be a non-negative integer.

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
`.height` map onto the scene's local axes. A template can declare any subset
of the three at once — e.g. a wall resizable in thickness, length, and
height all independently — and the frontend's Trim gizmo shows a separate
handle (and a separate numeric field) for every axis a selected item's
template declares, all active simultaneously; each still crops exactly one
axis per drag (see "Dragging the Trim gizmo" below for the multi-handle
gizmo itself, and "Managing extensibility" for how a seller turns axes on).
(Trim is the per-axis shortening tool described here — not to be confused
with the frontend's separate Resize tool, a real uniform scale unrelated to
extensibility; see "Frontend-only Resize" below.)

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
  adjusts a freshly-measured size before creating the product — see
  "Frontend-only Resize" below for why declared dimensions must always
  exactly match the model's own rendered size), and re-uploaded before the
  template is patched with both the new `dimensions` and the new
  `modelUrl` in one request.
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
    "greenbeltRatio": 0
  },
  "metadata": {},
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

### `GET /api/world`

Fetches the singleton world settings object and aggregate landlet status counts.

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
one.

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
`status: "greenbelt"`, must have no owner, and the builder must not already own
a claimed landlet. This preserves the MVP rule that each builder can claim one
free starter landlet even when two requests arrive close together. A partial
unique D1 index also enforces this ownership rule for writes made through other
dev tooling.

Returns the newly claimed landlet. Errors are:

- `401` when nobody is logged in.
- `404` when the landlet does not exist.
- `409` when the landlet is unavailable or the builder already owns a claimed
  landlet.

### `POST /api/landlets/:landletId/generation-complete`

Records that asynchronous generation work has completed. The endpoint is
idempotent: retries return the existing landlet once `generatedAt` is set.

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
resolution.

### `DELETE /api/landlets/:landletId`

Once a landlet has an owner, this always fails with `409` — this raw delete
has no cascade cleanup for placed instances/version history (unlike
`DELETE /api/builders/:builderId`'s careful release path), so even the true
owner using it would corrupt data; release land via deleting the builder or
losing an auction instead. Deletes an unowned landlet outright, with no
session required (see the note on `PUT`/`PATCH` above for why).

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
`Version N`.

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
deletions in the mutable draft do not alter this array.

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

`scale` is a real uniform scale factor, unrelated to `crop` and available on
any instance regardless of whether its template is extensible — see
"Frontend-only Resize" for why this exists and where it's applied. `1` (the
default) means "rendered at the template's own declared size." Validated only
loosely server-side (must be a positive finite number) — the frontend's own
Resize control applies the real UX-facing `[0.001, 1000]` bound.

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

Builder-facing notifications — currently produced by exactly one thing: a
seller changing a placed template's real-world dimensions (see "Editing a
product's size" under "Managing extensibility — the Seller modal" above).
The table is deliberately generic (a plain `message` string, not a typed
"dimension change" event) so future notification kinds don't need their own
table or endpoints. There's no pagination cursor — one builder's outstanding
count is expected to stay small — and no `DELETE`, since a read notification
is still useful history ("wait, when did that change?").

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
first, capped at 100. `builderId` is an optional query parameter — omitted,
it defaults to the session's own builder; if present, it must equal the
session's own builder ID (`403` otherwise — this was a spoofable
"whose notifications" field before session-based authorization, see
"Authorization model" above). `unreadOnly=true` narrows the list to
`readAt IS NULL` server-side — the same call backs both the unread badge
count (`unreadOnly=true`) and the full history list (omitted) in the
frontend's Notices panel.

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
`pending` friendship.

### `PATCH /api/friendships/:friendshipId`

Requires a session logged in as the friendship's `recipientBuilderId`
(`403` otherwise — only the recipient can accept a request; the requester
accepting their own would skip the other side's consent entirely). Accepts
a request: `{ "status": "accepted" }` is the only valid body — `400` on
anything else. `404` if the friendship doesn't exist. There is no
"decline" status; declining a pending request or removing an accepted
friendship are both just `DELETE`.

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

`worker/index.test.js`'s "Friendships" describe block owns the full
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

Lists every post on that sign, oldest first, capped at 200. `404` if the
instance doesn't exist. Returns `{ "posts": [...] }` where each post is:

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
characters. `400` if the target instance isn't currently flagged
`isCommunitySign` — a post can't outlive or predate the flag that makes it
visible at all. `404` if the instance doesn't exist.

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
non-sign" 400 — that last one in `worker/index.test.js` instead, not the
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
[as community signs], builder-authored (event postings, creative-tool
support like a scheduled confetti-cannon trigger)." Structurally a twin of
"Community signs" just above — same per-instance opt-in flag
(`isCommunityCalendar`, `migrations/0042_community_calendar.sql`), same
nested-under-the-instance events collection (`calendar_events`, a separate
table from `sign_posts`), same toggle-then-manage Build-mode button, same
Shop-mode fade-and-post-a-note flow. Deliberately kept as its own
independent flag/table rather than merged into one generic "community
board" concept — see migrations/0042's own comment: calendar events are
the more likely of the two to grow real fielded data later (an actual
date/time, RSVPs), at which point a shared abstraction would need
reworking anyway, so duplicating a small, well-understood pattern now is
cheaper than guessing at that shared shape today. The "creative-tool
support like a scheduled confetti-cannon trigger" half of the spec
sentence is explicitly out of scope here — a stated example of where the
feature *could* grow, not a requirement of it.

An instance can be a sign and a calendar at once (independent flags,
independently toggled and moderated) — nothing in the spec says a builder
must choose one or the other for a given placed object.

### `GET /api/instances/:instanceId/events`, `POST .../events`, `DELETE .../events/:eventId`

Identical contract to the sign posts endpoints above, with `event`/`events`
in place of `post`/`posts` and `eventId` in place of `postId`:
`{ eventId, instanceId, authorLabel, text, createdAt }`, `text` capped at
280 characters, `POST` rejected with `400` unless the target instance is
currently flagged `isCommunityCalendar`, deletion cascades when the
instance itself is deleted.

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

docs/SPEC.md §5's "Review incentives: small dáller bonus for genuine,
substantive reviews, capped per account/period." The dáller-bonus half is
explicitly out of scope here, same reasoning "Community calendar" gave for
carving out its own out-of-scope half: there is no shopper account/balance
concept anywhere in this app to credit a bonus to — only builders ever hold
dállers, and only for their own commission earnings. This covers the
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
identity system carries everywhere else it's used. Any purchase counts,
refunded or not, and one purchase can back any number of reviews (there's
no pairing/consumption between a specific purchase and a specific review) —
this is a simple "did you ever buy it" gate, not a stricter one-review-
per-purchase policy.

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
purchase-gating paragraph above) — `400` without one.

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
would misleadingly read as "rated, and rated at the bottom"). Deleting a
catalog template cascades its reviews.

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

`worker/index.test.js`'s "Product reviews" describe block owns the full
contract against freshly-created catalog templates (empty list, validation,
rating bounds, optional text, averaged summary, moderation delete,
independence between two different templates' review lists, cascade delete
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
{ "authorLabel": "...", "text": "...", "scheduledAt": "2026-08-26T20:00:00.000Z" }
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
which `worker/index.test.js` can do directly via `env.DB` (D1's own test
binding) but `e2e/community-calendar.test.mjs` cannot — there is no public
API for rewriting an event's `scheduled_at`, by design. The split this
produces mirrors the auction lazy-resolution tests: `worker/index.test.js`'s
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
plus a `builders.dallers_balance_cents` ledger.

### Deliberate scope boundary

Two things the spec ties to auctions are **not** implemented, because
neither has anywhere to attach to in this dev-mode backend yet:

- **Land cap** (a per-builder max-total-area limit that grows only via
  demonstrated commission earnings) doesn't exist anywhere in this
  codebase — there's no real commerce/checkout pipeline to earn
  commission from, so there's no earnings figure to gate cap growth on.
  Starting or winning an auction never checks or changes anything cap-
  related.
- **Balance-gated bidding.** Every builder starts at `dallersBalanceCents:
  0` with no way to earn any except winning an auction as the *seller* —
  requiring a sufficient balance to *bid* would make the feature
  untestable today (nobody could ever place a first bid). Bids are
  validated only against the minimum-increment rule below, never against
  the bidder's balance. `dallersBalanceCents` is still a real, persisted
  ledger (not a UI-only number) so a winning seller's proceeds land
  somewhere meaningful, ready for balance-gating to be added later without
  a schema change.
- **Inactivity-triggered auto-listing.** Every auction reachable today is
  builder-initiated (`POST /api/landlets/:id/auction`) — there's no
  inactivity-detection job in this dev-mode backend to trigger one
  automatically, so the spec's "default 24-hour duration for inactivity-
  triggered listings" just applies as the uniform default for every
  auction, voluntary or not.
- **No scheduled resolution job.** There's no Cloudflare Cron Trigger
  wired up. Resolution is purely lazy: `GET /api/auctions` sweeps and
  resolves every active-but-expired auction before returning results
  (`resolveDueAuctions` in `worker/index.js`), and any single-auction read
  or bid attempt resolves that one auction first if it's due
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
full course.

### `POST /api/landlets/:landletId/auction`

Requires a session (`401` without one). Starts a voluntary auction as the
calling account's own builder — `builderId` is derived from the session,
never a client-supplied field. Body: `{ "startingBidCents"?,
"durationHours"? }`. `startingBidCents` defaults to `0`; `durationHours`
defaults to `24` (docs/SPEC.md §5's own default), capped at `8760` (one
year) as a sanity bound against a malformed request, not a spec
requirement. `400` unless the calling builder is the landlet's current
owner and the landlet is `claimed`. `409` if that landlet already has an
active auction — one at a time per landlet.

Per docs/SPEC.md §5, what `startingBidCents` is decides the unsold
outcome, read directly off the stored value at resolution time rather
than a separate flag: **"$0 = explicit willingness to relinquish for free
if no bids arrive. ≥$0.01 = wants to retain if unsold."**

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
client-supplied field. Body: `{ "amountCents" }`. Resolves the
auction first if it's due, then `409` if it's not (or is no longer)
`active`. `400` if the bidder is the seller, or if `amountCents` is below
the minimum acceptable amount:

- No bids yet: must be `>= startingBidCents` (so a `$0`-starting auction
  accepts a `$0` first bid — a real bid, not "no bid," and per the spec's
  own "any bid guarantees eventual transfer," it wins the land for free
  rather than releasing it to greenbelt).
- At least one bid already: must be strictly greater than the current
  highest.

### `POST /api/auctions/:auctionId/resolve`

Resolves this auction if it's currently due (`ends_at` has passed);
otherwise `409`. Calling it again on an already-ended auction is a
harmless no-op — `200` with the same (unchanged) already-ended state, not
an error, matching ordinary idempotent-action expectations rather than
penalizing a redundant call.

### Resolution

`resolveAuction` in `worker/index.js` — the same logic whether triggered
lazily or via the explicit endpoint:

- **A winning bid exists:** ownership transfers to the highest bidder
  (`landlets.owner_builder_id`), the landlet's build is cleared (placed
  instances, versions, `active_version_id`) exactly like `DELETE
  /api/builders/:id` already clears a reclaimed landlet's build — a new
  owner gets the land, not the previous owner's stuff on it — and the
  seller's `dallersBalanceCents` is credited the winning bid amount
  (docs/SPEC.md §5: "Dállers raised in a successful auction go to the
  previously-inactive builder's account"). `auctions.status` becomes
  `ended`, `winningBidId` records which bid won.
- **No bids, `startingBidCents` was `0`:** the landlet releases to
  `greenbelt` (owner cleared, build cleared, `claimable_at` refreshed) —
  the seller's own explicit "relinquish for free" choice.
- **No bids, `startingBidCents` was `> 0`:** the landlet stays exactly as
  it was — the seller wanted to retain it if unsold, so nothing about
  ownership or the build changes, only `auctions.status` becomes `ended`.

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

Covered by `worker/index.test.js` (a notification-content assertion added
to each existing resolution-outcome test, plus a dedicated case for the
new-bid/outbid pair) and `e2e/land-auctions.test.mjs` (the seller's real
notification, read through the actual Notifications modal after the
bidder's bid — confirms the whole path works end to end, not just that
a row landed in the table).

### Frontend wiring

Settings' own "Auctions" tab (`renderAuctionsSettingsSection` in
`src/main.js`) — its own tab rather than folded into the Build tab
alongside Publish/Version History, since bidding on someone *else's*
landlet isn't a "your own Build session" action the way publishing is;
this tab is reachable regardless of mode. Two independent sections:

- **Sell Your Land** — if the active identity currently owns a claimed
  landlet with no active auction on it, a small form (starting bid in
  dollars, duration in hours) and a Start Auction button. Once that
  landlet has an active auction, this collapses to a one-line summary
  instead of offering a second start form.
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

`worker/index.test.js`'s own `Auctions` describe block covers the full
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
Grows via a formula converting trailing-30-day dáller earnings per
1,000 m² owned into cap increases. Ratcheting: once increased, never
decreases." Also: "Two independent constraints (do not conflate): 1. Land
cap — how much total area, grows only via earnings formula. 2. Dáller
balance — which specific already-claimed lands can be acquired via auction
(§5)." This section (`migrations/0050_land_cap.sql`) had no implementation
at all before it — `builders.land_cap_m2` (defaults to `1000`, matching the
free starter lándlet exactly) and a per-event `daller_earnings_events`
ledger (needed for a genuine trailing-30-day *window*, which the existing
lifetime `dallers_balance_cents` total, migrations/0045, can't answer on
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
- docs/SPEC.md §5 makes clear the *intended primary* dáller-earning path is
  commerce commissions — "Dállers credit instantly to builders on sale
  completion" (of a *product*, not of land). But this dev-mode backend has
  no real checkout/commerce system at all (out of scope, same as real
  payments generally elsewhere in this project). Auction sale proceeds are
  the *only* dáller source actually implemented.
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
trailingEarningsDollars = SUM(daller_earnings_events.amount_cents WHERE created_at >= now - 30 days) / 100
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

`daller_earnings_events` gains one row whenever `resolveAuction` credits a
seller's `dallers_balance_cents` on a successful sale — same event, same
amount, recorded twice for two different purposes (a lifetime running
total vs. a queryable time-windowed ledger).

### Frontend wiring

Settings' Build tab shows a "Land Cap" field (`renderLandCapField` in
`src/main.js`) above Publish/Version History — a builder-account fact, not
tied to the currently-active landlet, so it renders whenever a builder
identity is active regardless of `currentMode`/`currentLandletId` (unlike
Publish, which needs an active Build-mode landlet). It shows current owned
area (summed from `GET /api/landlets?status=claimed&ownerBuilderId=...`)
against `landCapM2` from `GET /api/builders`.

### Testing note

`worker/index.test.js`'s "Land cap" describe block covers the default,
the formula's own math, the ratchet surviving earnings aging out of the
trailing window, the per-event ledger actually being credited on a real
auction sale, the starter claim being unaffected, and — explicitly — that
a bid exceeding cap is **not** rejected, confirming the tracking-only
decision is what's actually shipped rather than a leftover TODO.
`e2e/land-cap.test.mjs` covers the Settings display through the real UI.

## Simulated purchases

Land cap's own commentary above flags the actual gap directly: this
dev-mode backend has no real commerce/checkout system at all, only auction
sale proceeds as a dáller source, even though docs/SPEC.md §5's *intended
primary* earning path is "Dállers credit instantly to builders on sale
completion" of a *product*. This closes that gap — `POST
/api/instances/:instanceId/purchase` (`migrations/0051_purchases.sql`) lets
a shopper "buy" a priced, placed product.

**This is a dev-mode simulation, not real commerce.** No real payment is
ever processed and a shopper is charged nothing — this project's standing
"no real payments/Stripe" constraint is untouched, the same way it's
untouched by the existing simulated dállers/auction economy. What *is*
real is the commission math: a successful purchase credits an actual
builder's `dallers_balance_cents` and `daller_earnings_events` ledger
(migrations/0050), so it feeds land cap's own formula for real.

### Request/response

```
POST /api/instances/:instanceId/purchase
{ "quantity": 2, "buyerLabel": "A Shopper" }   // both optional
```

Both fields are genuinely optional (unlike every other POST body in this
API) — a missing or empty body just means "buy one, anonymously," not a
400, since a purchase has no other required input beyond which instance is
being bought. Returns `201` with the created `purchase`:

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
    "createdAt": "..."
  }
}
```

`404` if the instance or its underlying catalog template doesn't exist,
`400` if the template has no price set (`priceCents == null` — nothing to
buy) or the instance sits on an unclaimed lándlet (no builder to credit).

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
the platform's own share is `0`, never negative.

### Frontend wiring

Shop mode's proximity-tracked nearest-instance hint column
(`updateReviewFade` in `src/main.js`, shared with "Product reviews" and
"Product pricing" above) gains a "Simulate Purchase" button
(`#shop-buy-hint`), shown only when the nearest instance's template has a
price set. Clicking it confirms the simulated charge (making the no-real-
money nature explicit in the copy itself) before calling `purchaseInstance`
(`src/api.js`).

### Testing note

`worker/index.test.js`'s "Simulated purchases" describe block covers the
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

### Refunds

docs/SPEC.md §5: "Returns/refunds return real currency, not dállers ...
**Requires a dáller-commission clawback mechanism** (builder's instant
commission on a returned sale is deducted, potentially creating a negative
balance to settle)." "Returns return real currency" describes *real*
commerce and doesn't apply here — a simulated purchase never moved real
currency in the first place. What does need undoing is the one real
side-effect a purchase has: the builder's commission credit.

`POST /api/purchases/:purchaseId/refund` (`migrations/0052_purchase_refunds.sql`)
requires a session logged in as the purchase's own `sellerId`, if it has
one (`403` otherwise — a purchase of a seller-less template stays open,
matching the same rule as the `GET` above). Marks a purchase refunded and
deducts exactly `builderShareCents` (not the
full sale total — that was never the builder's money) from
`builders.dallers_balance_cents`. **No floor** — this can and deliberately
does push a builder's balance negative, matching the spec's own "potentially
creating a negative balance to settle." `404` if the purchase doesn't
exist, `400` if it's already been refunded, `400` if the product's seller
has opted into "no returns" (`metadata.noReturns === true`, docs/SPEC.md
§5's "No-returns-policy respected as seller-set default" — absent/false is
the spec's own default of accepting returns).

**Deliberately does not touch `daller_earnings_events`** (migrations/0050)
or land cap — that ledger exists only to feed land cap's trailing-earnings
formula, and land cap's own ratchet ("once increased, never decreases")
means a refund shouldn't claw back cap growth it already produced, only the
dállers balance itself.

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

`worker/index.test.js`'s "Simulated purchases" describe block covers the
refund 404/already-refunded/no-returns 400s, the exact clawback amount, the
negative-balance case, and the `templateId` listing filter.
`e2e/purchase-refunds.test.mjs` covers the Sales panel's refund button and
the Edit Returns Policy panel through the real UI — the no-returns
*rejection* path isn't covered there for the same reason prohibited-content
rejection isn't in `e2e/digital-goods.test.mjs`: a real 400 trips the
shared `errors.length === 0` check.

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
  and uniform Resize scale factor (see "Frontend-only Resize").
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
- `daller_earnings_events`: a per-event, timestamped dáller-earnings ledger
  per builder (see "Land cap" above), distinct from the running
  `builders.dallers_balance_cents` lifetime total.
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
a real authentication system — everyone behind it shares one passphrase and
one session shape, and it has no concept of the `ownerBuilderId`/builder
identity used elsewhere in this API. See the note below: this doesn't change
the fact that the API itself still has no per-user auth or authorization.

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

Shop's horizontal movement is walking, not free flight — the move joystick
only ever changes `camera.position.x/y`. Height (`camera.position.z`) is a
separate, deliberately decoupled control: press-and-hold Up/Down buttons
(`#shop-up-btn`/`#shop-down-btn`, mirroring the joystick's pointer-capture
pattern but simpler — no drag vector, just a held direction) move the
camera straight along world Z at `SHOP_VERTICAL_SPEED_M_S`, independent of
look direction, walk input, or FOV/zoom. Both the walking floor clamp and
the vertical control share one `clampShopCameraHeight()` helper, so the
ceiling — `SHOP_WALL_HEIGHT_M + shopDomeRiseM - SHOP_DOME_CLEARANCE_MARGIN_M`
— stays consistent regardless of which input changed height last, and
tracks the dome's own growth as it rises to clear tall builds.

## Frontend-only Resize

A real uniform scale for a placed instance (`mesh.userData.scale`, persisted
as the instance's `scale` field), entirely separate from Trim's per-axis
`crop` above — for a model whose own source came in at the wrong physical
size entirely (an uploaded scan authored many times too large or too small),
not something limited to templates that declare themselves extensible.
`#mode-resize` sits alongside Move/Rotate/Trim in the same gizmo-mode row,
enabled for any single selected item (unlike Trim, which stays disabled for
anything not extensible).

The gizmo itself is a second `TransformControls` instance (`scaleControls`)
in `'scale'` mode, with `showX`/`showY`/`showZ` all set `false` so only its
built-in uniform (center) handle is interactive — a per-axis drag would
distort the model exactly the way Trim is careful never to, so those handles
are hidden rather than merely discouraged. A numeric field
(`#resize-scale-input`, shown as a percentage) offers the same exact-value
alternative Trim's own length field does.

TransformControls' scale mode scales an object about its own local origin,
which sits at the object's vertical *center* once placed (see
`createMeshForInstance`'s "z = height / 2 rests it on ground" convention) —
left alone, growing the scale would sink the object into whatever it's
resting on, and shrinking it would lift it into the air, since only the
geometry grows/shrinks while `position.z` stays fixed. `keepRestingOnScaleChange`
recomputes `position.z` on every scale change to keep the object's *bottom*
edge exactly where it was — not assumed to be bare ground, since Snap can
rest an item on top of another one — so it grows/shrinks in place rather
than visibly sinking or floating.

`scale` factors into `meshDimensions()` alongside `crop`, so collision,
landlet-bounds clamping, and stacking all see a resized item's real
(scaled) footprint rather than its template-declared one.

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
  full storage scan. New objects return `201`. The returned `modelUrl` is then used
  as-is in a normal `POST /api/catalog` call to register the product — upload
  and catalog registration are two independent steps. Catalog creates and
  updates validate `/uploads/` model URLs against live R2 metadata and return
  `400` rather than storing a reference to a missing upload. Built-in `/models/`
  URLs and external catalog URLs are unaffected by this upload-specific check.
- `GET /api/models` — lists uploaded R2 models without returning their bodies.
  Results contain `modelUrl`, `sizeBytes`, `etag`, `uploadedAt`, `deletable`,
  and sorted `referencedByTemplateIds`. Reference metadata is resolved with one
  bounded D1 query for the R2 page, allowing cleanup tooling to distinguish
  safe deletions without probing each object. Listings use a
  `limit` from 1 to 100, and return the R2-backed opaque `nextCursor` for the
  next page. This is a dev inventory for finding uploads that can be reclaimed.
- `GET /api/models/storage` — scans the paginated R2 metadata inventory and
  reports `usedBytes`, `objectCount`, the application-level `capBytes`,
  `availableBytes`, and `utilizationRatio`. This exposes the same live storage
  accounting enforced before uploads, without downloading object bodies.
- `POST /api/models/cleanup` — deletes up to `maxDeletes` unreferenced uploads
  (`1`–`100`, default `100`) after scanning bounded R2 pages and resolving each
  page's catalog references in one D1 query. The response reports
  `targetModelUrls`, `targetCount`, `reclaimedBytes`, and whether the scan
  reached the end of the bucket. Objects are collected before the bulk delete
  so deleting them cannot invalidate an in-progress R2 cursor. Set boolean
  `dryRun` to `true` to return the same proposed targets and reclaimed-byte
  total without deleting anything; the response echoes `dryRun`.
- `GET /uploads/:key` — serves a previously-uploaded model's bytes back out of
  R2 (not the `ASSETS` static bundle, since only the built-in models ship as
  build assets). Responses are cached indefinitely (`immutable`) since upload
  keys are never reused. `HEAD` is also supported for metadata-only checks, and
  matching `If-None-Match` requests receive `304 Not Modified`. Other methods
  receive `405 Method Not Allowed`.
- `DELETE /uploads/:key` — removes an unreferenced upload from R2 so dev model
  iterations do not permanently consume the application storage allowance.
  Uploads still referenced by a catalog template return `409`; delete the
  catalog template first. Missing uploads return `404`.

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
rejects any other value with `400`. Requirement (a) from the spec quote
above — "a representative 3D model" — needs no separate check here, since
every catalog template already either has a real `modelUrl` or renders as
a placeholder box regardless of this feature; there was never a path to a
template with no visual representation at all.

Since this dev-mode app has no checkout or delivery mechanism of any kind
(real or digital), "digital goods are excluded by default" has nothing
concrete to be excepted *from* here — the only part of this spec item with
a real, enforceable rule is (b), the mandatory controlled disclaimer, which
is what this actually implements.

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

`worker/index.test.js`'s "Prohibited categories and digital goods" describe
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
- Add auth/trust/payment/account concepts only after the single-player dev
  backend is stable; they are intentionally out of scope now.
