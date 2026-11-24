// #4063 (part of #3412): loose placements that stand together are one set for drawing, whether or not the
// builder bundled them, and nobody can see that they are. A bundle already changes detail as one set,
// from the set's size on screen, and is protected as a whole when any member is beside the avatar
// (#3443); an unbundled brick was judged by its own few pixels, so a loose wall dropped to its far
// version a few steps away while the same wall bundled held its shape (the owner's recording, #4062).
// This finds those sets. Pure: it takes plain { key, x, y, z, radiusM } items and says which stand together.
//
// Stand together = the same product (key) and touching or within a small gap, joined through any chain of
// neighbours, so a wall, a floor, a fence and a stack each come out as one set. A set larger than
// MAX_SET_EXTENT_M is cut into cells of SPLIT_CELL_M, so one very long fence cannot stay at full detail
// the whole way along because a single post is beside the avatar. Nothing here is stored or shown.

// How far apart (edge to edge) two items of the same product may be and still stand together.
export const SET_GAP_M = 0.3;
// A set whose bounding sphere is wider than this is cut into cells.
export const MAX_SET_RADIUS_M = 30;
export const SPLIT_CELL_M = 20;
export const MIN_SET_MEMBERS = 2;

function find(parent, i) {
  let root = i;
  while (parent[root] !== root) root = parent[root];
  while (parent[i] !== root) {
    const next = parent[i];
    parent[i] = root;
    i = next;
  }
  return root;
}

// `items`: [{ key, x, y, z, radiusM }]. Returns an array of sets, each an array of indices into `items`
// (at least MIN_SET_MEMBERS each), in a stable order. Linear in the number of items (a spatial hash).
export function findImplicitSets(items, { gapM = SET_GAP_M } = {}) {
  const parent = items.map((_, i) => i);
  // The grid is per product: two items of different products never link, so each product's cell is sized
  // by its own largest item, and one big item of one product no longer widens the cell (and the number
  // of neighbours checked) for every other product. The sets that come out, and their order, are the
  // same as one grid for everything: only the items checked against each other changed.
  const maxRadiusByKey = new Map();
  for (const item of items) {
    if (item.radiusM > (maxRadiusByKey.get(item.key) ?? 0)) maxRadiusByKey.set(item.key, item.radiusM);
  }
  const gridByKey = new Map();
  const cellKey = (cx, cy, cz) => `${cx},${cy},${cz}`;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let entry = gridByKey.get(item.key);
    if (!entry) {
      // two items that can link are within one cell of each other
      entry = { cell: Math.max(2 * (maxRadiusByKey.get(item.key) ?? 0) + gapM, 0.1), grid: new Map() };
      gridByKey.set(item.key, entry);
    }
    const { cell, grid } = entry;
    const cx = Math.floor(item.x / cell);
    const cy = Math.floor(item.y / cell);
    const cz = Math.floor(item.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const others = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!others) continue;
          for (const j of others) {
            const other = items[j];
            const reach = item.radiusM + other.radiusM + gapM;
            const ddx = item.x - other.x;
            const ddy = item.y - other.y;
            const ddz = item.z - other.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= reach * reach) {
              const a = find(parent, i);
              const b = find(parent, j);
              if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
            }
          }
        }
      }
    }
    const own = cellKey(cx, cy, cz);
    if (!grid.has(own)) grid.set(own, []);
    grid.get(own).push(i);
  }

  const components = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = find(parent, i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(i);
  }

  const sets = [];
  for (const members of components.values()) {
    if (members.length < MIN_SET_MEMBERS) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const i of members) {
      const m = items[i];
      minX = Math.min(minX, m.x - m.radiusM); maxX = Math.max(maxX, m.x + m.radiusM);
      minY = Math.min(minY, m.y - m.radiusM); maxY = Math.max(maxY, m.y + m.radiusM);
      minZ = Math.min(minZ, m.z - m.radiusM); maxZ = Math.max(maxZ, m.z + m.radiusM);
    }
    const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    if (radius <= MAX_SET_RADIUS_M) {
      sets.push(members);
      continue;
    }
    const cut = new Map();
    for (const i of members) {
      const m = items[i];
      const key = `${Math.floor(m.x / SPLIT_CELL_M)},${Math.floor(m.y / SPLIT_CELL_M)}`;
      if (!cut.has(key)) cut.set(key, []);
      cut.get(key).push(i);
    }
    for (const part of cut.values()) if (part.length >= MIN_SET_MEMBERS) sets.push(part);
  }
  return sets;
}
