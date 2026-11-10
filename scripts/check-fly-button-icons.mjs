// #3369: pins the fly button's artwork inside the button's circle. The bird was
// reported clipped by the circle at least three times (#1815, #2750, #3369)
// because the PNGs baked in a ring and the code zoom-cropped it, with nothing
// checking the result. The icons are now the bird alone on a transparent
// background, and this reads their alpha channel: every visible pixel, once the
// button shows the image with object-fit: contain, lies inside the button's
// inscribed circle with room to spare. Runs in `pretest` (it needs real files,
// which the workerd test pool does not have); the geometry is unit-tested in
// check-fly-button-icons.test.mjs.
import { readFileSync } from 'node:fs';

export const BUTTON_PX = 56; // --shop-fly-size in src/app.css
export const CLEARANCE_PX = 2; // the bird must stay at least this far inside the circle
export const MIN_FILL = 0.8; // ... but still fill at least this share of the circle's radius
const VISIBLE_ALPHA = 8;

// data: RGBA bytes of a width x height image. Returns the farthest visible
// pixel from the image centre in button pixels (object-fit: contain on a
// square image fills the square button), the share of visible pixels, and
// whether all four corners are fully transparent.
export function measureIcon({ data, width, height }) {
  const scale = BUTTON_PX / width;
  let farthest = 0;
  let visible = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= VISIBLE_ALPHA) continue;
      visible++;
      farthest = Math.max(farthest, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) * scale);
    }
  }
  const corner = (x, y) => data[(y * width + x) * 4 + 3];
  const cornersEmpty = [corner(0, 0), corner(width - 1, 0), corner(0, height - 1), corner(width - 1, height - 1)].every((a) => a === 0);
  return { farthest, visibleShare: visible / (width * height), cornersEmpty, square: width === height };
}

// Returns a list of human-readable problems (empty when the icon is fine).
export function problemsWith(name, measured) {
  const problems = [];
  if (!measured.square) problems.push(`${name} is not square`);
  if (!measured.cornersEmpty) problems.push(`${name} has opaque corners (a baked-in card, not the bird alone)`);
  if (measured.visibleShare > 0.6) problems.push(`${name} is mostly opaque (${(measured.visibleShare * 100).toFixed(0)}%), so it still carries a backdrop`);
  const limit = BUTTON_PX / 2 - CLEARANCE_PX;
  if (measured.farthest > limit) problems.push(`${name} reaches ${measured.farthest.toFixed(1)}px from the centre at ${BUTTON_PX}px, past the ${limit}px the circle allows`);
  if (measured.farthest < (BUTTON_PX / 2) * MIN_FILL) problems.push(`${name} only reaches ${measured.farthest.toFixed(1)}px; the bird is shrunk to a speck`);
  return problems;
}

async function main() {
  const { default: sharp } = await import('sharp');
  const problems = [];
  for (const name of ['bird-standing.png', 'bird-flying.png']) {
    const { data, info } = await sharp(`public/${name}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    problems.push(...problemsWith(name, measureIcon({ data, width: info.width, height: info.height })));
  }
  // The zoom/crop machinery this replaces must not creep back (#3369).
  const source = readFileSync('src/shop/flightMovement.js', 'utf8');
  if (/shopFlyBtnIcon\.style\.transform/.test(source) || /ICON_(STANDING|FLYING)_(ZOOM|ORIGIN)/.test(source)) {
    problems.push('src/shop/flightMovement.js zooms or offsets the fly-button icon again; fix the artwork (scripts/cut-bird-icons.mjs) instead');
  }
  if (problems.length) {
    console.error(`Fly-button icon check failed (#3369):\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
  console.log('Fly-button icons fit inside the button circle.');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
