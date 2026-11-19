// #3878: the parts of scripts/make-app-icons.mjs that need no image library (so a test can import them in
// the Workers runtime, where the native `sharp` cannot load): the colours, the list of icons, the SVG each
// is drawn from, and the safe-zone arithmetic.

// The mark spans about 23.7 x 14.6 of the favicon's 32-unit square, centred on (16, 16): measured from
// the rendered icon by `make-app-icons.mjs`, which stops if a changed mark no longer fits.
export const MARK_CENTRE = 16;
export const MARK_WIDTH_UNITS = 24; // the width the shares below are taken against (a little over the real 23.7)
export const MARK_HEIGHT_UNITS = 14.7; // a little over the real 14.6

// How wide the mark is drawn, as a share of the icon's width.
export const SHARE_ON_TILE = 0.75; // "any" icons and the favicon: the favicon's own proportions
export const SHARE_ON_MASKABLE = 0.56; // inside the 80% safe circle with room to spare
export const SHARE_ON_APPLE = 0.62; // iOS crops the corners, so a little air

export const SPLASH_COLOUR = '#eef4e0'; // --world-fallback in src/tokens.css
export const MARK_COLOUR = '#6ca42e'; // --brand-green in src/tokens.css
export const TILE_COLOUR = '#f6f1e0'; // the favicon's own tile

// A maskable icon is cut to a shape of the system's choosing; what must survive is the circle of this
// radius (as a share of the width) around the centre.
export const SAFE_RADIUS_SHARE = 0.4;

export const ICONS = [
  { file: 'icon-192.png', size: 192, kind: 'tile', share: SHARE_ON_TILE },
  { file: 'icon-512.png', size: 512, kind: 'tile', share: SHARE_ON_TILE },
  { file: 'icon-maskable-512.png', size: 512, kind: 'full-bleed', share: SHARE_ON_MASKABLE, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, kind: 'full-bleed', share: SHARE_ON_APPLE },
  { file: 'favicon-32.png', size: 32, kind: 'tile', share: SHARE_ON_TILE },
];

// The mark's own paths: the group the favicon draws, without its tile.
export function markGroupOf(faviconSvg) {
  const start = faviconSvg.indexOf('<g ');
  const end = faviconSvg.lastIndexOf('</g>');
  if (start < 0 || end < 0) throw new Error('public/favicon.svg has no mark group to draw');
  return faviconSvg.slice(start, end + '</g>'.length);
}

// One icon as an SVG in the favicon's 32-unit square: a background, then the mark scaled about its centre.
export function iconSvg(markGroup, { kind, share }) {
  const scale = (share * 32) / MARK_WIDTH_UNITS;
  const background = kind === 'full-bleed'
    ? `<rect width="32" height="32" fill="${SPLASH_COLOUR}"/>`
    : `<rect width="32" height="32" rx="7" fill="${TILE_COLOUR}"/>`;
  const mark = `<g transform="translate(${MARK_CENTRE} ${MARK_CENTRE}) scale(${scale}) translate(${-MARK_CENTRE} ${-MARK_CENTRE})">${markGroup}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${background}${mark}</svg>`;
}

// How far the mark's corners reach from the centre, as a share of the icon's width, when drawn at `share`.
export function markReachShare(share) {
  const scale = share / MARK_WIDTH_UNITS; // icon widths per unit
  return Math.hypot((MARK_WIDTH_UNITS / 2) * scale, (MARK_HEIGHT_UNITS / 2) * scale);
}

// The reason a maskable icon would lose part of the mark, or null.
export function safeZoneProblem(share) {
  const reach = markReachShare(share);
  return reach <= SAFE_RADIUS_SHARE ? null : `the mark reaches ${reach.toFixed(3)} of the width from the centre; the safe circle is ${SAFE_RADIUS_SHARE}`;
}
