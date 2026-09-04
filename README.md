# higglehaven

A persistent 3D shopping world — browser-based, users build on owned land parcels and shop from real, purchasable products placed by other users.

Full product/design spec: [`docs/SPEC.md`](docs/SPEC.md). Read it before making architectural decisions — it's the source of truth for naming, mechanics, and phasing.

**Current phase:** single-player MVP core (spec §9) — 3D space rendering, product placement, building tools, real plot/land mechanics (claim, extend, trim), and avatar/movement (a placeholder default-avatar body, third-person camera, ground-based walk/run, idle sway, and flight with a real altitude/speed curve — spec §2), backed by a real Cloudflare Workers + D1 + R2 backend (see [`docs/API.md`](docs/API.md)), including land acquisition auctions (spec §5). No multiplayer or real payments yet — see [`docs/SPEC.md`](docs/SPEC.md) §10 for what's still genuinely open.

**Naming convention:** plain "a" internally in all code/files/DB/APIs (`land`, `landlet`, `daller`) — the á accent is reserved for user-facing display strings only.

## Stack

- [Three.js](https://threejs.org/) for WebGL rendering.
- [Vite](https://vite.dev/) for the frontend dev server and static build.
- Plain JavaScript (no framework, no TypeScript, for now).
- Cloudflare Workers + D1 (SQLite) + R2 for the backend — see
  [`docs/API.md`](docs/API.md) for the full API and data model.

## Development

```sh
npm install
npm run dev                            # frontend-only dev server with hot reload (no backend)
npm run build                          # production build to dist/
npm run preview                        # serve the production build locally
wrangler dev --local                   # full stack (frontend + Worker + local D1/R2), after npm run build
npm run db:migrate:local               # apply migrations to local D1
npm run seed:mockup                    # populate a running local instance with realistic sample data
```

`npm run seed:mockup` needs a running `wrangler dev --local` in another terminal
(`ADMIN_BOOTSTRAP_SECRET` must be set in `.dev.vars` — see `docs/API.md`'s
"Admin role"). It signs up a few builder accounts with claimed land and
placed products (using the real models in `public/models/`), a seller with
a varied catalog (priced items, an extensible table, flooring, a digital
good, a no-returns item), a review, a couple of simulated purchases (one
refunded), a friendship, a shared bundle, a community sign/calendar with
posts, and an active auction with bids — useful for building and testing
a feature against something richer than an empty world. Prints each
seeded account's email/password at the end so you can log in and look
around. Dev-only; never run against a production/remote database.

## Testing

```sh
npm test                               # vitest — Worker/D1 unit tests (worker/*.test.js)
npm run test:e2e                       # Playwright — full browser flows against wrangler dev (see e2e/README.md)
```

`npm run test:e2e` builds the frontend, resets local D1, and drives a real
Chromium browser through claiming land, uploading a model, placing it,
editing/cropping it, and the identity-picker UI — see
[`e2e/README.md`](e2e/README.md) for why each test file gets a fresh D1 and
how to add a new one.

**CI:** both suites also run automatically on every push
(`.github/workflows/ci.yml`), as two independent jobs so they run in
parallel rather than queued one after the other. This is the intended way
to get a full-suite result without blocking local work on it — push, keep
coding, and check the commit's status (or the Actions tab) once it's
useful to know, rather than waiting on `npm run test:e2e` synchronously
every time. It needs no repository secrets: unit tests get a fixed test
secret straight from `vitest.config.js`, and the e2e job recreates the
one value its own `.dev.vars` needs inline (see that job's own comment for
why that's not a real secret).

## Deployment

Deployed to Cloudflare Workers behind a shared-passphrase access gate (dev
preview only, not a real accounts system — see `docs/API.md`'s
"Private-preview access gate" section) at `higglehaven.com`. `wrangler.jsonc`
configures both the static asset build (`dist/`) and the Worker
(`worker/index.js`) backing the API, D1 database, and R2 model storage.

To deploy manually: `npm run deploy` (requires `wrangler login` once,
locally). `npm run deploy:ci` additionally applies pending migrations to
the remote D1 database first.
