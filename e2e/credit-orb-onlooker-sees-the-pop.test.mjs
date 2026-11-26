// #4387 (owner, 2026-11-26: one event in the world looks the same to everyone who sees it): when Alice walks
// into an orb that Bob can see, Bob's orb pops the same way (the pop effect Alice's own orb plays) instead of
// standing there until a reload. Bob gets no credit word beside his head: that is Alice's. 390x844 phones.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox } from './helpers.mjs';

const ALICE = 'Orb Onlooker Alice';
const BOB = 'Orb Onlooker Bob';
const LANDLET_ID = `orb-onlooker-e2e-${Date.now()}`;
const ORB_X = 2;
const ORB_Y = -1;

const alice = await launchPage({ promptAnswer: ALICE });
const bob = await launchPage({ promptAnswer: BOB });
await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const orbId = await seedCreditOrbAsAdmin(LANDLET_ID, { x: ORB_X, y: ORB_Y });

async function enterShopOnLandlet(session, label) {
  const { page } = session;
  await chooseIdentity(page, { mode: 'shop', label, isNew: true });
  await page.waitForSelector('body.shop-ready', { timeout: 15000 });
  await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 15000 });
  const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
  const landlet = landlets.find((l) => l.landletId === LANDLET_ID);
  // A real joystick deflection frees the avatar from the spawn orbit so the teleport hook can drive it.
  const box = await shopStickBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 25, cy, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(100);
  // Bob stands a few metres from the orb, on the ground, out of its reach.
  await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [landlet.center.x - 8, landlet.center.y + 8]);
  return landlet;
}

const landlet = await enterShopOnLandlet(alice, ALICE);
await enterShopOnLandlet(bob, BOB);
const bobPage = bob.page;
const alicePage = alice.page;

for (const page of [alicePage, bobPage]) {
  await page.waitForFunction((id) => window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 30000 });
}
console.log('both see the orb (should be true): true');

// Bob samples for the pop effect as it plays: it lives under half a second.
await bobPage.evaluate(() => {
  window.__sawOnlookerPop = false;
  window.__onlookerPopSampler = setInterval(() => { if (window.__testActiveCreditOrbPopEffectCount() > 0) window.__sawOnlookerPop = true; }, 25);
});
// Give both presence reports a moment, so Bob's poll is already running on this lándlet.
await bobPage.waitForTimeout(2500);

await alicePage.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [landlet.center.x + ORB_X, landlet.center.y + ORB_Y]);
await alicePage.waitForFunction((id) => !window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 15000 });
console.log("Alice's orb popped on contact (should be true): true");

const goneForBob = await bobPage.waitForFunction((id) => !window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 30000 })
  .then(() => true, () => false);
const sawPop = await bobPage.evaluate(() => window.__sawOnlookerPop);
const bobNote = await bobPage.evaluate(() => {
  const note = document.getElementById('bud-note');
  return !!note && !note.hidden && note.textContent.trim() !== '';
});
console.log("the orb is gone from Bob's world after Alice collected it (should be true):", goneForBob);
console.log('Bob saw the pop effect play (should be true):', sawPop);
console.log('Bob got no credit word beside his head (should be false):', bobNote);

const pass = goneForBob && sawPop && !bobNote;
await bob.browser.close();
await finish(alice.browser, {
  pass,
  label: '#4387: an orb another person collects pops for the onlooker too',
  errors: [...alice.errors, ...bob.errors].filter((e) => !e.includes('Failed to load resource')),
});
