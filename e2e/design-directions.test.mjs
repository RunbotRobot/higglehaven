// #3600 / #3601 (part of #3540): the design-directions pages. The frame at
// /design-directions/ shows the three directions side by side at phone width and
// opens each; A (fog and glass) and B (signs in the world) are standalone pages with
// the same three moments over real views of the world. The site does not allow one
// page inside another (CSP frame-src and frame-ancestors), so the frame links to each
// page and each page carries a strip back to the others. Everything must load under
// the site's enforcing Content-Security-Policy (launchPage turns a violation into a
// failure), and a direction whose page is missing (C, until it lands) shows "coming"
// instead of a dead link.
import { launchPage, finish } from './helpers.mjs';

const session = await launchPage({ viewport: { width: 390, height: 844 } });
const { page } = session;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const origin = new URL(page.url()).origin;
const base = `${origin}/design-directions`;
const exists = async (file) => {
  const res = await page.request.get(`${base}/${file}`);
  return res.status() === 200 && (res.headers()['content-type'] || '').includes('text/html');
};

// The frame.
const frame = await page.goto(`${base}/`, { waitUntil: 'load' });
check(frame?.status() === 200, `the frame answers 200 (got ${frame?.status()})`);
await page.waitForTimeout(800);
check(await page.locator('.direction').count() === 3, 'the frame lists three directions');
for (const letter of ['a', 'b', 'c']) {
  const there = await exists(`${letter}.html`);
  const coming = await page.locator(`#dir-${letter}.coming`).count() > 0;
  check(there !== coming, `direction ${letter.toUpperCase()}: its page ${there ? 'exists, so it is not marked coming' : 'is missing, so it is marked coming'} (coming=${coming})`);
}
check(await page.locator('#dir-a:not(.coming)').count() === 1 && await page.locator('#dir-b:not(.coming)').count() === 1, 'A and B open from the frame');
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the frame does not scroll sideways at phone width');
check(await page.locator('style').count() === 0, 'the frame uses no <style> element (the policy refuses it)');

// Directions A and B: three moments at 390x844, the strip, and their pictures.
const scenes = {
  'a.html': { signs: '.card .buy', extra: async () => check(await page.locator('.sheet .row').count() === 4, 'A lists four settings in its glass sheet') },
  'b.html': { signs: '.stake-sign .buy', extra: async () => check(await page.locator('.notice .row').count() === 4, 'B lists four settings on its notice board') },
};
for (const [file, { signs, extra }] of Object.entries(scenes)) {
  const res = await page.goto(`${base}/${file}`, { waitUntil: 'load' });
  check(res?.status() === 200, `${file} answers 200 (got ${res?.status()})`);
  await page.waitForTimeout(800);
  for (const scene of ['scene-walk', 'scene-product', 'scene-settings']) {
    const box = await page.locator(`.${scene}`).boundingBox();
    check(box && Math.abs(box.width - 390) < 2 && Math.abs(box.height - 844) < 3, `${file} ${scene} is drawn at 390x844 (${JSON.stringify(box)})`);
  }
  check(await page.locator(signs).isVisible(), `${file} shows a Buy control`);
  await extra();
  check(await page.locator('.dd-strip a').count() >= 2, `${file} has the strip back to the other directions`);
  check(await page.locator('style').count() === 0, `${file} uses no <style> element (the policy refuses it)`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${file} does not scroll sideways at phone width`);
}

// The pictures are served.
for (const file of ['world-walk.jpg', 'world-product.jpg', 'world-settings.jpg', 'a-walk.jpg', 'a-product.jpg', 'a-settings.jpg', 'b-walk.jpg', 'b-product.jpg', 'b-settings.jpg', 'a.css', 'b.css', 'frame.css', 'frame.js', 'strip.css', 'strip.js']) {
  const res = await page.request.get(`${base}/${file}`);
  check(res.status() === 200, `${file} is served (got ${res.status()})`);
}

await finish(session.browser, { pass, label: '#3600: the design-directions frame, direction A and direction B load under the content-security policy', errors: session.errors });
