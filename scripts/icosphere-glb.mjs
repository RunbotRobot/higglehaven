// #3929: a glTF 2.0 binary of a plain icosphere with a known triangle count (20 * 4^level), written
// without any library. Used by scripts/seed-heavy-landlet.mjs and the Build level-of-detail e2e to get
// a model dense enough to have reduced versions (the repo's own sample models are far too small).
// level 4 = 5,120 triangles, with normals and one orange material.
export function icosphereGlb(level, radius) {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(...v); return v.map((c) => c / l); });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let step = 0; step < level; step++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (cache.has(key)) return cache.get(key);
      const v = vertices[a].map((c, i) => (c + vertices[b][i]) / 2);
      const l = Math.hypot(...v);
      vertices.push(v.map((c) => c / l));
      cache.set(key, vertices.length - 1);
      return vertices.length - 1;
    };
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float32Array(vertices.flatMap((v) => v.map((c) => c * radius)));
  const normals = new Float32Array(vertices.flat());
  const indices = new Uint16Array(faces.flat());
  const pad4 = (n) => (n + 3) & ~3;
  const posBytes = positions.byteLength; const nrmBytes = normals.byteLength; const idxBytes = indices.byteLength;
  const binLength = pad4(posBytes + nrmBytes + idxBytes);
  const min = [-radius, -radius, -radius]; const max = [radius, radius, radius];
  const json = {
    asset: { version: '2.0', generator: 'seed-heavy-landlet' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.85, 0.45, 0.15, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices.length, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: vertices.length, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: idxBytes, target: 34963 },
    ],
    buffers: [{ byteLength: binLength }],
  };
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4) jsonText += ' ';
  const jsonBytes = Buffer.from(jsonText);
  const total = 12 + 8 + jsonBytes.length + 8 + binLength;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(out, 20);
  const binStart = 20 + jsonBytes.length;
  out.writeUInt32LE(binLength, binStart); out.writeUInt32LE(0x004e4942, binStart + 4);
  Buffer.from(positions.buffer).copy(out, binStart + 8);
  Buffer.from(normals.buffer).copy(out, binStart + 8 + posBytes);
  Buffer.from(indices.buffer).copy(out, binStart + 8 + posBytes + nrmBytes);
  return { glb: out, triangles: faces.length };
}

