// #3405 (leaf 1 of #3397): the pure core of "things arrive in the world
// through fog; nothing pops in". No three.js, no DOM, so it is unit-testable
// (src/shop/arrivalFog.test.js) and shared by the fog effect (#3406) and the
// Shop loader wiring (#3407).
//
// The idea: the moment a landlet's instance list arrives the client already
// knows where every item will be, long before any model is built. A soft fog
// rises over each cluster of items at once; each cluster resolves out of its
// fog as it becomes ready. One fog per cluster, never per item: an 829-brick
// wall is one cluster, one fog.

// --- Timeline constants (tuned by eye; the first version is expected to be
// retuned once the owner has seen it) ---

// Fog rising over the spot, from the moment the instance list arrives.
export const ARRIVAL_FOG_RISE_S = 0.5;
// From the moment the cluster is ready (and the fog has risen) the items
// dissolve in while the fog thins and clears: about a second in all.
export const ARRIVAL_RESOLVE_S = 1.0;
// prefers-reduced-motion: no fog, just a short plain fade of the items.
export const ARRIVAL_REDUCED_MOTION_FADE_S = 0.25;

// --- Clustering and cap constants ---

// Scattered items (no bundle) join a cluster when they are this close to its
// centre, and a cluster never grows wider than the span below, so one fog is
// never a smear across half a landlet.
export const ARRIVAL_CLUSTER_RADIUS_M = 6;
export const ARRIVAL_CLUSTER_MAX_SPAN_M = 14;
// How far the fog extends past its cluster's extent.
export const ARRIVAL_FOG_MARGIN_M = 1.5;
// The most fogs alive at once across the whole scene. Clusters past it skip
// the fog and use the plain dissolve (the same fade, no fog), so a busy
// landlet or a high flight over many landlets stays cheap on a phone.
export const ARRIVAL_MAX_ALIVE_FOGS = 12;

function finite(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n) {
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
}

function smoothstep(t) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

function emptyBox() {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
}

function growBox(box, x, y) {
  box.minX = Math.min(box.minX, x);
  box.maxX = Math.max(box.maxX, x);
  box.minY = Math.min(box.minY, y);
  box.maxY = Math.max(box.maxY, y);
}

function newCluster(key) {
  return { key, ids: [], box: emptyBox(), sumX: 0, sumY: 0 };
}

function addToCluster(cluster, item) {
  const x = finite(item.x);
  const y = finite(item.y);
  cluster.ids.push(item.id);
  cluster.sumX += x;
  cluster.sumY += y;
  // Half the item's footprint, when the caller knows it, so a big item's
  // fog covers the item and not just its centre point.
  const hw = finite(item.halfWidth);
  const hd = finite(item.halfDepth);
  growBox(cluster.box, x - hw, y - hd);
  growBox(cluster.box, x + hw, y + hd);
}

function finishCluster(cluster) {
  const n = cluster.ids.length;
  const { box } = cluster;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const halfSpanX = (box.maxX - box.minX) / 2 + ARRIVAL_FOG_MARGIN_M;
  const halfSpanY = (box.maxY - box.minY) / 2 + ARRIVAL_FOG_MARGIN_M;
  return {
    key: cluster.key,
    ids: cluster.ids,
    count: n,
    // Centre of the extent (what the fog is centred on), not the mean of the
    // item positions, so a dense corner doesn't drag the fog off the wall.
    x: cx,
    y: cy,
    halfX: halfSpanX,
    halfY: halfSpanY,
    box: { ...box },
  };
}

// Would adding (x, y) to a nearness cluster keep it compact?
function fitsNearness(cluster, x, y) {
  const n = cluster.ids.length;
  const mx = cluster.sumX / n;
  const my = cluster.sumY / n;
  if (Math.hypot(x - mx, y - my) > ARRIVAL_CLUSTER_RADIUS_M) return false;
  const spanX = Math.max(cluster.box.maxX, x) - Math.min(cluster.box.minX, x);
  const spanY = Math.max(cluster.box.maxY, y) - Math.min(cluster.box.minY, y);
  return Math.max(spanX, spanY) <= ARRIVAL_CLUSTER_MAX_SPAN_M;
}

// Group a landlet's instances into fog clusters.
//
// items: [{ id, x, y, halfWidth?, halfDepth?, groupId?, bundleId? }]
//   x/y are landlet-local metres (same frame as the instance list).
//
// Rules, in order:
//   1. An item with a groupId clusters with every other item of that groupId:
//      a placed bundle is one item to the person, so it gets one fog however
//      many members it has (the 829-brick wall). groupId, not bundleId, is
//      the key because two copies of one saved bundle on the same landlet
//      share a bundleId but each has its own groupId.
//   2. An item with only a bundleId (no groupId) joins by nearness among the
//      items of that same bundleId.
//   3. Everything else joins by nearness (ARRIVAL_CLUSTER_RADIUS_M, bounded
//      by ARRIVAL_CLUSTER_MAX_SPAN_M).
// Deterministic: items are visited in a stable order (by x, then y, then id)
// so the same instance list always clusters the same way, whatever order the
// server returned it in.
export function clusterArrivals(items) {
  const list = (items || []).filter((it) => it && it.id !== undefined && it.id !== null);
  list.sort((a, b) => finite(a.x) - finite(b.x) || finite(a.y) - finite(b.y)
    || String(a.id).localeCompare(String(b.id)));
  const byGroup = new Map();
  const nearness = new Map(); // bucket ('' or 'b:<bundleId>') -> cluster[]
  const out = [];
  for (const item of list) {
    if (item.groupId !== undefined && item.groupId !== null) {
      const key = `g:${item.groupId}`;
      let cluster = byGroup.get(key);
      if (!cluster) {
        cluster = newCluster(key);
        byGroup.set(key, cluster);
        out.push(cluster);
      }
      addToCluster(cluster, item);
      continue;
    }
    const bucket = item.bundleId !== undefined && item.bundleId !== null ? `b:${item.bundleId}` : '';
    let clusters = nearness.get(bucket);
    if (!clusters) {
      clusters = [];
      nearness.set(bucket, clusters);
    }
    const x = finite(item.x);
    const y = finite(item.y);
    let target = clusters.find((c) => fitsNearness(c, x, y));
    if (!target) {
      target = newCluster(`${bucket || 'n'}#${clusters.length}`);
      clusters.push(target);
      out.push(target);
    }
    addToCluster(target, item);
  }
  return out.map(finishCluster);
}

// Decide which clusters get a fog right now and which use the plain dissolve.
//   aliveFogs: how many fogs are already alive (from earlier landlets).
//   anchor:    { x, y } in the same frame as the clusters (nearest first).
// The cap is ARRIVAL_MAX_ALIVE_FOGS across the whole scene, not per landlet.
export function pickFogClusters(clusters, aliveFogs, anchor, cap = ARRIVAL_MAX_ALIVE_FOGS) {
  const free = Math.max(0, cap - Math.max(0, Math.floor(finite(aliveFogs))));
  const ax = finite(anchor?.x);
  const ay = finite(anchor?.y);
  const ranked = [...(clusters || [])].sort((a, b) => Math.hypot(a.x - ax, a.y - ay)
    - Math.hypot(b.x - ax, b.y - ay) || String(a.key).localeCompare(String(b.key)));
  return { fogged: ranked.slice(0, free), plain: ranked.slice(free) };
}

// One cluster's arrival at a point in time.
//   ageS:      seconds since the instance list arrived (fog starts here).
//   readyAgeS: seconds-since-arrival at which the cluster became ready to
//              show, or null/undefined while it is still building.
//   opts.reducedMotion: skip the fog and just fade.
//   opts.fog: false for a cluster over the fog cap (plain dissolve, no fog).
// Returns { fog, item, done }: fog 0..1 (how thick), item 0..1 (how opaque),
// done true once everything is at rest (fog gone, item fully opaque) so the
// caller can dispose the fog and restore the plain materials.
export function arrivalLevels(ageS, readyAgeS, opts = {}) {
  const age = Math.max(0, finite(ageS));
  const ready = readyAgeS === null || readyAgeS === undefined ? null : Math.max(0, finite(readyAgeS));
  if (opts.reducedMotion) {
    if (ready === null) return { fog: 0, item: 0, done: false };
    const t = clamp01((age - ready) / ARRIVAL_REDUCED_MOTION_FADE_S);
    return { fog: 0, item: t, done: t >= 1 };
  }
  const withFog = opts.fog !== false;
  const fogIn = withFog ? smoothstep(age / ARRIVAL_FOG_RISE_S) : 0;
  if (ready === null) return { fog: fogIn, item: 0, done: false };
  // The item waits for the fog to have risen, so it is never seen before
  // there is something to resolve out of.
  const start = withFog ? Math.max(ready, ARRIVAL_FOG_RISE_S) : ready;
  const p = clamp01((age - start) / ARRIVAL_RESOLVE_S);
  const eased = smoothstep(p);
  return { fog: fogIn * (1 - eased), item: eased, done: p >= 1 };
}
