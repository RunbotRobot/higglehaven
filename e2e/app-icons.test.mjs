// #3878: the home-screen icons, as a phone fetches them. Every icon the manifest lists is served as an
// image of the type and the size it claims (PNG sizes are read from the file's own header), the maskable
// one is there, and index.html's iOS tile and 32px tab icon are served at 180 and 32. The manifest's
// colours and the safe zone are unit-tested in scripts/app-icons.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, finish } from './helpers.mjs';
import { SPLASH_COLOUR, MARK_COLOUR } from '../scripts/app-icons-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// A PNG's width and height are the two big-endian integers at bytes 16 and 20.
function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => bytes[i] === byte)) return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

async function fetchAsset(src) {
  const res = await page.request.get(new URL(src, BASE_URL).href);
  return { status: res.status(), type: res.headers()['content-type'] || '', body: await res.body() };
}

const manifestRes = await page.request.get(`${BASE_URL}/manifest.webmanifest`);
check(manifestRes.status() === 200, `the manifest is served (${manifestRes.status()})`);
const manifest = await manifestRes.json();

let maskable = 0;
for (const icon of manifest.icons) {
  const asset = await fetchAsset(icon.src);
  check(asset.status === 200, `${icon.src} is served (${asset.status})`);
  check(asset.type.startsWith(icon.type), `${icon.src} is served as ${icon.type} (got ${asset.type})`);
  if (icon.type === 'image/png') {
    const size = pngSize(asset.body);
    check(!!size, `${icon.src} is a PNG`);
    const [w, h] = icon.sizes.split('x').map(Number);
    check(size && size[0] === w && size[1] === h, `${icon.src} is ${icon.sizes} (got ${size && size.join('x')})`);
  }
  if (icon.purpose === 'maskable') maskable += 1;
}
check(maskable === 1, `one maskable icon is listed (${maskable})`);

// What the page itself links.
const html = await (await page.request.get(`${BASE_URL}/`)).text();
const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
const tab = /<link rel="icon" type="image\/png" sizes="32x32" href="([^"]+)"/.exec(html)?.[1];
check(!!apple && !!tab, `index.html links the iOS tile and the 32px icon (${apple}, ${tab})`);
for (const [src, want] of [[apple, 180], [tab, 32]]) {
  if (!src) continue;
  const asset = await fetchAsset(src);
  const size = pngSize(asset.body);
  check(asset.status === 200 && size && size[0] === want && size[1] === want, `${src} is served at ${want}x${want} (got ${asset.status}, ${size && size.join('x')})`);
}
check(/<meta name="theme-color" content="#eef4e0"/i.test(html) && manifest.theme_color.toLowerCase() === '#eef4e0', 'the theme colour is the opening screen\'s in both the page and the manifest');

// What Chromium itself makes of the manifest: it parses with no errors, and the icons it sees are these.
await page.goto(`${BASE_URL}/`);
const cdp = await page.context().newCDPSession(page);
const parsed = await cdp.send('Page.getAppManifest');
check((parsed.errors || []).filter((e) => e.critical).length === 0, `Chromium reads the manifest without critical errors (${JSON.stringify(parsed.errors)})`);
const seen = JSON.parse(parsed.data || '{}').icons || [];
check(seen.length === manifest.icons.length, `Chromium sees all ${manifest.icons.length} icons (${seen.length})`);
check(seen.some((icon) => icon.purpose === 'maskable'), 'Chromium sees the maskable icon');
check(seen.some((icon) => icon.sizes === '192x192') && seen.some((icon) => icon.sizes === '512x512'), 'Chromium sees the 192 and 512 icons');

// The colours the script draws with are the brand's own: the colour the opening screen starts on and the
// brand green, read from src/tokens.css (the unit test cannot read CSS).
const tokens = fs.readFileSync(path.join(ROOT, 'src/tokens.css'), 'utf8');
const fallback = /--world-fallback:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
const green = /--brand-green:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1];
check(!!fallback && fallback.toLowerCase() === SPLASH_COLOUR.toLowerCase(), `the splash colour is --world-fallback (${fallback} vs ${SPLASH_COLOUR})`);
check(!!fallback && fallback.toLowerCase() === manifest.background_color.toLowerCase(), 'the manifest\'s background_color is --world-fallback');
check(!!green && green.toLowerCase() === MARK_COLOUR.toLowerCase(), `the mark is drawn in --brand-green (${green} vs ${MARK_COLOUR})`);

await finish(browser, { pass, label: 'app-icons.test.mjs', errors });
