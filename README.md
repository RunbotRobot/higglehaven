# higglehaven

A persistent 3D shopping world — browser-based, users build on owned land parcels and shop from real, purchasable products placed by other users.

Full product/design spec: [`docs/SPEC.md`](docs/SPEC.md). Read it before making architectural decisions — it's the source of truth for naming, mechanics, and phasing.

**Current phase:** single-player MVP core (spec §9) — 3D space rendering, product placement, building tools, and real plot/land mechanics (claim, extend, trim) backed by a real Cloudflare Workers + D1 + R2 backend (see [`docs/API.md`](docs/API.md)). No multiplayer, real payments, or auctions yet — see [`docs/SPEC.md`](docs/SPEC.md) §10 for what's still genuinely open.

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
```

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

## Deployment

Deployed to Cloudflare Workers behind a shared-passphrase access gate (dev
preview only, not a real accounts system — see `docs/API.md`'s
"Private-preview access gate" section) at `higglehaven.com`. `wrangler.jsonc`
configures both the static asset build (`dist/`) and the Worker
(`worker/index.js`) backing the API, D1 database, and R2 model storage.

To deploy manually: `npm run deploy` (requires `wrangler login` once,
locally). `npm run deploy:ci` additionally applies pending migrations to
the remote D1 database first.
