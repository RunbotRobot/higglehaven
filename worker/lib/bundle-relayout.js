// #3329 (leaf 6/7 of #3323): when the creator edits a saved bundle, every
// placement linked to it is laid out again from the new members.
//
// A placement is "the template's members, moved and turned". The only way a
// builder can move a placed bundle as a unit is to drag it (a translation) or
// rotate it (leaf 2/7, #3325), so the transform to recover is a yaw about the
// vertical axis plus a translation. Anything else (a member nudged by hand, a
// tilt about a horizontal axis, a member deleted) no longer matches the
// template, and that placement is detached instead of guessed at: the
// builder keeps exactly what they have, as an ordinary bundle of their own,
// and is told ("No silent loss"; "The builder has full information and full
// autonomy over anything that happens on their landlet").
//
// Everything here is pure maths over plain objects so it is unit-testable
// without a database. The database half is in worker/lib/auctions.js.

const POSITION_TOLERANCE_M = 5e-3;
// Two unit quaternions describe the same orientation when |dot| is near 1.
const ORIENTATION_DOT_MIN = 1 - 1e-5;
const GRID_M = 0.05;
// Hard stop for one placement's search, so a pathological layout cannot spend
// a request's CPU budget; hitting it detaches the placement like a mismatch.
const MAX_SEARCH_OPS = 400000;

// Euler XYZ (three.js's default order, which the Build scene uses for
// mesh.rotation) <-> quaternion.
export function quatFromEuler(x, y, z) {
  const c1 = Math.cos(x / 2); const c2 = Math.cos(y / 2); const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2); const s2 = Math.sin(y / 2); const s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

export function eulerFromQuat(q) {
  const { x, y, z, w } = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return { x: Math.atan2(-m23, m33), y: ey, z: Math.atan2(-m12, m11) };
  }
  return { x: Math.atan2(m32, m22), y: ey, z: 0 };
}

function quatMul(a, b) {
  return {
    x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quatConjugate(q) {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function yawQuat(theta) {
  return { x: 0, y: 0, z: Math.sin(theta / 2), w: Math.cos(theta / 2) };
}

// A yaw of `theta` about the vertical axis, applied to the horizontal offset
// (dx, dy). Positive theta is counter-clockwise seen from above, the same
// sense as mesh.rotation.z.
function rotateXY(dx, dy, theta) {
  const c = Math.cos(theta); const s = Math.sin(theta);
  return { x: c * dx - s * dy, y: s * dx + c * dy };
}

// Item (template frame) -> the orientation it has once the placement is yawed.
function orientationFor(item, theta) {
  const q = quatMul(yawQuat(theta), quatFromEuler(item.rotationX ?? 0, item.rotationY ?? 0, item.rotationZ ?? 0));
  return eulerFromQuat(q);
}

const cellOf = (v) => Math.round(v / GRID_M);

// rows: [{ id, templateId, x, y, z, rotationX, rotationY, rotationZ, scale }]
// items: the template's members the rows are supposed to be.
// Returns { theta, tx, ty, tz, pairs: Map<itemIndex, rowId> } or null when the
// rows are not exactly the items under a yaw + translation.
//   world position = (tx, ty, tz + dz) + Rz(theta) * (dx, dy)
export function findPlacementTransform(items, rows) {
  if (items.length === 0 || items.length !== rows.length) return null;
  const itemQuats = items.map((item) => quatFromEuler(item.rotationX ?? 0, item.rotationY ?? 0, item.rotationZ ?? 0));
  const rowQuats = rows.map((row) => quatFromEuler(row.rotationX, row.rotationY, row.rotationZ));

  const rowsByTemplate = new Map();
  rows.forEach((row, index) => {
    if (!rowsByTemplate.has(row.templateId)) rowsByTemplate.set(row.templateId, []);
    rowsByTemplate.get(row.templateId).push(index);
  });
  // The template mix has to match before any geometry is tried.
  const itemCounts = new Map();
  for (const item of items) itemCounts.set(item.templateId, (itemCounts.get(item.templateId) ?? 0) + 1);
  for (const [templateId, count] of itemCounts) {
    if ((rowsByTemplate.get(templateId)?.length ?? 0) !== count) return null;
  }

  // Pivot on the rarest product, so the fewest candidate rows are tried.
  let pivotIndex = 0;
  for (let i = 1; i < items.length; i += 1) {
    if (itemCounts.get(items[i].templateId) < itemCounts.get(items[pivotIndex].templateId)) pivotIndex = i;
  }
  const pivot = items[pivotIndex];
  // Check the members farthest from the pivot first: a wrong candidate then
  // fails on its first or second check instead of after matching most of them.
  const checkOrder = items.map((_, i) => i).filter((i) => i !== pivotIndex).sort((a, b) => {
    const da = (items[a].dx - pivot.dx) ** 2 + (items[a].dy - pivot.dy) ** 2;
    const db = (items[b].dx - pivot.dx) ** 2 + (items[b].dy - pivot.dy) ** 2;
    return db - da;
  });

  const grid = new Map();
  rows.forEach((row, index) => {
    const key = `${row.templateId}|${cellOf(row.x)}|${cellOf(row.y)}|${cellOf(row.z)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });

  let ops = 0;
  const findRow = (item, itemIndex, theta, tx, ty, tz, used) => {
    const o = rotateXY(item.dx, item.dy, theta);
    const x = tx + o.x; const y = ty + o.y; const z = tz + item.dz;
    const wantQuat = quatMul(yawQuat(theta), itemQuats[itemIndex]);
    const cx = cellOf(x); const cy = cellOf(y); const cz = cellOf(z);
    for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
      for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
        for (let iz = cz - 1; iz <= cz + 1; iz += 1) {
          const bucket = grid.get(`${item.templateId}|${ix}|${iy}|${iz}`);
          if (!bucket) continue;
          for (const rowIndex of bucket) {
            ops += 1;
            if (used.has(rowIndex)) continue;
            const row = rows[rowIndex];
            if (Math.abs(row.x - x) > POSITION_TOLERANCE_M || Math.abs(row.y - y) > POSITION_TOLERANCE_M
              || Math.abs(row.z - z) > POSITION_TOLERANCE_M) continue;
            if (Math.abs((row.scale ?? 1) - (item.scale ?? 1)) > 1e-6) continue;
            const q = rowQuats[rowIndex];
            const dot = Math.abs(q.x * wantQuat.x + q.y * wantQuat.y + q.z * wantQuat.z + q.w * wantQuat.w);
            if (dot < ORIENTATION_DOT_MIN) continue;
            return rowIndex;
          }
        }
      }
    }
    return -1;
  };

  const pivotQuatInv = quatConjugate(itemQuats[pivotIndex]);
  for (const candidate of rowsByTemplate.get(pivot.templateId)) {
    if (Math.abs((rows[candidate].scale ?? 1) - (pivot.scale ?? 1)) > 1e-6) continue;
    // The candidate's orientation relative to the pivot's must be a pure yaw.
    const rel = quatMul(rowQuats[candidate], pivotQuatInv);
    if (Math.abs(rel.x) > 1e-4 || Math.abs(rel.y) > 1e-4) continue;
    const theta = 2 * Math.atan2(rel.z, rel.w);
    const o = rotateXY(pivot.dx, pivot.dy, theta);
    const tx = rows[candidate].x - o.x;
    const ty = rows[candidate].y - o.y;
    const tz = rows[candidate].z - pivot.dz;
    const used = new Set([candidate]);
    const pairs = new Map([[pivotIndex, rows[candidate].id]]);
    let ok = true;
    for (const itemIndex of checkOrder) {
      if (ops > MAX_SEARCH_OPS) return null;
      const rowIndex = findRow(items[itemIndex], itemIndex, theta, tx, ty, tz, used);
      if (rowIndex < 0) { ok = false; break; }
      used.add(rowIndex);
      pairs.set(itemIndex, rows[rowIndex].id);
    }
    if (ok) return { theta, tx, ty, tz, pairs };
    if (ops > MAX_SEARCH_OPS) return null;
  }
  return null;
}

// The world-space member list a placement with `transform` shows for `items`.
export function layOutItems(items, transform) {
  return items.map((item) => {
    const o = rotateXY(item.dx, item.dy, transform.theta);
    const e = orientationFor(item, transform.theta);
    return {
      templateId: item.templateId,
      x: transform.tx + o.x,
      y: transform.ty + o.y,
      z: transform.tz + item.dz,
      rotationX: e.x,
      rotationY: e.y,
      rotationZ: e.z,
      crop: item.crop ?? {},
      scale: item.scale ?? 1,
    };
  });
}

// Turns a member list given in a placement's own (yawed) frame back into the
// template frame by undoing `theta`. Offsets are relative to the list's own
// centroid, which a rotation about the vertical axis leaves at zero, so no
// re-centering is needed.
export function unyawItems(items, theta) {
  if (!theta) return items;
  return items.map((item) => {
    const o = rotateXY(item.dx, item.dy, -theta);
    const q = quatMul(yawQuat(-theta), quatFromEuler(item.rotationX ?? 0, item.rotationY ?? 0, item.rotationZ ?? 0));
    const e = eulerFromQuat(q);
    return { ...item, dx: o.x, dy: o.y, rotationX: e.x, rotationY: e.y, rotationZ: e.z };
  });
}
