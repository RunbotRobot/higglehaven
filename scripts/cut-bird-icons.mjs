// #3369: cuts the owner-supplied fly-button artwork down to just the bird on a
// transparent background, so the button can show it with object-fit: contain
// and no zoom/crop machinery (#1815, #2750 -- the PNGs bake in a cream card and
// an embossed ring, and cropping that ring out by zooming always clipped some
// other part of the bird).
//
// Usage: node scripts/cut-bird-icons.mjs
//   reads  art/bird-standing-original.png, art/bird-flying-original.png
//   writes public/bird-standing.png,       public/bird-flying.png
// To swap the artwork: replace the two originals in art/ and re-run this.
// Uses sharp (already in the lockfile as a dev dependency).
//
// Method: flood-fill from the canvas border through light, low-saturation
// pixels (the cream card, its ring and the circle fill). The bird's dark
// outline stops the fill, so its white belly survives. Edge pixels next to the
// removed background get a soft alpha by unmixing against the card colour, so
// there is no cream halo on the button's white or green backdrop. The result is
// centred and padded to a square whose inscribed circle holds every opaque
// pixel with BIRD_ICON_MARGIN to spare, so the button needs no zoom.
import sharp from 'sharp';

export const BIRD_ICON_SIZE_PX = 256;
// Fraction of the circle's radius left empty beyond the farthest bird pixel.
export const BIRD_ICON_MARGIN = 0.09;

const LIGHT_MIN = 200; // a background pixel's darkest channel is at least this
const SATURATION_MAX = 45; // ... and its channels differ by at most this
const POCKET_TOLERANCE = 9; // colour distance from the card for an enclosed pocket
const POCKET_MIN_PIXELS = 60; // ignore specks
const POCKET_LIGHT_BOUNDARY = 240; // a boundary pixel this light and ...
const POCKET_WHITE_WARMTH_MAX = 6; // ... this neutral (red minus blue) is the bird's own white, not a cream edge mix
const POCKET_LIGHT_BOUNDARY_MAX_SHARE = 0.1;
const OUTLINE = [60, 40, 30]; // the bird's dark outline, the "fully opaque" end of the unmix

function isBackground(r, g, b) {
  return Math.min(r, g, b) >= LIGHT_MIN && Math.max(r, g, b) - Math.min(r, g, b) <= SATURATION_MAX;
}

export async function cutBird(inputPath) {
  const { data, info } = await sharp(inputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const at = (x, y) => (y * width + x) * 3;
  const bg = new Uint8Array(width * height); // 1 = removed background
  const stack = [];
  const push = (x, y) => {
    const i = y * width + x;
    if (bg[i]) return;
    const p = at(x, y);
    if (!isBackground(data[p], data[p + 1], data[p + 2])) return;
    bg[i] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }

  // The card colour, averaged over the removed pixels touching the bird.
  let sr = 0, sg = 0, sb = 0, n = 0;
  const touchesBird = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && !bg[ny * width + nx]) return true;
    }
    return false;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (bg[y * width + x] && touchesBird(x, y)) { const p = at(x, y); sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; n++; }
  }
  const card = [sr / n, sg / n, sb / n];
  const span = Math.hypot(OUTLINE[0] - card[0], OUTLINE[1] - card[1], OUTLINE[2] - card[2]);

  // Pockets of card colour the border fill could not reach (the gap between the
  // legs and the branch) are enclosed background too. Only pixels close to the
  // measured card colour qualify, so the whiter belly is left alone.
  const nearCard = (x, y) => {
    const p = at(x, y);
    return Math.hypot(data[p] - card[0], data[p + 1] - card[1], data[p + 2] - card[2]) <= POCKET_TOLERANCE;
  };
  const seen = new Uint8Array(width * height);
  for (let y0 = 0; y0 < height; y0++) for (let x0 = 0; x0 < width; x0++) {
    const i0 = y0 * width + x0;
    if (bg[i0] || seen[i0] || !nearCard(x0, y0)) continue;
    const component = [i0];
    seen[i0] = 1;
    // A real pocket is walled in by the bird's dark outline. A pale patch of
    // the bird itself (shading on the belly) borders other light pixels, so it
    // is told apart by counting light pixels along its boundary.
    let boundary = 0, lightBoundary = 0;
    for (let k = 0; k < component.length; k++) {
      const x = component[k] % width, y = Math.floor(component[k] / width);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (bg[ni] || seen[ni]) continue;
        if (nearCard(nx, ny)) { seen[ni] = 1; component.push(ni); continue; }
        const q = at(nx, ny);
        boundary++;
        if (Math.min(data[q], data[q + 1], data[q + 2]) >= POCKET_LIGHT_BOUNDARY && data[q] - data[q + 2] <= POCKET_WHITE_WARMTH_MAX) lightBoundary++;
      }
    }
    if (component.length >= POCKET_MIN_PIXELS && lightBoundary <= boundary * POCKET_LIGHT_BOUNDARY_MAX_SHARE) for (const i of component) bg[i] = 1;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const p = at(x, y);
    const o = i * 4;
    if (bg[i]) continue; // stays transparent
    let r = data[p], g = data[p + 1], b = data[p + 2], a = 255;
    // Pixels within 2px of the removed background are anti-aliased edge
    // pixels: unmix them against the card colour.
    let nearBg = false;
    for (let dy = -2; dy <= 2 && !nearBg; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height && bg[ny * width + nx]) { nearBg = true; break; }
    }
    if (nearBg) {
      const dist = Math.hypot(r - card[0], g - card[1], b - card[2]);
      const alpha = Math.min(1, dist / span);
      if (alpha < 1) {
        a = Math.round(alpha * 255);
        if (alpha > 0.02) {
          r = Math.max(0, Math.min(255, Math.round((r - (1 - alpha) * card[0]) / alpha)));
          g = Math.max(0, Math.min(255, Math.round((g - (1 - alpha) * card[1]) / alpha)));
          b = Math.max(0, Math.min(255, Math.round((b - (1 - alpha) * card[2]) / alpha)));
        }
      }
    }
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  }

  // Bounding box of the visible bird, then the farthest visible pixel from its
  // centre decides the circle that must hold it.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgba[(y * width + x) * 4 + 3] > 8) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let radius = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (rgba[(y * width + x) * 4 + 3] > 8) radius = Math.max(radius, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  }
  const side = Math.ceil((2 * radius) / (1 - BIRD_ICON_MARGIN));
  const left = Math.round(cx - side / 2), top = Math.round(cy - side / 2);
  // Extract the square (extending past the canvas with transparency where needed).
  const square = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const sx = left + x, sy = top + y;
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    rgba.copy(square, (y * side + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
  }
  return sharp(square, { raw: { width: side, height: side, channels: 4 } })
    .resize(BIRD_ICON_SIZE_PX, BIRD_ICON_SIZE_PX, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const name of ['standing', 'flying']) {
    const out = await cutBird(`art/bird-${name}-original.png`);
    await sharp(out).toFile(`public/bird-${name}.png`);
    console.log(`public/bird-${name}.png written (${out.length} bytes)`);
  }
}
