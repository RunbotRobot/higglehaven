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

## Builders

A shared, cross-device roster of builder identities. Still not real
authentication — anyone can list, create, rename, or delete any of these,
there's no password or ownership check on the roster itself — but it's now
one server-side list instead of every browser inventing its own in
`localStorage`, so switching devices sees the same builders.

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

Creates a builder. `builderId` is optional; if omitted, the Worker
generates one. Passing an explicit `builderId` exists for migrating a
device's pre-existing local identity list onto this shared roster without
losing track of whatever it already claimed under that exact ID — new
callers should omit it and let the Worker generate one.

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
doesn't exist.

### `DELETE /api/builders/:builderId`

Deletes a builder. Whatever claimed landlet it currently owns is released
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

This app has no separate profile page, so the identity roster row — the
one place a builder's own name is actually shown (`renderIdentityList` in
`src/main.js`) — is the closest fit: a ranked builder gets a small
"🏆 Pioneer #N" badge next to their label there, showing the actual rank
(not just membership) so it reads as more impressive the further the
platform's real population grows past this fixed founding hundred — the
spec's own "grows in prestige over time." Sellers have no such concept;
`identity.isPioneer` is simply `undefined` for a seller row, so the badge
never renders for one.

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
references these, not a builder's ID. Same dev-mode shape as Builders above
(shared, cross-device, still no real authentication), but a builder and a
seller are independent identities: uploading a product needs a seller
identity chosen, quite apart from whichever builder identity (if any) is
active, and the two aren't linked to each other in any way.

### Seller object

```json
{
  "sellerId": "seller-7f3a1c20-9e44-4b7a-8c3d-1a2b3c4d5e6f",
  "label": "Ada's Shop",
  "createdAt": "2026-08-16T00:00:00.000Z",
  "updatedAt": "2026-08-16T00:00:00.000Z"
}
```

### `GET /api/sellers`

Lists every seller, oldest first. Not paginated, same reasoning as
`GET /api/builders`.

### `POST /api/sellers`

Creates a seller. `sellerId` is optional; if omitted, the Worker generates
one.

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
doesn't exist.

### `DELETE /api/sellers/:sellerId`

Deletes a seller. Unlike deleting a builder, there's no owned-land release
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
bounded catalog batch. Both modes avoid one D1 request per product.

`DELETE` accepts 1–100 unique IDs under `templateIds`. Every ID is preflighted
before deletion; a missing ID returns `404`, and a foreign-key conflict returns
`409` with the entire D1 batch rolled back. Success returns `deletedTemplateIds`
in request order.

### `POST /api/catalog`

Creates a catalog template. `templateId` is optional; if omitted, the Worker
generates one.

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

Updates a catalog template. The current implementation merges request fields
with the existing template before validation — but only at the top level:
`metadata` is a single field, so sending it replaces the whole object rather
than deep-merging into it. A caller that wants to change one key inside
`metadata` (the Seller modal's extensibility edit, say) needs to read the
existing `metadata` first and send the whole merged object back — see
"Extensible products (crop)" above.

If the request actually changes `dimensions`, every builder with a placed
instance of this template gets a notification once the update succeeds —
see "Notifications" below.

### `DELETE /api/catalog/:templateId`

Deletes a catalog template. D1 foreign-key behavior may reject deletion while
placed instances still reference the template.

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

Still no real accounts (same dev-mode caveat as Builders/Sellers above), but
a template's `sellerId` is a genuinely separate identity from whichever
builder uploaded it — see "Sellers" above. Reaching Sell mode (the `#mode-nav`
Sell tab — the only way in; there is deliberately no "My Products" shortcut
from Build mode) ensures a seller identity is chosen first if one isn't
already (`ensureSellerIdentity` in `src/main.js`) — no builder identity or
claimed landlet needed, only a seller one. The Sell modal lists every
template whose
`sellerId` matches the active seller, plus any custom-uploaded template with
a `null` `sellerId` (covers products uploaded before sellers existed as their
own concept). A "Seller identity" button inside the modal reopens the same
identity picker to switch or rename — unlike switching builders, this
doesn't reload the page, since nothing about the Build/Shop scene depends on
which seller is active.

Each row leads with just the product's name; tapping it (`.seller-row-toggle`)
expands the row to reveal everything else — dimensions, action buttons, and
the Extensibility/Edit Size panels — the same collapse-until-tapped pattern
the identity picker uses for builder/seller rows. Tapping a different row's
toggle collapses whichever one was open, and a collapsed row's live preview
(if any) is torn down (`disposeAxisPreview`) rather than left rendering
behind a `display:none` panel.

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

Updates world settings. The current implementation merges request fields with
the existing world settings before validation.

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

### `POST /api/world/expand`

Expands the circular world boundary by exactly one configured
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

Marks every materialized landlet in a generated ring complete with one bounded
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

Claims an available greenbelt landlet for a builder. This is the preferred way
to perform the initial ownership transition instead of changing `status` and
`ownerBuilderId` independently with the generic update endpoint.

Request:

```json
{
  "builderId": "dev-builder-001"
}
```

The claim is a conditional database update: the landlet must still have
`status: "greenbelt"`, must have no owner, and the builder must not already own
a claimed landlet. This preserves the MVP rule that each builder can claim one
free starter landlet even when two requests arrive close together. A partial
unique D1 index also enforces this ownership rule for writes made through other
dev tooling.

Returns the newly claimed landlet. Errors are:

- `400` when `builderId` is absent or invalid.
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

Updates a landlet. The current implementation merges request fields with the
existing landlet before validation.

### `DELETE /api/landlets/:landletId`

Deletes a landlet. Current D1 foreign-key behavior cascades to placed instances
for that landlet.

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

Atomically replaces the complete mutable draft. The request body is:

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

Atomically writes between 1 and 100 placed instances. The request body wraps
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
unchanged. Success returns `deletedInstanceIds` in request order.

### `POST /api/instances`

Creates a placed instance. `instanceId`/`id` is optional; if omitted, the Worker
generates one. `landletId` defaults to `starter-landlet`.
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

Updates a placed instance. The current implementation merges request fields
with the existing instance before validation.

### `DELETE /api/instances/:instanceId`

Deletes a placed instance.

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

Lists a builder's notifications, newest first, capped at 100. `builderId` is
a required query parameter. `unreadOnly=true` narrows the list to
`readAt IS NULL` server-side — the same call backs both the unread badge
count (`unreadOnly=true`) and the full history list (omitted) in the
frontend's Notices panel.

### `PATCH /api/notifications/:notificationId`

Marks one notification read. Request body: `{ "read": true }`. Returns
`404` if the notification doesn't exist.

### `POST /api/notifications/mark-all-read`

Marks every one of a builder's unread notifications read at once. Request
body: `{ "builderId": "..." }`.

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
it. The backend enforces no ownership check at all on `PATCH`/`DELETE` (the
same no-real-auth caveat as every dev-mode identity in this file) — the
frontend is the only thing hiding those controls on a bundle you don't own
(see "Frontend wiring" below).

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

- `?builderId=X` — that builder's own bundles, newest first, capped at 100
  (shared or not — a builder's own shared bundles keep showing here too,
  they just *additionally* surface in the community listing below).
- `?shared=true` — the community tab: every builder's shared bundles,
  newest first, capped at 100. `builderId` is ignored/not required here.

Exactly one of the two query parameters is expected per call; there's no
mode that combines "this builder's bundles, restricted to shared ones."

### `POST /api/bundles`

Creates a bundle. Request body: `{ "builderId", "name", "items", "shared"? }`.
`shared` defaults to `false` (private) if omitted or not literally `true`.
Each item's `templateId` must reference an existing catalog template
(checked in one batched query, same pattern as the instance batch
endpoints); `items` must be a non-empty array, capped at 250 entries like an
instance batch save. `dx`/`dy`/`dz` and the rotation fields may be negative
or zero — only `crop`/`scale` reuse the stricter validation a placed
instance itself gets (`validateCropShape`/`validateScale`), since those two
are genuinely sign-constrained.

### `PATCH /api/bundles/:bundleId`

Updates `name` and/or `shared` — both optional and independent; omitting
one leaves it at its current value rather than requiring the full object
back — the frontend's Rename button only ever sends `{ name }`. There's no
way to edit a saved bundle's `items` — the frontend has no
UI for that; delete and re-save from a fresh selection instead.

### `DELETE /api/bundles/:bundleId`

Deletes a bundle. Response: `{ "deleted": true }`. Returns `404` if it
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
`404` if the post doesn't exist (or belongs to a different instance).
Deleting the sign instance itself cascades to every post on it
(`ON DELETE CASCADE`, migrations/0041) — no orphaned posts left behind.

No ownership check on any of these three — same no-real-auth caveat as
`handleBundles`' own note above; the frontend's Manage Posts panel (below)
is the only thing hiding the delete control from a builder who doesn't own
the sign's landlet.

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

Starts a voluntary auction. Body: `{ "builderId", "startingBidCents"?,
"durationHours"? }`. `startingBidCents` defaults to `0`; `durationHours`
defaults to `24` (docs/SPEC.md §5's own default), capped at `8760` (one
year) as a sanity bound against a malformed request, not a spec
requirement. `400` unless `builderId` is the landlet's current owner and
the landlet is `claimed`. `409` if that landlet already has an active
auction — one at a time per landlet.

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

Places a bid. Body: `{ "builderId", "amountCents" }`. Resolves the
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

## D1 schema overview

The migrations currently create sixteen main backend tables:

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
- `bundles`: a builder's saved, named multi-item groups (see "Bundles" above).
- `sign_posts`: shopper-authored posts on a placed instance flagged
  `isCommunitySign` (see "Community signs" above), cascade-deleted with
  their instance.
- `calendar_events`: builder-authored events on a placed instance flagged
  `isCommunityCalendar` (see "Community calendar" above), cascade-deleted
  with their instance.
- `auctions`: land acquisition auction listings on a claimed landlet (see
  "Land acquisition auctions" above).
- `auction_bids`: bids placed on an auction, cascade-deleted with it.

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
into it, no identity gate first, matching how it's always worked (`enterShopMode`
needs no `builderId`). Build still needs a builder identity and a claimed landlet, so
switching into it runs the same builder-menu/claim flow bootstrap() always
ran, just deferred until the nav is actually clicked instead of unconditionally
at startup. Sell only needs its own seller identity — a genuinely separate
one from a builder's, not reused (see "Sellers" and "Managing extensibility"
above) — so it opens as a plain overlay on top of whichever of the other two
is currently active, no builder identity, mode switch, or claimed landlet
required.

Shop and Build are different enough scene setups (per-world absolute
coordinates + flight controls vs. one landlet's local coordinates + build
gizmos) that switching between them goes through a full page reload rather
than a live in-place teardown/rebuild — a deliberate choice, not an
oversight: a live teardown/rebuild between two scene setups this different
was judged riskier than the reload's brief flash. `sessionStorage`'s
`higglehaven.startMode` carries the *next* mode across that one reload;
it's consumed once bootstrap() reads it, so an unrelated refresh with
nothing set always falls back to Shop.

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
first tap places point A, the second places point B and shows the result,
and a third starts an entirely new measurement rather than adding a third
point. Each tap resolves to a 3D point via the same "a placed item's own
surface wins over the bare ground beneath it" raycast `handlePlacementClick`
already uses for tap-to-place (see `resolveMeasurePoint`) — so a point can
land precisely on, say, the top face of a stacked course, not only ever on
the ground plane underneath everything. Two small spheres mark the picked
points and a dashed line joins them (`measureMarkerA`/`measureMarkerB`/
`measureLine`) for a few seconds of visual confirmation of what was
actually measured, not just its number.

The result — straight-line distance, plus its X/Y/Z breakdown — is shown in
`#product-info` (which Measure repurposes for its own status text the whole
time it's on; `updateSelectionUI`'s own `measureMode` branch leaves that
element alone while hiding the gizmo row, the same "selection persists,
UI just steps out of the way" hand-off Multi-Select already gets), each
length formatted through the existing `formatLength`/Units machinery so it
reads in whichever of meters or feet Settings has picked. The X/Y/Z
breakdown matters because two taps meant to land exactly one above the
other rarely do in practice — reading Δz directly means a slightly
off-center second tap still measures the intended height correctly instead
of forcing a re-measurement.

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
