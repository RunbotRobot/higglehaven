// #3878 (interface week, #3539): the app's home-screen icons, made from the flower's own mark.
//
// Usage: node scripts/make-app-icons.mjs        (run by hand; the PNGs it writes are committed)
//   reads  public/favicon.svg                    the mark (the swirl), drawn in code
//   writes public/icon-192.png                   Android home screen, purpose "any"
//          public/icon-512.png                   Android install splash, purpose "any"
//          public/icon-maskable-512.png          purpose "maskable": the mark inside the safe zone,
//                                                on the colour the opening screen starts on
//          public/apple-touch-icon.png           iOS home screen (180; iOS rounds the corners itself)
//          public/favicon-32.png                 tab icon fallback where SVG icons are not used
//
// If the head's look changes (#3754 is waiting on the owner's pick among Today and A to D), change the
// mark in public/favicon.svg and re-run this: every icon follows it.
//
// The colours and sizes are in scripts/app-icons-lib.mjs. The colours are the brand's, from src/tokens.css:
// the mark is --brand-green, on --world-fallback (the colour the opening screen starts on, so the phone's
// splash and our first frame are one colour) for the full-bleed icons, and on the favicon's own cream tile
// for the "any" icons. Rendered with sharp (a dev dependency, as in scripts/cut-bird-icons.mjs), so the
// output is the same on every machine; it stops if a changed mark no longer fits the maskable safe zone.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ICONS, SAFE_RADIUS_SHARE, iconSvg, markGroupOf, safeZoneProblem } from './app-icons-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

export async function renderIcon(markGroup, icon) {
  const svg = iconSvg(markGroup, icon);
  return sharp(Buffer.from(svg), { density: Math.ceil((72 * icon.size) / 32) * 2 })
    .resize(icon.size, icon.size)
    .png()
    .toBuffer();
}

// The farthest pixel of the mark from the centre, as a share of the icon's width, measured on the rendered
// PNG against the splash colour it sits on.
async function farthestMarkShare(png, size) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = [0xee, 0xf4, 0xe0];
  let farthest = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 3;
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 24) {
        farthest = Math.max(farthest, Math.hypot(x - size / 2, y - size / 2));
      }
    }
  }
  return farthest / size;
}

async function main() {
  const favicon = await fs.readFile(path.join(PUBLIC, 'favicon.svg'), 'utf8');
  const markGroup = markGroupOf(favicon);
  for (const icon of ICONS) {
    const png = await renderIcon(markGroup, icon);
    if (icon.maskable) {
      // Stop rather than write an icon the system would cut the mark out of (a changed mark may be bigger).
      const problem = safeZoneProblem(icon.share);
      const measured = await farthestMarkShare(png, icon.size);
      if (problem || measured > SAFE_RADIUS_SHARE) {
        throw new Error(`${icon.file}: the mark does not fit the safe zone (${problem || `measured reach ${measured.toFixed(3)} of the width`}); lower SHARE_ON_MASKABLE in scripts/app-icons-lib.mjs`);
      }
    }
    await fs.writeFile(path.join(PUBLIC, icon.file), png);
    console.log(`wrote public/${icon.file} (${icon.size}x${icon.size}, ${png.length} bytes)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
