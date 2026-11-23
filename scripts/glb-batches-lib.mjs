// #4062: reads a .glb's triangles as flat batches (src/tierFidelity.js's shape) without three.js or a
// canvas, in the model's own root space (node transforms applied). Enough of glTF for what the app stores:
// triangle-list primitives with POSITION (float) and an optional index (u8/u16/u32), nodes with matrix or
// translation/rotation/scale. Anything else (skinned, sparse, strips, compressed) is reported as unsupported.
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function mat4Multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function composeTrs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
    (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
    (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function readGlbJson(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(Buffer.from(buffer.buffer, buffer.byteOffset + start, length).toString('utf8'));
    else if (type === 0x004e4942 && !bin) bin = new Uint8Array(buffer.buffer, buffer.byteOffset + start, length);
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('glb has no json chunk');
  return { json, bin };
}

function readAccessor(json, bin, index, asIndices) {
  const acc = json.accessors[index];
  if (acc.sparse) throw new Error('unsupported: sparse accessor');
  const view = json.bufferViews[acc.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const size = COMPONENT_SIZE[acc.componentType];
  const stride = view.byteStride || comps * size;
  const base = bin.byteOffset + (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bin.buffer);
  const out = asIndices ? new Uint32Array(acc.count) : new Float32Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const at = base + i * stride + c * size;
      let v;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(at, true); break;
        case 5125: v = dv.getUint32(at, true); break;
        case 5123: v = dv.getUint16(at, true); break;
        case 5121: v = dv.getUint8(at); break;
        default: throw new Error(`unsupported component type ${acc.componentType}`);
      }
      out[i * comps + c] = v;
    }
  }
  return out;
}

// { batches: [{ positions, doubleSided }], triangles } for the default scene.
export function glbBatches(buffer) {
  const { json, bin } = readGlbJson(buffer);
  const batches = [];
  let triangles = 0;
  const visit = (nodeIndex, parent) => {
    const node = json.nodes[nodeIndex];
    const local = node.matrix ? node.matrix : composeTrs(node.translation, node.rotation, node.scale);
    const world = mat4Multiply(parent, local);
    if (node.skin !== undefined) throw new Error('unsupported: skinned');
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) throw new Error('unsupported: primitive mode');
        const pos = readAccessor(json, bin, prim.attributes.POSITION, false);
        const idx = prim.indices !== undefined ? readAccessor(json, bin, prim.indices, true) : null;
        const count = idx ? idx.length : pos.length / 3;
        const out = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const v = idx ? idx[i] : i;
          const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
          out[i * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
          out[i * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
          out[i * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
        }
        // A mirrored transform flips the winding; flip it back so "front" means what the viewer sees.
        const det = world[0] * (world[5] * world[10] - world[6] * world[9]) - world[4] * (world[1] * world[10] - world[2] * world[9]) + world[8] * (world[1] * world[6] - world[2] * world[5]);
        if (det < 0) for (let t = 0; t + 8 < out.length; t += 9) for (let k = 0; k < 3; k++) { const tmp = out[t + 3 + k]; out[t + 3 + k] = out[t + 6 + k]; out[t + 6 + k] = tmp; }
        const material = prim.material !== undefined ? json.materials[prim.material] : null;
        batches.push({ positions: out, doubleSided: Boolean(material && material.doubleSided) });
        triangles += count / 3;
      }
    }
    for (const child of node.children || []) visit(child, world);
  };
  const scene = json.scenes[json.scene ?? 0];
  for (const root of scene.nodes) visit(root, IDENTITY);
  return { batches, triangles };
}
