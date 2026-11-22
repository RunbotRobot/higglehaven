// #4044 (part of #3539): coming down from the opening flight the view points at the ground (the pitch is
// the climb), so a new person lands looking at grass with a product just out of frame. On touch-down the
// view eases up to level over about half a second: pitch only, never the heading, and a person who is
// already looking level or up is left alone (src/shop/landingLevel.js).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Landing Level Tester' });
await chooseIdentity(page, { mode: 'shop', label: 'Landing Level Tester', isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 30000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const pitch = () => page.evaluate(() => window.__shopCameraPitch);
const yaw = () => page.evaluate(() => window.__shopCameraYaw);
const state = () => page.evaluate(() => window.__testShopFlightState());
const landed = () => page.waitForFunction(() => window.__testShopFlightState() === 'grounded', null, { timeout: 60000 });

// The spawn is a flight with the view pointing well down.
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 60000 });
await page.waitForTimeout(500);
const before = await pitch();
check(before < -0.5, `the opening flight looks well down (pitch ${before})`);

// Land: the view eases up to level.
const yawBefore = await yaw();
await page.evaluate(() => window.__testToggleShopFlight());
await landed();
await page.waitForTimeout(1200);
const after = await pitch();
check(after > -0.02 && after <= 0.0001, `after landing the view is level (pitch ${after})`);
const yawAfter = await yaw();
check(Math.abs(yawAfter - yawBefore) < 0.5, `the heading was not turned for the person (yaw ${yawBefore} to ${yawAfter})`);

// A person already looking up is left alone: take off, look up, land.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 30000 });
await page.evaluate(() => window.__testSetShopPitch(0.4));
await page.evaluate(() => window.__testToggleShopFlight());
await landed();
await page.waitForTimeout(1000);
const up = await pitch();
check(Math.abs(up - 0.4) < 0.02, `a view looking up is left alone (pitch ${up})`);

// Looking down again and landing eases again.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 30000 });
await page.evaluate(() => window.__testSetShopPitch(-0.9));
await page.evaluate(() => window.__testToggleShopFlight());
await landed();
await page.waitForTimeout(1200);
const again = await pitch();
check(again > -0.02, `a second landing from looking down levels the view (pitch ${again}, state ${await state()})`);

await finish(browser, { pass: pass && errors.length === 0, label: 'landing-levels-view (#4044)', errors });
