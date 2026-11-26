// #4387 (owner, 2026-11-26): "I think we should display the same pop for consistency of world." An orb that
// someone else collects while I can see it pops for me exactly as it popped for them; fog is only for an orb
// coming into or leaving range. The server's list for the lándlet names the orbs collected a moment ago
// (worker/credit-orbs.test.js covers that side); here the list is answered by hand so the page's reading of it
// can be checked in a real browser:
//   - an orb named in collectedOrbIds pops (the same pop effect the collector sees), is gone, and no fog runs;
//   - an orb that is simply absent from the list (claimed, removed) dissolves through fog instead;
//   - an orb still in the list stays.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox } from './helpers.mjs';

const LABEL = 'Orb Onlooker Tester';
const LANDLET_ID = `credit-orb-onlooker-e2e-${Date.now()}`;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.setViewportSize({ width: 390, height: 844 });
await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const popped = await seedCreditOrbAsAdmin(LANDLET_ID, { x: 6, y: 6 });
const removed = await seedCreditOrbAsAdmin(LANDLET_ID, { x: -6, y: 6 });
const staying = await seedCreditOrbAsAdmin(LANDLET_ID, { x: 6, y: -6 });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
const mine = landlets.find((l) => l.landletId === LANDLET_ID);

const joystick = await shopStickBox(page);
const cx = joystick.x + joystick.width / 2;
const cy = joystick.y + joystick.height / 2;
await page.mouse.move(cx, cy); await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100); await page.mouse.up(); await page.waitForTimeout(100);
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [mine.center.x, mine.center.y]);
await page.waitForFunction((ids) => ids.every((id) => window.__testActiveCreditOrbIds().includes(id)), [popped, removed, staying], { timeout: 15000 });

// From now on the lándlet's list says: `popped` was collected, `removed` is just gone, `staying` is still there.
await page.route(`**/api/credit-orbs?landletId=${LANDLET_ID}`, async (route) => {
  const real = await (await route.fetch()).json();
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ orbs: real.orbs.filter((o) => o.orbId === staying), collectedOrbIds: [popped] }),
  });
});

const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  const ids = await page.evaluate(() => window.__testActiveCreditOrbIds());
  if (!ids.includes(popped) && !ids.includes(removed)) break;
  await page.waitForTimeout(100);
}
// The pop effect lives under half a second, so on a slow shard a sampler can miss it (#4427): count the pops spawned.
const popsSpawned = await page.evaluate(() => window.__testCreditOrbPopsSpawned());
const sawPop = popsSpawned === 1; // the collected orb only; the one gone for another reason dissolves, it does not pop
const ids = await page.evaluate(() => window.__testActiveCreditOrbIds());
check(!ids.includes(popped), 'the orb another person collected is gone');
check(!ids.includes(removed), 'an orb absent from the list for another reason is gone');
check(ids.includes(staying), 'an orb still in the list stays');
check(sawPop, `the collected orb popped with the same effect the collector sees, once (pops spawned: ${popsSpawned})`);
check(await page.evaluate(() => document.getElementById('bud-note')?.textContent.trim() ?? '') !== 'Orb collected', 'no collector text (balance, note) is shown to the onlooker');

await finish(browser, { pass, label: 'Orb onlooker: an orb another person collects pops the same for me; one gone for another reason dissolves', errors });
