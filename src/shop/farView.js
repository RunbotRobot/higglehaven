// #3478 (2/4 of #3418, part of #3412, owner decision "Everything built is
// always shown as itself"): draws every landlet in view that the normal loader
// has not loaded, from its products' far models, out to the horizon. The
// planner (farViewPlan.js) decides what; farViewDraw.js builds the instanced
// meshes; this module reads the tiles, loads each product's model once, and
// feeds the builds through the frame-budgeted queue (#3396) so moving, looking
// and drawing never wait on it. Every dependency is passed in, so it runs in
// the plain unit-test pool.
//
// Hand-over with the normal loader (#3479, 3/4 of #3418): `loadedLandletIds`
// means "landlets whose real content is fully drawn" (not merely "started
// loading"), so a landlet keeps its far models until the loaded one has arrived
// out of its fog (arrivalRun.js, #3407): no frame with neither. The moment a
// landlet joins that set its far instances are hidden in place (a zero-scale
// matrix, a cheap in-memory write, same frame), so there is no frame with both
// either; the meshes are rebuilt without it later, behind nearby work. When a
// landlet leaves the set (unload) the next plan is made at once and its builds
// jump the queue, so the far version replaces the real one with the shortest
// gap the frame budget allows.
import * as THREE from 'three';
import { farViewTilesInRange, farViewTileKey, decodeFarPlacementsPayload, planFarView, FAR_VIEW_RANGE_M, FAR_VIEW_TILE_M } from './farViewPlan.js';
import { buildFarMeshes, triangleCount, farItemsSignature } from './farViewDraw.js';

const REPLAN_MIN_INTERVAL_MS = 500;
const REPLAN_MAX_INTERVAL_MS = 3000;
const REPLAN_MOVE_M = 25;
const TILE_RETRY_MS = 30000;
// #3396 ("moving, looking and drawing never wait on loading"): the far view is
// the last thing the world does. It starts only after START_DELAY_MS since the
// first call and once the world's work queue has been quiet for QUIET_MS, then
// reads one tile and loads one product at a time, with a gap between, so the
// page's own loading (and a network that goes idle) is never kept busy by it,
// and its builds sit behind every nearby build in the queue.
const START_DELAY_MS = 4000;
const QUIET_MS = 1500;
const TILE_FETCH_GAP_MS = 1000;
const SOURCE_LOAD_GAP_MS = 500;
const MAX_TILE_FETCHES_IN_FLIGHT = 1;
const MAX_SOURCE_LOADS_IN_FLIGHT = 1;
const FAR_BUILD_PRIORITY = 1e6; // minus apparent size: after any nearby build, whose priority is minus its size
const URGENT_PRIORITY = -1e6; // #3479: an unloaded landlet's far models, ahead of everything
const DISPOSE_PRIORITY = 1e9;
const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

export function createFarView({
  queue, root, fetchTile, loadSource, dimensionsFor, elevationFor, loadedLandletIds, getCamera, getView,
  now = () => performance.now(), rangeM = FAR_VIEW_RANGE_M,
}) {
  const group = {}; // queue group, so dispose() cancels what has not run
  const tiles = new Map(); // key -> { state, landlets, failedAt }
  const sources = new Map(); // templateId -> { state, source, triangles }
  const drawn = new Map(); // templateId -> { signature, object, meshes }
  const wanted = new Map(); // templateId -> signature the latest plan asks for
  let tilesInFlight = 0;
  let sourcesInFlight = 0;
  let dirty = true;
  let lastPlanAt = -Infinity;
  let lastPlanCamera = null;
  let lastLoadedKey = '';
  let lastStats = null;
  let disposed = false;
  let firstUpdateAt = null;
  let quietSince = null;
  let lastTileStartAt = -Infinity;
  let lastSourceStartAt = -Infinity;
  let ownPending = 0; // units this view has queued and not yet run
  let previousLoaded = new Set();
  let urgent = false; // a landlet just unloaded: replan now, build first

  function startTile(tile) {
    const key = farViewTileKey(tile);
    const record = { state: 'loading', landlets: [], failedAt: 0 };
    tiles.set(key, record);
    tilesInFlight += 1;
    Promise.resolve().then(() => fetchTile(tile.x, tile.y)).then((payload) => {
      record.landlets = decodeFarPlacementsPayload(payload);
      record.state = 'ready';
    }).catch(() => {
      record.state = 'failed';
      record.failedAt = now();
    }).finally(() => {
      tilesInFlight -= 1;
      dirty = true;
    });
  }

  function startSource(templateId) {
    const record = { state: 'loading', source: null, triangles: 0 };
    sources.set(templateId, record);
    sourcesInFlight += 1;
    Promise.resolve().then(() => loadSource(templateId)).then((source) => {
      if (disposed) { source?.dispose?.(); return; }
      if (source) {
        record.source = source;
        record.triangles = triangleCount(source.parts);
        record.state = 'ready';
      } else {
        record.state = 'none';
      }
    }).catch(() => {
      record.state = 'none';
    }).finally(() => {
      sourcesInFlight -= 1;
      dirty = true;
    });
  }

  function gatherLandlets() {
    const landlets = [];
    const templateIds = new Set();
    for (const record of tiles.values()) {
      if (record.state !== 'ready') continue;
      for (const landlet of record.landlets) {
        landlets.push(landlet);
        for (const item of landlet.items) templateIds.add(item.templateId);
      }
    }
    return { landlets, templateIds };
  }

  function scheduleBuild(templateId, items, signature) {
    wanted.set(templateId, signature);
    const source = sources.get(templateId).source;
    const priority = (urgent ? URGENT_PRIORITY : FAR_BUILD_PRIORITY) - Math.max(...items.map((item) => item.px));
    ownPending += 1;
    queue.enqueue(() => {
      ownPending -= 1;
      if (disposed || wanted.get(templateId) !== signature) return; // a newer plan replaced this one
      const dimensions = dimensionsFor(templateId);
      const meshes = buildFarMeshes(source.parts, items, elevationFor, dimensions);
      const object = new THREE.Group();
      for (const mesh of meshes) object.add(mesh);
      root.add(object);
      const previous = drawn.get(templateId);
      drawn.set(templateId, { signature, object, meshes, items });
      if (previous) retire(previous);
    }, { group, priority });
  }

  // Meshes leave the scene now; their instance buffers are released later,
  // a few at a time, behind anything still being built. Geometry and the
  // model's materials belong to the product's source and stay until dispose().
  function retire(entry) {
    root.remove(entry.object);
    ownPending += 1;
    queue.enqueue(() => { ownPending -= 1; for (const mesh of entry.meshes) mesh.dispose(); }, { priority: DISPOSE_PRIORITY });
  }

  // #3479: hides, in place, every drawn instance that belongs to one of
  // `landletIds` (the real landlet has just finished arriving over it).
  function hideLandlets(landletIds) {
    for (const entry of drawn.values()) {
      let touched = false;
      entry.items.forEach((item, index) => {
        if (!landletIds.has(item.landletId)) return;
        for (const mesh of entry.meshes) mesh.setMatrixAt(index, HIDDEN_MATRIX);
        touched = true;
      });
      if (touched) {
        entry.hidden = true; // drawn with holes: a plan that wants the same list again must rebuild
        for (const mesh of entry.meshes) mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  function scheduleRemoval(templateId) {
    wanted.set(templateId, null);
    ownPending += 1;
    queue.enqueue(() => {
      ownPending -= 1;
      if (wanted.get(templateId) !== null) return;
      const entry = drawn.get(templateId);
      if (!entry) return;
      drawn.delete(templateId);
      retire(entry);
    }, { group, priority: DISPOSE_PRIORITY - 1 });
  }

  function update() {
    if (disposed) return;
    const camera = getCamera();
    const t = now();
    if (firstUpdateAt === null) firstUpdateAt = t;
    // Quiet = nothing but this view's own work waiting in the world queue.
    if (queue.pending() > ownPending) quietSince = null;
    else if (quietSince === null) quietSince = t;
    const mayStart = t - firstUpdateAt >= START_DELAY_MS && quietSince !== null && t - quietSince >= QUIET_MS;
    // Tiles: read one when it comes into range, retry a failed one after a
    // while, forget one that has left range by more than a tile.
    const inRange = farViewTilesInRange(camera.x, camera.y, rangeM);
    const keep = new Set();
    for (const tile of inRange) {
      const key = farViewTileKey(tile);
      keep.add(key);
      const record = tiles.get(key);
      const mayFetch = mayStart && tilesInFlight < MAX_TILE_FETCHES_IN_FLIGHT && t - lastTileStartAt >= TILE_FETCH_GAP_MS;
      if (!record) {
        if (mayFetch) { lastTileStartAt = t; startTile(tile); }
      } else if (record.state === 'failed' && t - record.failedAt > TILE_RETRY_MS && mayFetch) {
        lastTileStartAt = t;
        startTile(tile);
      }
    }
    for (const [key, record] of tiles) {
      if (keep.has(key) || record.state === 'loading') continue;
      const [tx, ty] = key.split(',').map(Number);
      const nearestX = Math.min(Math.max(camera.x, tx * FAR_VIEW_TILE_M), (tx + 1) * FAR_VIEW_TILE_M);
      const nearestY = Math.min(Math.max(camera.y, ty * FAR_VIEW_TILE_M), (ty + 1) * FAR_VIEW_TILE_M);
      if (Math.hypot(nearestX - camera.x, nearestY - camera.y) > rangeM + FAR_VIEW_TILE_M) { tiles.delete(key); dirty = true; }
    }

    const { landlets, templateIds } = gatherLandlets();
    for (const templateId of templateIds) {
      if (!sources.has(templateId) && mayStart && sourcesInFlight < MAX_SOURCE_LOADS_IN_FLIGHT && t - lastSourceStartAt >= SOURCE_LOAD_GAP_MS) {
        lastSourceStartAt = t;
        startSource(templateId);
      }
    }

    const loaded = loadedLandletIds();
    const loadedKey = [...loaded].sort().join('|');
    if (loadedKey !== lastLoadedKey) {
      const joined = new Set([...loaded].filter((id) => !previousLoaded.has(id)));
      if (joined.size > 0) hideLandlets(joined);
      if ([...previousLoaded].some((id) => !loaded.has(id))) urgent = true;
      previousLoaded = new Set(loaded);
    }
    const moved = lastPlanCamera
      ? Math.hypot(camera.x - lastPlanCamera.x, camera.y - lastPlanCamera.y, camera.z - lastPlanCamera.z) > REPLAN_MOVE_M
      : true;
    const changed = dirty || loadedKey !== lastLoadedKey;
    const since = t - lastPlanAt;
    if (since < REPLAN_MIN_INTERVAL_MS && !urgent) return;
    if (!changed && !moved && since < REPLAN_MAX_INTERVAL_MS) return;
    dirty = false;
    lastPlanAt = t;
    lastPlanCamera = { x: camera.x, y: camera.y, z: camera.z };
    lastLoadedKey = loadedKey;

    const view = getView();
    const models = {
      has: (id) => sources.get(id)?.state === 'ready',
      triangles: (id) => sources.get(id).triangles,
      radiusM: (id, scale) => {
        const d = dimensionsFor(id);
        return d ? 0.5 * Math.hypot(d.width, d.depth, d.height) * scale : 0;
      },
    };
    const plan = planFarView({ landlets, loadedIds: loaded, camera, view, models });
    lastStats = plan.stats;
    // Largest on screen first: the queue runs lower priority first.
    for (const [templateId, items] of plan.byTemplate) {
      const signature = farItemsSignature(items);
      const current = drawn.get(templateId);
      if (current?.signature === signature && !current.hidden && wanted.get(templateId) === signature) continue;
      if (wanted.get(templateId) === signature && current?.signature !== signature) continue; // already queued
      scheduleBuild(templateId, items, signature);
    }
    urgent = false;
    for (const templateId of drawn.keys()) {
      if (!plan.byTemplate.has(templateId) && wanted.get(templateId) !== null) scheduleRemoval(templateId);
    }
  }

  function dispose() {
    disposed = true;
    queue.dropGroup(group);
    for (const entry of drawn.values()) {
      root.remove(entry.object);
      for (const mesh of entry.meshes) mesh.dispose();
    }
    drawn.clear();
    for (const record of sources.values()) record.source?.dispose?.();
    sources.clear();
    tiles.clear();
  }

  return {
    update,
    dispose,
    stats: () => ({
      tiles: tiles.size, products: drawn.size, plan: lastStats,
      drawCalls: [...drawn.values()].reduce((n, entry) => n + entry.meshes.length, 0),
    }),
  };
}
