// #3407 (leaf 3/3 of #3397, "Things arrive in the world through fog; nothing
// pops in"): the director of one landlet's arrival. Leaf 1 (arrivalFog.js)
// decides clusters, the fog cap and the timeline; leaf 2 (arrivalEffect.js)
// draws the fog and dissolves materials. This file ties them to a real load:
//
//   const run = createArrivalRun({ parent, instances, ... });   // list arrived
//   run.itemReady(instanceId, object);   // an item was built and attached
//   run.itemSettled(instanceId);         // an item will never arrive (failed,
//                                        // empty, superseded)
//   run.update();                        // every frame
//   run.dispose();                       // unload, or a newer load took over
//
// The moment the instance list arrives (before any model is built) every
// cluster that the cap allows gets a fog over its known position. Items that
// are built meanwhile are attached but fully dissolved (nothing visible); once
// every item of a cluster has settled the cluster resolves out of its fog.
// Nothing here does expensive work per frame: update() touches only clusters
// still arriving, and a finished cluster restores its plain materials and
// disposes its fog, so a landlet at rest costs nothing.
import { createArrivalFog, createArrivalDissolve } from './arrivalEffect.js';
import { arrivalLevels, clusterArrivals, pickFogClusters } from './arrivalFog.js';

// A cluster whose last items never settle (a stalled download) resolves anyway
// after this long, so a fog never hangs over a landlet for ever.
export const ARRIVAL_MAX_WAIT_S = 20;

// Fogs alive across every landlet at once (the cap in arrivalFog.js is scene
// wide, not per landlet).
let aliveFogCount = 0;
export function aliveArrivalFogCount() {
  return aliveFogCount;
}

const DEFAULT_EFFECTS = { createFog: createArrivalFog, createDissolve: createArrivalDissolve };

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// instances: the landlet's instance list ({ instanceId, templateId, x, y, z,
// scale, groupId, bundleId }); templateFor(templateId) -> { dimensions } | null.
// parent: the landlet's group (the fog is added to it, so it moves with it and
// is removed with it). anchor: { x, y } in the landlet's local frame, used to
// decide which clusters get a fog when there are more than the cap allows.
export function createArrivalRun({
  parent,
  instances,
  templateFor = () => null,
  anchor = { x: 0, y: 0 },
  clock = () => performance.now(),
  reducedMotion = prefersReducedMotion(),
  effects = DEFAULT_EFFECTS,
}) {
  const startMs = clock();
  const items = [];
  for (const instance of instances || []) {
    if (!instance || instance.instanceId === undefined || instance.instanceId === null) continue;
    const dims = templateFor(instance.templateId)?.dimensions;
    const scale = Number.isFinite(instance.scale) ? instance.scale : 1;
    const width = (dims?.width ?? 1) * scale;
    const depth = (dims?.depth ?? 1) * scale;
    const height = (dims?.height ?? 1) * scale;
    const z = Number.isFinite(instance.z) ? instance.z : 0;
    items.push({
      id: instance.instanceId,
      x: instance.x ?? 0,
      y: instance.y ?? 0,
      // Rotation is not known here, so use the footprint's half diagonal.
      halfWidth: 0.5 * Math.hypot(width, depth),
      halfDepth: 0.5 * Math.hypot(width, depth),
      groupId: instance.groupId ?? undefined,
      bundleId: instance.bundleId ?? undefined,
      zMin: z - height / 2,
      zMax: z + height / 2,
    });
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const clusters = clusterArrivals(items);
  const picked = reducedMotion
    ? { fogged: [], plain: clusters }
    : pickFogClusters(clusters, aliveFogCount, anchor);
  const foggedKeys = new Set(picked.fogged.map((cluster) => cluster.key));

  const states = []; // clusters still arriving
  const stateById = new Map();
  let disposed = false;
  let fogsCreated = 0;
  let finished = 0;

  clusters.forEach((cluster, index) => {
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const id of cluster.ids) {
      const item = byId.get(id);
      zMin = Math.min(zMin, item.zMin);
      zMax = Math.max(zMax, item.zMax);
    }
    const state = {
      pending: new Set(cluster.ids),
      dissolves: [],
      readyAtMs: null,
      fog: null,
    };
    if (foggedKeys.has(cluster.key)) {
      const extent = { width: 2 * cluster.halfX, depth: 2 * cluster.halfY, height: Math.max(1, zMax - zMin) };
      // The fog floats over the cluster rather than being centred on its floor:
      // lifted by about a puff's radius (see createArrivalFog's puff size) so
      // no puff dips below the ground, where it would be cut off in a hard line.
      const lift = 0.65 * Math.max(1.5, 0.6 * Math.max(extent.width, extent.depth, extent.height));
      state.fog = effects.createFog({
        center: { x: cluster.x, y: cluster.y, z: zMin + lift },
        extent,
        seed: index,
      });
      state.fog.setLevel(0);
      parent.add(state.fog.object);
      aliveFogCount += 1;
      fogsCreated += 1;
    }
    states.push(state);
    for (const id of cluster.ids) stateById.set(id, state);
  });

  function levelsFor(state, nowMs) {
    const ageS = (nowMs - startMs) / 1000;
    const readyAgeS = state.readyAtMs === null ? null : (state.readyAtMs - startMs) / 1000;
    return arrivalLevels(ageS, readyAgeS, { reducedMotion, fog: state.fog !== null });
  }

  function finish(state) {
    if (state.fog) {
      state.fog.dispose();
      state.fog = null;
      aliveFogCount -= 1;
    }
    for (const dissolve of state.dissolves) dissolve.restore();
    state.dissolves.length = 0;
    const at = states.indexOf(state);
    if (at >= 0) states.splice(at, 1);
    finished += 1;
  }

  function markSettled(id) {
    const state = stateById.get(id);
    if (!state) return null;
    state.pending.delete(id);
    if (state.pending.size === 0 && state.readyAtMs === null) state.readyAtMs = clock();
    return state;
  }

  return {
    itemReady(id, object) {
      if (disposed) return;
      const state = stateById.get(id);
      if (!state) return;
      const dissolve = effects.createDissolve(object);
      state.dissolves.push(dissolve);
      dissolve.setLevel(0);
      markSettled(id);
    },
    itemSettled(id) {
      if (disposed) return;
      markSettled(id);
    },
    update() {
      if (disposed || states.length === 0) return;
      const nowMs = clock();
      for (const state of [...states]) {
        if (state.readyAtMs === null && (nowMs - startMs) / 1000 > ARRIVAL_MAX_WAIT_S) state.readyAtMs = nowMs;
        const levels = levelsFor(state, nowMs);
        if (state.fog) state.fog.setLevel(levels.fog);
        for (const dissolve of state.dissolves) dissolve.setLevel(levels.item);
        if (levels.done) finish(state);
      }
    },
    // #3479: true once every cluster has finished arriving (fog gone, plain
    // materials back): the landlet is fully drawn as itself. A landlet with
    // nothing to show is settled at once.
    settled() {
      return disposed || states.length === 0;
    },
    // Releases every fog and puts every original material back. Safe to call
    // twice, and after items have arrived.
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of [...states]) finish(state);
    },
    stats() {
      return {
        clusters: clusters.length,
        fogsCreated,
        fogsAlive: states.filter((state) => state.fog).length,
        arriving: states.length,
        dissolving: states.reduce((sum, state) => sum + state.dissolves.length, 0),
        finished,
        disposed,
      };
    },
  };
}
