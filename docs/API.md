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

Lists catalog templates ordered by name.

Optional query parameters:

- `category`: filters templates by exact category.

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
  ]
}
```

### `GET /api/catalog/:templateId`

Fetches one catalog template.

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
  "metadata": {},
  "createdAt": "2026-07-29T07:30:06.519Z",
  "updatedAt": "2026-07-29T07:30:06.519Z"
}
```

### `GET /api/landlets`

Lists landlets ordered by creation time.

Optional query parameters:

- `status`: filters by exact status (`greenbelt`, `claimed`, or `generating`).
- `ownerBuilderId`: filters by placeholder builder owner ID.

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

Lists placed instances for one landlet.

Optional query parameters:

- `landletId`: filters instances by landlet. Defaults to `starter-landlet`.

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
  ]
}
```

### `GET /api/instances/:instanceId`

Fetches one placed instance.

### `POST /api/instances`

Creates a placed instance. `instanceId`/`id` is optional; if omitted, the Worker
generates one. `landletId` defaults to `starter-landlet`.

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

The migrations currently create four main backend tables:

- `catalog_templates`: placeholder product templates and minimum product
  metadata.
- `landlets`: dev landlet records, including greenbelt/claimed/generating
  status, class, polygon metadata, generation timestamps, and placeholder
  owner IDs.
- `placed_instances`: objects placed into a landlet from catalog templates.
- `world_settings`: singleton dev world settings for circular expansion and
  shared world constants.

Indexes currently support category filtering and placed-instance lookups by
landlet/template.

Seed data includes:

- `starter-landlet`
- `placeholder-table`
- `placeholder-chair`
- `placeholder-tree`

## Frontend integration notes

- The current API already matches the frontend's Z-up placement convention via
  `x`, `y`, `z`, and `rotationZ` response fields.
- `id` is returned alongside `instanceId` on placed instances for compatibility
  with existing local instance handling.
- Frontend code should treat backend persistence as the source of truth once the
  API is available, with any offline/local fallback kept intentionally separate.
- Future auth should not be inferred from this API. All endpoints are currently
  open by design for dev-only MVP work.

## Known gaps / future backend work

- Replace placeholder D1 database IDs in local config when provisioning real
  Cloudflare resources.
- Add real land generation and circle-overlap calculations behind the world and
  landlet records.
- Add clearer D1 constraint handling for foreign-key and uniqueness errors.
- Add automated Worker endpoint tests once the API stabilizes.
- Add auth/trust/payment/account concepts only after the single-player dev
  backend is stable; they are intentionally out of scope now.
