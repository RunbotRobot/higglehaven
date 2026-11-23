// #4072: the "Credit +1" word beside the head is a door to what was collected (with the builder's own
// count from the server), and a tap on an orb in the world says what an orb is, with the limit as
// the server states it. A real tap needs aiming at a pixel, which this suite never automates, so the
// orb card is opened by the same function the tap calls (window.__testShowCreditOrbAbout).
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox } from './helpers.mjs';

const LABEL = 'Orb Door Tester';
const LANDLET_ID = `orb-door-e2e-${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
await seedCreditOrbAsAdmin(LANDLET_ID, { x: 2, y: -1 });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
const mine = landlets.find((l) => l.landletId === LANDLET_ID);

const box = await shopStickBox(page);
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();
await page.waitForTimeout(100);
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [mine.center.x, mine.center.y]);
await page.waitForTimeout(500);

// Ask an orb what it is before collecting it: the card says what it is and the limit, and nothing is collected.
await page.evaluate(() => window.__testShowCreditOrbAbout());
await page.waitForSelector('#bud-leaf-orb-about', { timeout: 5000 });
const aboutText = await page.locator('#bud-leaf-orb-about .bud-leaf-body').innerText();
console.log('orb card:', JSON.stringify(aboutText));
const stillThere = await page.evaluate(() => window.__testActiveCreditOrbIds().length);
await page.click('#bud-leaf-orb-about .bud-leaf-close');

// Collect it, then open the word.
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y); window.__testForceShopProximityCheck(); }, [mine.center.x + 2, mine.center.y - 1]);
await page.waitForFunction(() => document.querySelector('#account-menu-toggle .bud-word')?.textContent.trim() === 'Credit +1', null, { timeout: 5000 });
await page.click('#bud-note');
await page.waitForSelector('#bud-leaf-orb-collected', { timeout: 5000 });
const collectedText = await page.locator('#bud-leaf-orb-collected .bud-leaf-body').innerText();
console.log('collected card:', JSON.stringify(collectedText));

const pass = /glowing orb/i.test(aboutText) && /Walk or fly into it/.test(aboutText) && /up to \d+ orbs every \d+ minutes?/.test(aboutText) &&
  stillThere === 1 &&
  /free credit/.test(collectedText) && /You have 1 now\./.test(collectedText) && /Build/.test(collectedText) &&
  !/landlet|\bbud\b|flower|petal|leaf/i.test(aboutText + collectedText) &&
  errors.length === 0;
await finish(browser, { pass, label: 'Credit orb: the word is a door to what was collected, and the orb card says what an orb is (#4072)', errors });
