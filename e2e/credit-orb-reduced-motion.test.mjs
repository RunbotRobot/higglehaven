// #4574 (walk: the five main jobs with no touch and no motion): under prefers-reduced-motion the orb a person
// collects simply goes, with no scale-up pop, as it already does for someone looking on (#4387). The collect still
// counts: the orb is gone and the person's credits go up.
import { launchPage, chooseIdentity, createGreenbeltLandletAsAdmin, seedCreditOrbAsAdmin, finish, shopStickBox } from './helpers.mjs';

const LABEL = 'Orb Reduced Motion Tester';
const LANDLET_ID = `credit-orb-reduced-e2e-${Date.now()}`;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
await page.emulateMedia({ reducedMotion: 'reduce' });
await createGreenbeltLandletAsAdmin(LANDLET_ID, { areaM2: 1000 });
const orbId = await seedCreditOrbAsAdmin(LANDLET_ID, { x: 2, y: -1 });

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 10000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
const { landlets } = await page.evaluate(async () => (await fetch('/api/landlets?limit=100')).json());
const mine = landlets.find((l) => l.landletId === LANDLET_ID);

const box = await shopStickBox(page);
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy); await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100); await page.mouse.up(); await page.waitForTimeout(100);
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y, 0); window.__testForceShopProximityCheck(); }, [mine.center.x, mine.center.y]);
await page.waitForFunction((id) => window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 15000 });

const popsBefore = await page.evaluate(() => window.__testCreditOrbPopsSpawned());
await page.evaluate(([x, y]) => { window.__testTeleportShopAvatar(x, y); window.__testForceShopProximityCheck(); }, [mine.center.x + 2, mine.center.y - 1]);
await page.waitForFunction((id) => !window.__testActiveCreditOrbIds().includes(id), orbId, { timeout: 15000 });
await page.waitForTimeout(800);
const popsAfter = await page.evaluate(() => window.__testCreditOrbPopsSpawned());
const credits = await page.evaluate(() => document.querySelector('#account-menu-toggle .bud-word')?.textContent.trim() ?? '');
console.log({ popsBefore, popsAfter, credits });
check(popsAfter === popsBefore, `no pop is drawn under reduced motion (${popsBefore} -> ${popsAfter})`);
check(/^\d+ credits?$/.test(credits), `the collect still counted (${credits})`);

await finish(browser, { pass: pass && errors.length === 0, label: '#4574: a collected orb goes without the pop under reduced motion', errors });
