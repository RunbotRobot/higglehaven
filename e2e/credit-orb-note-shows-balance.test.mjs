// #4123: collecting an orb shows how many credits the person now holds ("1 credit", "2 credits"),
// not the increment, and the number is the server's: it agrees with what the API reports, and with the
// card the note opens (#4072). Two orbs are collected one after the other.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox, budWordText } from './helpers.mjs';

const LABEL = 'Orb Balance Tester';
const LANDLET_ID = `orb-balance-e2e-${Date.now()}`;
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
await seedCreditOrbAsAdmin(LANDLET_ID, { x: 2, y: -1 });
await seedCreditOrbAsAdmin(LANDLET_ID, { x: 8, y: -1 });

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
await page.waitForTimeout(800);

const balanceFromApi = () => page.evaluate(async () => (await (await fetch('/api/builders/me')).json()).builder.videoGenerationCredits);
const before = await balanceFromApi();

async function collectAt(dx, dy, expectedWord) {
  await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y); window.__testForceShopProximityCheck(); }, [mine.center.x + dx, mine.center.y + dy]);
  const shown = await page.waitForFunction((w) => document.querySelector('#account-menu-toggle .bud-word')?.textContent.trim() === w, expectedWord, { timeout: 8000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(600); // the server's answer has replaced the expected number by now
  return { shown, word: await budWordText(page), api: await balanceFromApi() };
}

const first = await collectAt(2, -1, `${before + 1} credit${before + 1 === 1 ? '' : 's'}`);
console.log('after the first orb (word should say the balance, which the API agrees with):', JSON.stringify(first), 'balance before:', before);
const second = await collectAt(8, -1, `${before + 2} credits`);
console.log('after the second orb:', JSON.stringify(second));

await page.click('#bud-note');
await page.waitForSelector('#bud-leaf-orb-collected', { timeout: 5000 });
const card = await page.locator('#bud-leaf-orb-collected .bud-leaf-body').innerText();
console.log('card:', JSON.stringify(card));

const pass = first.shown && first.api === before + 1 &&
  second.shown && second.api === before + 2 && second.word === `${before + 2} credits` &&
  new RegExp(`You have ${before + 2} now\\.`).test(card) &&
  errors.length === 0;
await finish(browser, { pass, label: 'Credit orb: the note shows the balance after this orb, the way the API reports it, and the card agrees (#4123)', errors });
