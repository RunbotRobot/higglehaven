// #4003 (slice a): items let into Build's first draw of a lándlet resolve out of soft fog instead of
// popping in -- "Things arrive in the world through fog; nothing pops in". This is Shop's mechanism,
// not a second one: the clustering, fog cap and timeline are src/shop/arrivalFog.js, the fog and the
// dither dissolve are src/shop/arrivalEffect.js. What differs is only who decides "ready": in Shop the
// instance list is known before any model, in Build an item is ready the moment the level-of-detail
// pass lets it in from its hold-back (src/build/lod.js), so each batch let in together is clustered and
// arrives together.
//
// Cost: one dissolve per cluster, not per item (every item of a cluster shares the one material clone
// per original material and one uniform), a fog per cluster up to the scene-wide cap, and update() walks
// only the clusters still arriving, so a lándlet at rest costs nothing. Only items let in during the
// first load arrive this way; a placement, paste or undo afterwards is drawn at once.
import { createArrivalFog, createArrivalDissolve } from '../shop/arrivalEffect.js';
import { arrivalLevels, clusterArrivals, pickFogClusters } from '../shop/arrivalFog.js';
import { aliveArrivalFogCount } from '../shop/arrivalRun.js';

// A cluster whose items never settle (every one deleted, say) is ended after this long.
export const BUILD_ARRIVAL_MAX_S = 5;

const DEFAULT_EFFECTS = { createFog: createArrivalFog, createDissolve: createArrivalDissolve };

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// The subtrees of an item that can be drawn: its full model and its attached simpler versions, so a
// version flip during the second the arrival lasts still shows a dissolving mesh.
function drawableRoots(object) {
  const data = object.userData;
  const roots = [];
  if (data.model) roots.push(data.model);
  if (data.lodTiers?.mid) roots.push(data.lodTiers.mid);
  if (data.lodTiers?.far) roots.push(data.lodTiers.far);
  return roots;
}

// parent: the group the items live in (the fog is added to it, in the same local frame as the items'
// positions). anchor(): { x, y } in that frame, so the nearest clusters get the fogs when the cap
// leaves too few.
export function createBuildArrival({
  parent,
  anchor = () => ({ x: 0, y: 0 }),
  clock = () => performance.now(),
  reducedMotion = prefersReducedMotion,
  effects = DEFAULT_EFFECTS,
}) {
  const states = [];
  let aliveFogs = 0;

  function finish(state) {
    state.fog?.dispose();
    if (state.fog) aliveFogs -= 1;
    state.fog = null;
    state.dissolve?.restore();
    for (const object of state.objects) object.userData.lodArriving = false;
    const at = states.indexOf(state);
    if (at >= 0) states.splice(at, 1);
  }

  return {
    // objects: the items just let in together, already drawn (visible) in the version they will show.
    start(objects) {
      const reduced = reducedMotion();
      const items = [];
      const byId = new Map();
      objects.forEach((object, index) => {
        const radius = object.userData.lodRadiusM ?? 1;
        const id = index;
        byId.set(id, object);
        items.push({
          id, x: object.position.x, y: object.position.y, halfWidth: radius, halfDepth: radius,
          groupId: object.userData.groupId ?? undefined, bundleId: object.userData.bundleId ?? undefined,
          zMin: object.position.z - radius, zMax: object.position.z + radius,
        });
      });
      const clusters = clusterArrivals(items);
      const picked = reduced ? { fogged: [], plain: clusters } : pickFogClusters(clusters, aliveFogs + aliveArrivalFogCount(), anchor());
      const fogged = new Set(picked.fogged.map((cluster) => cluster.key));
      clusters.forEach((cluster, index) => {
        const members = cluster.ids.map((id) => byId.get(id));
        const roots = members.flatMap(drawableRoots);
        let zMin = Infinity;
        let zMax = -Infinity;
        for (const id of cluster.ids) {
          zMin = Math.min(zMin, items[id].zMin);
          zMax = Math.max(zMax, items[id].zMax);
        }
        const state = { objects: members, startMs: clock(), fog: null, dissolve: null };
        // One dissolve over every drawable root of the cluster (createArrivalDissolve only traverses).
        state.dissolve = effects.createDissolve({ traverse: (fn) => roots.forEach((root) => root.traverse(fn)) });
        state.dissolve.setLevel(0);
        for (const object of members) object.userData.lodArriving = true;
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
      const reduced = reducedMotion();
      for (const state of [...states]) {
        const ageS = (nowMs - state.startMs) / 1000;
        // Ready from the start: the items are already let in, so only the fog's rise is waited for.
        const levels = arrivalLevels(ageS, 0, { reducedMotion: reduced, fog: state.fog !== null });
        state.fog?.setLevel(levels.fog);
        state.dissolve.setLevel(levels.item);
        if (levels.done || ageS > BUILD_ARRIVAL_MAX_S || state.objects.every((object) => !object.parent)) finish(state);
      }
    },
    arrivingCount() {
      return states.reduce((sum, state) => sum + state.objects.length, 0);
    },
    fogCount() {
      return aliveFogs;
    },
    dispose() {
      for (const state of [...states]) finish(state);
    },
  };
}
