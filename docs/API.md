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
with the existing template before validation.

### `DELETE /api/catalog/:templateId`

Deletes a catalog template. D1 foreign-key behavior may reject deletion while
placed instances still reference the template.

Response:

```json
{
  "deleted": true
}
```

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

Candidates that intersect the current availability circle materialize as
generating landlets immediately. Remaining complete shapes stay queued and
non-selectable until a later expansion reaches them. The response contains
`candidates` and `materializedLandletIds`. Reusing a prefix returns `409`.

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
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

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

## D1 schema overview

The migrations currently create eight main backend tables:

- `catalog_templates`: placeholder product templates and minimum product
  metadata.
- `landlets`: dev landlet records, including greenbelt/claimed/generating
  status, class, polygon metadata, generation timestamps, and placeholder
  owner IDs.
- `placed_instances`: objects placed into a landlet from catalog templates.
- `world_settings`: singleton dev world settings for circular expansion and
  shared world constants.
- `landlet_versions`: immutable layout snapshot metadata.
- `version_instances`: instance transforms captured within each snapshot.
- `landlet_candidates`: lightweight planned plots awaiting first circle overlap,
  with optional generated-ring membership.
- `land_candidate_rings`: atomic radial reservations for procedurally generated
  candidate bands, including boundary signatures that keep adjacent polygonal
  rings seam-compatible and optional parent links for derived ring chains.

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
