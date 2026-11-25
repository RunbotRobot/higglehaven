// #4366 slice 1: the geometry step behind a loose set's own versions. Members of a set share one geometry and
// differ only by their placement; this puts them in one position-only shell and drops every face that meets
// another member's face exactly, because nobody can see a face that is pressed against another. No DOM and no
// scene: runs in the browser, node and the test runtime, and is not wired into drawing yet (later slices:
// colour and shading, the outline check, the set signature cache, the per-frame build budget).
//
// A "face" is one triangle, or two coplanar triangles that share an edge and together make a four-cornered
// piece (a box side is cut along one diagonal on one side and the other diagonal on the opposite side, so
// matching single triangles finds nothing on boxes). Two faces are a pair when they have the same corners and
// point opposite ways.
//
// Correctness first: a face is dropped only when its exact partner is found, so a shell that cannot find a
// partner (a gap, a half-shifted neighbour, a rotated one, an ambiguous patch of many coplanar triangles) keeps
// the face. The result is never missing a face a person could see; it may keep more than the ideal.
import { Vector3 } from 'three';

// One grid cell is a ten-thousandth of a unit; corners closer than that count as the same corner.
const QUANTUM = 1e-4;
const q = (v) => Math.round(v / QUANTUM);
const cornerKey = (p) => `${q(p.x)},${q(p.y)},${q(p.z)}`;
const dirKey = (n) => `${Math.round(n.x * 1000)},${Math.round(n.y * 1000)},${Math.round(n.z * 1000)}`;
const oppositeDirKey = (n) => dirKey({ x: -n.x, y: -n.y, z: -n.z });

// matrices: THREE.Matrix4[], one per member (the member's placement). A member whose matrix flips handedness
// (a negative scale) has its winding put right.
export function mergeMemberShell(geometry, matrices) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const triangleCount = Math.floor(count / 3);
  const inputTriangles = triangleCount * matrices.length;
  const positions = new Float32Array(inputTriangles * 9);
  const dropped = new Uint8Array(inputTriangles);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), e1 = new Vector3(), e2 = new Vector3();
  // faces seen so far: sorted corner key -> [{ dirKey, oppositeKey, slots }]
  const seen = new Map();
  let slot = 0;
  for (const matrix of matrices) {
    const flips = matrix.determinant() < 0;
    const first = slot;
    const info = [];
    for (let t = 0; t < triangleCount; t++, slot++) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(matrix);
      b.fromBufferAttribute(pos, ib).applyMatrix4(matrix);
      c.fromBufferAttribute(pos, ic).applyMatrix4(matrix);
      // A flipped placement is written the other way round so the face still points outward.
      const [p1, p2, p3] = flips ? [a, c, b] : [a, b, c];
      const base = slot * 9;
      p1.toArray(positions, base); p2.toArray(positions, base + 3); p3.toArray(positions, base + 6);
      e1.subVectors(p2, p1); e2.subVectors(p3, p1);
      const n = new Vector3().crossVectors(e1, e2);
      const len = n.length();
      if (len > 0) n.divideScalar(len);
      info.push({ slot, keys: [cornerKey(p1), cornerKey(p2), cornerKey(p3)], n, len });
    }
    // Faces of this member: pair coplanar triangles that share exactly one edge and together have four
    // corners, when each has no other such candidate (an ambiguous patch stays as single triangles).
    const candidates = info.map(() => []);
    for (let i = 0; i < info.length; i++) {
      for (let j = i + 1; j < info.length; j++) {
        if (dirKey(info[i].n) !== dirKey(info[j].n)) continue;
        const shared = info[i].keys.filter((k) => info[j].keys.includes(k));
        if (shared.length === 2) { candidates[i].push(j); candidates[j].push(i); }
      }
    }
    const used = new Set();
    const faces = [];
    for (let i = 0; i < info.length; i++) {
      if (used.has(i)) continue;
      if (candidates[i].length === 1 && candidates[candidates[i][0]].length === 1) {
        const j = candidates[i][0];
        used.add(i); used.add(j);
        faces.push({ tris: [i, j], keys: [...new Set([...info[i].keys, ...info[j].keys])], n: info[i].n });
      }
    }
    for (let i = 0; i < info.length; i++) {
      if (!used.has(i)) faces.push({ tris: [i], keys: info[i].keys, n: info[i].n });
    }
    for (const face of faces) {
      const slots = face.tris.map((t) => first + t);
      const key = [...face.keys].sort().join('|');
      const mine = dirKey(face.n);
      const list = seen.get(key);
      const partnerAt = list ? list.findIndex((entry) => entry.dirKey === oppositeDirKey(face.n)) : -1;
      if (partnerAt >= 0) {
        const [partner] = list.splice(partnerAt, 1);
        for (const s of partner.slots) dropped[s] = 1;
        for (const s of slots) dropped[s] = 1;
      } else if (list) list.push({ dirKey: mine, slots });
      else seen.set(key, [{ dirKey: mine, slots }]);
    }
  }
  let kept = 0;
  const out = new Float32Array(inputTriangles * 9);
  for (let s = 0; s < inputTriangles; s++) {
    if (dropped[s]) continue;
    out.set(positions.subarray(s * 9, s * 9 + 9), kept * 9);
    kept++;
  }
  return {
    positions: out.slice(0, kept * 9),
    inputTriangles,
    triangles: kept,
    droppedTriangles: inputTriangles - kept,
  };
}
