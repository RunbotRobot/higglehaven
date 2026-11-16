// #3601 (part of #3540): design direction B, "signs in the world", is a static page
// under /design-directions/. It must load under the site's enforcing
// Content-Security-Policy (no inline styles or scripts), show its three moments
// over their real world views, and its picture files must exist. launchPage
// already turns any CSP violation into a failure.
import { launchPage, finish } from './helpers.mjs';

const session = await launchPage({ viewport: { width: 390, height: 844 } });
const { page } = session;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const origin = new URL(page.url()).origin;
const response = await page.goto(`${origin}/design-directions/b.html`, { waitUntil: 'load' });
check(response?.status() === 200, `b.html answers 200 (got ${response?.status()})`);
await page.waitForTimeout(500);

for (const scene of ['scene-walk', 'scene-product', 'scene-settings']) {
  const box = await page.locator(`.${scene}`).boundingBox();
  check(box && Math.abs(box.width - 390) < 2 && Math.abs(box.height - 844) < 3, `${scene} is drawn at 390x844 (${JSON.stringify(box)})`);
}
check(await page.locator('.signpost .board').count() === 3, 'the walking view has its signpost');
check(await page.locator('.stake-sign .buy').isVisible(), 'the product sign has a Buy tab');
check(await page.locator('.notice .row').count() === 4, 'the notice board lists four settings');

// The three real-world pictures and the finished screenshots are served.
for (const file of ['b-base-walk.jpg', 'b-base-product.jpg', 'b-base-settings.jpg', 'b-walk.jpg', 'b-product.jpg', 'b-settings.jpg', 'b.css']) {
  const res = await page.request.get(`${origin}/design-directions/${file}`);
  check(res.status() === 200, `${file} is served (got ${res.status()})`);
}
// Inline styles are refused by the site's policy, so none may be used.
check(await page.locator('[style]').count() === 0, 'the page uses no inline style attributes');

await finish(session.browser, { pass, label: '#3601: design direction B loads under the content-security policy and shows its three moments', errors: session.errors });
