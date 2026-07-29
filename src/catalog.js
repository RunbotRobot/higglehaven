// Fallback-only product catalog — main.js fetches the real catalog and
// instance list from the Worker API (worker/index.js) first, and only
// drops back to this file's CATALOG/DEFAULT_INSTANCES if that fetch fails
// (API unreachable, Worker not deployed, offline, etc). The backend's
// seeded catalog uses different templateIds (placeholder-table/chair/tree)
// than the ones below — that's fine since the two are never mixed within a
// single session (see main.js's bootstrap, which falls back to both
// together rather than pairing one source's catalog with the other's
// instances).
//
// Every template here now points at a real glTF model (public/models/) —
// no more generic shared box standing in for every product. `dimensions`
// stays alongside modelUrl regardless: it's the *collision* footprint
// (see main.js's clampToLandlet/resolveByAxis), kept as simple declared
// metadata independent of the visual mesh's actual geometry, same as most
// 3D engines separate a render mesh from its (simpler) collision shape.
// `color` is now only a fallback tint, used if a template has no modelUrl
// or the model fails to load.
export const CATALOG = [
  {
    templateId: 'crate',
    name: 'Crate',
    dimensions: { width: 1, height: 1, depth: 1 },
    color: 0xd2691e,
    modelUrl: '/models/crate.glb',
  },
  {
    templateId: 'planter',
    name: 'Planter',
    dimensions: { width: 0.6, height: 0.8, depth: 0.6 },
    color: 0x8b5a2b,
    modelUrl: '/models/planter.glb',
  },
  {
    templateId: 'lamp',
    name: 'Lamp',
    dimensions: { width: 0.3, height: 1.6, depth: 0.3 },
    color: 0xffd166,
    modelUrl: '/models/lamp.glb',
  },
  {
    templateId: 'table',
    name: 'Table',
    dimensions: { width: 1.4, height: 0.75, depth: 0.8 },
    color: 0x795548,
    modelUrl: '/models/table.glb',
  },
  {
    templateId: 'brick',
    name: 'Brick',
    dimensions: { width: 0.2, height: 0.057, depth: 0.095 },
    color: 0xa0522d,
    modelUrl: '/models/brick.glb',
  },
  {
    templateId: 'chair',
    name: 'Chair',
    dimensions: { width: 0.7, height: 1.0, depth: 0.7 },
    color: 0x3366cc,
    modelUrl: '/models/chair.glb',
  },
  {
    templateId: 'tree',
    name: 'Tree',
    dimensions: { width: 1.5, height: 4.0, depth: 1.5 },
    color: 0x2f8f46,
    modelUrl: '/models/tree.glb',
  },
];

// What a fresh landlet starts with, before any builder edits.
export const DEFAULT_INSTANCES = [
  { id: 'starter-crate', templateId: 'crate', x: 6, y: -4 },
  { id: 'starter-planter', templateId: 'planter', x: -5, y: 5 },
];
