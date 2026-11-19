// #3878: the app's home-screen icons. The manifest lists the 192 and 512 icons and a maskable one, the
// splash colour is the same everywhere it is written, the iOS tile and the tab fallback are linked
// from index.html, and the maskable icon keeps the mark inside the safe zone. That the files exist and are
// the sizes they claim is checked on what the server hands out: e2e/app-icons.test.mjs (PNG files cannot
// be read in this runtime). The pixels of the maskable icon are measured by scripts/make-app-icons.mjs
// when it writes it.
import { describe, expect, it } from 'vitest';
import manifestText from '../public/manifest.webmanifest?raw';
import faviconSvg from '../public/favicon.svg?raw';
import indexHtml from '../index.html?raw';
import { ICONS, SPLASH_COLOUR, SHARE_ON_MASKABLE, SAFE_RADIUS_SHARE, markGroupOf, iconSvg, markReachShare, safeZoneProblem } from './app-icons-lib.mjs';

const manifest = JSON.parse(manifestText);

describe('the manifest icons', () => {
  const pngs = manifest.icons.filter((icon) => icon.type === 'image/png');

  it('lists the 192 and 512 icons and a maskable 512', () => {
    const has = (size, purpose) => pngs.some((icon) => icon.sizes === `${size}x${size}` && icon.purpose === purpose);
    expect(has(192, 'any')).toBe(true);
    expect(has(512, 'any')).toBe(true);
    expect(has(512, 'maskable')).toBe(true);
  });

  it('keeps the SVG as the icon for systems that take one', () => {
    expect(manifest.icons.some((icon) => icon.src === '/favicon.svg' && icon.type === 'image/svg+xml')).toBe(true);
  });

  it('names only files the script writes', () => {
    const written = ICONS.map((icon) => `/${icon.file}`);
    for (const icon of pngs) expect(written).toContain(icon.src);
  });
});

describe('the splash colour', () => {
  it('is the same in the manifest, the page and the script (that it is the opening screen\'s own colour, from src/tokens.css, is checked in e2e/app-icons.test.mjs: CSS cannot be read in this runtime)', () => {
    expect(manifest.background_color.toLowerCase()).toBe(SPLASH_COLOUR.toLowerCase());
    expect(manifest.theme_color.toLowerCase()).toBe(SPLASH_COLOUR.toLowerCase());
    expect(new RegExp(`<meta name="theme-color" content="${SPLASH_COLOUR}"`, 'i').test(indexHtml)).toBe(true);
  });
});

describe('index.html', () => {
  it('links the apple-touch-icon and the 32px icon the script writes', () => {
    const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(indexHtml)?.[1];
    const tab = /<link rel="icon" type="image\/png" sizes="32x32" href="([^"]+)"/.exec(indexHtml)?.[1];
    const written = ICONS.map((icon) => `/${icon.file}`);
    expect(written).toContain(apple);
    expect(written).toContain(tab);
  });
});

describe('the maskable icon', () => {
  it('keeps the whole mark inside the safe circle', () => {
    expect(safeZoneProblem(SHARE_ON_MASKABLE)).toBeNull();
    expect(markReachShare(SHARE_ON_MASKABLE)).toBeLessThanOrEqual(SAFE_RADIUS_SHARE);
  });

  it('would be refused if the mark were drawn too large for the safe circle', () => {
    expect(safeZoneProblem(0.9)).toMatch(/safe circle/);
  });

  it('is the one icon marked maskable, at 512', () => {
    const maskable = ICONS.filter((icon) => icon.maskable);
    expect(maskable.map((icon) => [icon.file, icon.size])).toEqual([['icon-maskable-512.png', 512]]);
  });
});

describe('the script', () => {
  it('builds each icon from the favicon\'s own mark', () => {
    const group = markGroupOf(faviconSvg);
    for (const icon of ICONS) expect(iconSvg(group, icon)).toContain(group);
  });
});
