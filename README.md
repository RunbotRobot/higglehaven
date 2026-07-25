# higglehaven

A persistent 3D shopping world — browser-based, users build on owned land parcels and shop from real, purchasable products placed by other users.

Full product/design spec: [`docs/SPEC.md`](docs/SPEC.md). Read it before making architectural decisions — it's the source of truth for naming, mechanics, and phasing.

**Current phase:** single-player MVP core only (spec §9) — 3D space rendering, then product placement, then building tools, then plot/land mechanics. No multiplayer, commerce, payments, or auctions yet.

**Naming convention:** plain "a" internally in all code/files/DB/APIs (`land`, `landlet`, `daller`) — the á accent is reserved for user-facing display strings only.

## Stack

- [Three.js](https://threejs.org/) for WebGL rendering.
- [Vite](https://vite.dev/) for dev server and static build.
- Plain JavaScript (no framework, no TypeScript, for now).

## Development

```sh
npm install
npm run dev       # local dev server with hot reload
npm run build     # production build to dist/
npm run preview   # serve the production build locally
```

## Deployment

Static output (`dist/`) is deployed via Cloudflare Pages, connected to this GitHub repo. Dev-only for now — no custom domain, unlisted `*.pages.dev` URL, never announced as live.
