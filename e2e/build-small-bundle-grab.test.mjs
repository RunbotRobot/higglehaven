// #4489: a small bundle's members can be a few pixels each with gaps between them (a small fence, a few bricks far off),
// and a press in a gap used to orbit the view instead of moving the bundle, although its translucent box is drawn. A
// press inside the box of ONE selected bundle now grabs it, up to a size where it still leaves room round it to orbit by;
// a press well away from it is still the view's. 390x844, a mouse standing in for a finger.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Small Bundle Grab Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(800);

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

async function placeTreeAt(x, y) {
  await page.click('#add-item-btn');
  await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
  await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).first().click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await page.waitForTimeout(900);
}
await placeTreeAt(110, 470);
await placeTreeAt(290, 470);
await placeTreeAt(200, 600);
await page.mouse.click(40, 780);
await page.waitForTimeout(300);
const positions = await page.evaluate(() => window.__testProductScreenPositions());
await page.click('#toggle-multiselect');
await page.waitForTimeout(200);
for (const p of positions) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(150); }
await page.click('#group-item');
await page.waitForTimeout(800);
await page.click('#toggle-multiselect');
await page.waitForTimeout(400);
const members = await page.evaluate(() => window.__testProductScreenPositions());
await page.mouse.click(members[0].x, members[0].y);
await page.waitForTimeout(600);

// Zoom out until the whole bundle is small on screen.
let b = await page.evaluate(() => window.__testBundleScreenCore());
for (let i = 0; i < 14 && b && b.radius > 80; i++) {
  await page.mouse.move(330, 740);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(450);
  b = await page.evaluate(() => window.__testBundleScreenCore());
}
console.log('bundle on screen:', JSON.stringify(b));
check(b && b.radius > 30 && b.radius <= 110, `the bundle is small but not tiny on screen (radius ${b?.radius?.toFixed(0)} px)`);
if (b) {
  // a spot at the bundle's middle that is on no member and under no handle
  let gap = null;
  for (let r = 0; r <= 24 && !gap; r += 4) {
    for (let a = 0; a < 360 && !gap; a += 30) {
      const x = b.x + Math.cos((a * Math.PI) / 180) * r;
      const y = b.y + Math.sin((a * Math.PI) / 180) * r;
      const probe = await page.evaluate(([px, py]) => ({ h: window.__testHandleAt(px, py), body: window.__testSelectedItemHitAt(px, py) }), [x, y]);
      if (!probe.h.ring && !probe.h.arrow && !probe.body) gap = { x, y };
    }
  }
  console.log('a press in a gap of the bundle:', JSON.stringify(gap));
  check(!!gap, 'a spot inside the bundle that is on no member and under no handle');
  if (gap) {
    const before = await page.evaluate(() => window.__testProductPositions());
    await page.mouse.move(gap.x, gap.y);
    await page.mouse.down();
    await page.mouse.move(gap.x + 30, gap.y + 18, { steps: 8 });
    check(await page.evaluate(() => window.__testBodyDragActive()), 'a drag that starts in a gap of a small bundle is a drag of the bundle');
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__testProductPositions());
    const moved = after.map((p, i) => Math.hypot(p.x - before[i].x, p.y - before[i].y));
    check(moved.every((m) => m > 0.2) && Math.abs(moved[0] - moved[1]) < 0.05, `and every member moved together (${moved.map((m) => m.toFixed(2)).join(', ')} m)`);
  }
  // far from the bundle a drag is the view's
  const far = { x: Math.min(375, b.x + b.radius + 90), y: b.y };
  await page.mouse.move(far.x, far.y);
  await page.mouse.down();
  await page.mouse.move(far.x - 20, far.y + 10, { steps: 6 });
  check(!(await page.evaluate(() => window.__testBodyDragActive())), 'a drag that starts well away from a small bundle is not a drag of the bundle');
  await page.mouse.up();
}

await finish(browser, { pass: pass && errors.length === 0, label: '#4489: a press in a gap of a small bundle grabs it; one well away from it does not', errors });
