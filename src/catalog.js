// Placeholder product catalog — no real product database exists yet.
// These are *templates* a builder can add instances of; an instance's own
// placement (position/rotation) is tracked separately once placed, not here.
// Dimensions in meters.
//
// This is now fallback-only data: main.js fetches the real catalog and
// instance list from the Worker API (worker/index.js) first, and only
// drops back to this file's CATALOG/DEFAULT_INSTANCES if that fetch fails
// (API unreachable, Worker not deployed, offline, etc). The backend's
// seeded catalog uses different templateIds (placeholder-table/chair/tree)
// than the ones below — that's fine since the two are never mixed within a
// single session (see main.js's bootstrap, which falls back to both
// together rather than pairing one source's catalog with the other's
// instances).
export const CATALOG = [
  {
    templateId: 'crate',
    name: 'Placeholder Crate',
    dimensions: { width: 1, height: 1, depth: 1 },
    color: 0xd2691e,
  },
  {
    templateId: 'planter',
    name: 'Placeholder Planter',
    dimensions: { width: 0.6, height: 0.8, depth: 0.6 },
    color: 0x8b5a2b,
  },
  {
    templateId: 'lamp',
    name: 'Placeholder Lamp',
    dimensions: { width: 0.3, height: 1.6, depth: 0.3 },
    color: 0xffd166,
  },
  {
    templateId: 'table',
    name: 'Placeholder Table',
    dimensions: { width: 1.4, height: 0.75, depth: 0.8 },
    color: 0x795548,
  },
];

// What a fresh landlet starts with, before any builder edits.
export const DEFAULT_INSTANCES = [
  { id: 'starter-crate', templateId: 'crate', x: 6, y: -4 },
  { id: 'starter-planter', templateId: 'planter', x: -5, y: 5 },
];
