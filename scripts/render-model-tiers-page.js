// Browser side of scripts/render-model-tiers.mjs (#4111, point 2): draws a model and one of its cheaper versions
// from the six axes under the Shop's own lights (src/main.js: ambient 0.6, sun 1.2 from (20, 10, 30)) at the size
// they are swapped at on screen, and compares the two pictures pixel by pixel. Unlike src/tierFidelity.js, which
// reads colours from the file's own numbers, this reads what is drawn, textures included.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildModelTiers } from '../src/modelTiers.js';

function parse(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new GLTFLoader().parseAsync(bytes.buffer, '').then((gltf) => gltf.scene);
}

const VIEWS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const UPS = [[0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];

async function compareObjects(full, tier, sizePx, wantStills) {
  const box = new THREE.Box3().setFromObject(full);
  box.union(new THREE.Box3().setFromObject(tier));
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(sizePx, sizePx, false);
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(20, 10, 30);
  scene.add(sun);
  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 4);
  const gl = renderer.getContext();
  const read = (model) => {
    scene.add(model);
    renderer.render(scene, camera);
    scene.remove(model);
    const pixels = new Uint8Array(sizePx * sizePx * 4);
    gl.readPixels(0, 0, sizePx, sizePx, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  const stills = [];
  // A still is the full model on the left and its cheaper version on the right at the size they are swapped at,
  // enlarged without smoothing so a person can read the pixels the shopper would get.
  const STILL_SCALE = 6;
  const copyTo = (sheet, slot) => {
    const ctx = sheet.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, slot * sizePx * STILL_SCALE, 0, sizePx * STILL_SCALE, sizePx * STILL_SCALE);
  };
  const views = [];
  let worstColour = 0;
  let worstPixels = 0;
  VIEWS.forEach((dir, i) => {
    camera.position.set(centre.x + dir[0] * radius * 2, centre.y + dir[1] * radius * 2, centre.z + dir[2] * radius * 2);
    camera.up.set(...UPS[i]);
    camera.lookAt(centre);
    camera.updateProjectionMatrix();
    let sheet = null;
    if (wantStills) {
      sheet = document.createElement('canvas');
      sheet.width = sizePx * STILL_SCALE * 2;
      sheet.height = sizePx * STILL_SCALE;
      const bg = sheet.getContext('2d');
      bg.fillStyle = '#cfd8c4';
      bg.fillRect(0, 0, sheet.width, sheet.height);
    }
    const a = read(full);
    if (sheet) copyTo(sheet, 0);
    const b = read(tier);
    if (sheet) { copyTo(sheet, 1); stills.push({ view: i, png: sheet.toDataURL('image/png') }); }
    let covered = 0;
    let diff = 0;
    const meanA = [0, 0, 0];
    const meanB = [0, 0, 0];
    let countA = 0;
    let countB = 0;
    for (let p = 0; p < a.length; p += 4) {
      const inA = a[p + 3] > 127;
      const inB = b[p + 3] > 127;
      if (inA) { countA++; for (let k = 0; k < 3; k++) meanA[k] += a[p + k]; }
      if (inB) { countB++; for (let k = 0; k < 3; k++) meanB[k] += b[p + k]; }
      if (inA || inB) {
        covered++;
        const ra = inA ? [a[p], a[p + 1], a[p + 2]] : [255, 255, 255];
        const rb = inB ? [b[p], b[p + 1], b[p + 2]] : [255, 255, 255];
        diff += (Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]) + Math.abs(ra[2] - rb[2])) / (3 * 255);
      }
    }
    if (!countA) return;
    const colourShift = countB ? Math.max(...meanA.map((v, k) => Math.abs(v / countA - meanB[k] / countB) / 255)) : 1;
    const pixelDiff = covered ? diff / covered : 0;
    worstColour = Math.max(worstColour, colourShift);
    worstPixels = Math.max(worstPixels, pixelDiff);
    views.push({ view: i, colourShift: +colourShift.toFixed(3), pixelDiff: +pixelDiff.toFixed(3), coveredA: countA, coveredB: countB });
  });
  renderer.dispose();
  return { colourShift: +worstColour.toFixed(3), pixelDiff: +worstPixels.toFixed(3), views, stills };
}

window.compareRendered = async (fullBase64, tierBase64, sizePx, wantStills = false) => {
  return compareObjects(await parse(fullBase64), await parse(tierBase64), sizePx, wantStills);
};

// --regenerate: the versions the current src/modelTiers.js would make from this full model (not the stored ones),
// compared the same way, so a change to the generator can be looked at before anything is regenerated or stored.
window.compareGenerated = async (fullBase64, sizes, wantStills = false) => {
  const model = await parse(fullBase64);
  const { mid, far, stats } = await buildModelTiers(model);
  const out = { stats };
  for (const [tier, version] of [['mid', mid], ['far', far]]) {
    if (!version || version.sharesFullModel) { out[tier] = { sharesFullModel: true }; continue; }
    out[tier] = await compareObjects(await parse(fullBase64), version.object, sizes[tier], wantStills);
  }
  return out;
};

window.renderTiersReady = true;
