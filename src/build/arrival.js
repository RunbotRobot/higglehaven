// #4003 (slice a): items let into Build's first draw of a lándlet resolve out of soft fog instead of
// popping in -- "Things arrive in the world through fog; nothing pops in". This is Shop's mechanism,
// not a second one: the clustering, fog cap and timeline are src/shop/arrivalFog.js, the fog and the
// dither dissolve are src/shop/arrivalEffect.js. What differs is only who decides "ready": in Shop the
// instance list is known before any model, in Build an item is ready the moment the level-of-detail
// pass lets it in from its hold-back (src/build/lod.js), so each batch let in together is clustered and
// arrives together.
//
// Cost, bounded on every axis (review of #4008):
//   - Draw calls: an item that dissolves is drawn by itself (its materials are patched), so only the
//     BUILD_ARRIVAL_MAX_ITEMS nearest the orbit target, across everything arriving at once, get a
//     dissolve. Every other item is not touched and goes straight to batching (src/build/batching.js)
//     in the same pass, so a lándlet of 1,400 bricks never draws 1,400 of them one by one. The fog
//     covers the cluster either way; the items outside the cap simply do not fade.
//   - Frame time: clustering sees only the capped items; creating dissolves and fogs, and restoring
//     them at the end, stop when BUILD_ARRIVAL_SLICE_MS is spent (what was not reached is not
//     dissolved, or is restored on the next frame).
//   - One dissolve per cluster, a fog per cluster up to the scene-wide cap, and update() walks only
//     the clusters still arriving, so a lándlet at rest costs nothing.
// Only items let in during the first load arrive this way; a placement, paste or undo afterwards is
// drawn at once.
import { createArrivalFog, createArrivalDissolve } from '../shop/arrivalEffect.js';
import { arrivalLevels, clusterArrivals, pickFogClusters } from '../shop/arrivalFog.js';
import { aliveArrivalFogCount } from '../shop/arrivalRun.js';

// A cluster whose items never settle (every one deleted, say) is ended after this long.
export const BUILD_ARRIVAL_MAX_S = 5;
export const BUILD_ARRIVAL_MAX_ITEMS = 96; // dissolving items alive at once (each is its own draw call)
export const BUILD_ARRIVAL_SLICE_MS = 3; // what setting up or restoring clusters may use of a frame

const DEFAULT_EFFECTS = { createFog: createArrivalFog, createDissolve: createArrivalDissolve };

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// The subtrees of an item that can be drawn: its full model and its attached simpler versions.
function drawableRoots(object) {
  const data = object.userData;
  const roots = [];
  if (data.model) roots.push(data.model);
  if (data.lodTiers?.mid) roots.push(data.lodTiers.mid);
  if (data.lodTiers?.far) roots.push(data.lodTiers.far);
  return roots;
}

function rootCount(object) {
  const data = object.userData;
  return (data.model ? 1 : 0) + (data.lodTiers?.mid ? 1 : 0) + (data.lodTiers?.far ? 1 : 0);
}

// parent: the group the items live in (the fog is added to it, in the same local frame as the items'
// positions). anchor(): { x, y } in that frame: the nearest items get the dissolves and the nearest
// clusters the fogs.
export function createBuildArrival({
  parent,
  anchor = () => ({ x: 0, y: 0 }),
  clock = () => performance.now(),
  reducedMotion = prefersReducedMotion,
  effects = DEFAULT_EFFECTS,
  maxItems = BUILD_ARRIVAL_MAX_ITEMS,
  sliceMs = BUILD_ARRIVAL_SLICE_MS,
}) {
  const states = [];
  let aliveFogs = 0;
  let arriving = 0;

  // One dissolve over every drawable root of the cluster (createArrivalDissolve only traverses).
  // Rebuilt when an item's versions attach mid-arrival, so a version it flips to dissolves too.
  function makeDissolve(state) {
    const roots = state.objects.flatMap(drawableRoots);
    state.rootCount = roots.length;
    state.dissolve = effects.createDissolve({ traverse: (fn) => roots.forEach((root) => root.traverse(fn)) });
  }

  function finish(state) {
    state.fog?.dispose();
    if (state.fog) aliveFogs -= 1;
    state.fog = null;
    state.dissolve?.restore();
    state.dissolve = null;
    for (const object of state.objects) object.userData.lodArriving = false;
    arriving -= state.objects.length;
    const at = states.indexOf(state);
    if (at >= 0) states.splice(at, 1);
  }

  return {
    // objects: the items just let in together, already drawn (visible) in the version they will show.
    start(objects) {
      const room = maxItems - arriving;
      if (room <= 0 || objects.length === 0) return;
      const reduced = reducedMotion(); // read once for this arrival, not every frame
      const at = anchor();
      const nearest = objects.length <= room ? objects : objects
        .map((object) => ({ object, d: Math.hypot(object.position.x - at.x, object.position.y - at.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, room)
        .map((entry) => entry.object);
      const items = [];
      const byId = new Map();
      nearest.forEach((object, index) => {
        const radius = object.userData.lodRadiusM ?? 1;
        byId.set(index, object);
        items.push({
          id: index, x: object.position.x, y: object.position.y, halfWidth: radius, halfDepth: radius,
          groupId: object.userData.groupId ?? undefined, bundleId: object.userData.bundleId ?? undefined,
          zMin: object.position.z - radius, zMax: object.position.z + radius,
        });
      });
      const clusters = clusterArrivals(items);
      const picked = reduced ? { fogged: [], plain: clusters } : pickFogClusters(clusters, aliveFogs + aliveArrivalFogCount(), at);
      const fogged = new Set(picked.fogged.map((cluster) => cluster.key));
      const startedMs = performance.now();
      clusters.forEach((cluster, index) => {
        if (performance.now() - startedMs > sliceMs) return; // not reached: drawn plainly, batched at once
        const members = cluster.ids.map((id) => byId.get(id));
        let zMin = Infinity;
        let zMax = -Infinity;
        for (const id of cluster.ids) {
          zMin = Math.min(zMin, items[id].zMin);
          zMax = Math.max(zMax, items[id].zMax);
        }
        const state = { objects: members, startMs: clock(), fog: null, dissolve: null, rootCount: 0, reduced, done: false };
        makeDissolve(state);
        state.dissolve.setLevel(0);
        for (const object of members) object.userData.lodArriving = true;
        arriving += members.length;
        if (fogged.has(cluster.key)) {
          const extent = { width: 2 * cluster.halfX, depth: 2 * cluster.halfY, height: Math.max(1, zMax - zMin) };
          const lift = 0.65 * Math.max(1.5, 0.6 * Math.max(extent.width, extent.depth, extent.height));
          state.fog = effects.createFog({ center: { x: cluster.x, y: cluster.y, z: zMin + lift }, extent, seed: index });
          state.fog.setLevel(0);
          parent.add(state.fog.object);
          aliveFogs += 1;
        }
        states.push(state);
      });
    },
    update() {
      if (states.length === 0) return;
      const nowMs = clock();
      const startedMs = performance.now();
      let finishing = 0;
      for (const state of [...states]) {
        const ageS = (nowMs - state.startMs) / 1000;
        // Ready from the start: the items are already let in, so only the fog's rise is waited for.
        const levels = arrivalLevels(ageS, 0, { reducedMotion: state.reduced, fog: state.fog !== null });
        const gone = state.objects.every((object) => !object.parent);
        if (levels.done || ageS > BUILD_ARRIVAL_MAX_S || gone) {
          // Restoring clones is work too: one at a time while the slice lasts (always one), and a
          // cluster not reached waits a frame at full strength.
          if (finishing === 0 || performance.now() - startedMs < sliceMs) { finish(state); finishing += 1; } else { state.fog?.setLevel(0); state.dissolve.setLevel(1); }
          continue;
        }
        // Versions that attached since the dissolve was made are dissolved too, or the first flip into
        // one would show it opaque.
        let count = 0;
        for (const object of state.objects) count += rootCount(object);
        if (count !== state.rootCount) {
          state.dissolve.restore();
          makeDissolve(state);
        }
        state.fog?.setLevel(levels.fog);
        state.dissolve.setLevel(levels.item);
      }
    },
    arrivingCount() {
      return arriving;
    },
    fogCount() {
      return aliveFogs;
    },
    // The scene is torn down or the landlet changed: every fog goes and every original material is back.
    dispose() {
      for (const state of [...states]) finish(state);
    },
  };
}
