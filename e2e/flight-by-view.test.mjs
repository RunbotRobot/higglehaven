// #3769 (part of #3648): while flying the avatar goes where the view points; the up and
// down arrows are gone. A level view flies level; looking up and moving forward climbs
// and stops at the top of the sky with one plain note, never bouncing; looking down and
// moving forward descends and rests at the lowest hover, saying so, without landing; the
// body tips with the view. Keyboard stands in for the two gestures (R/F look, W walk).
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Flight By View Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
// Land the spawn flight, then take off, so the start is the ordinary hover.
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(2500);
await page.evaluate(() => window.__testToggleShopFlight());
await page.waitForTimeout(1600);

const z = () => page.evaluate(() => window.__testShopAvatarPosition().z);
const walk = async (ms) => { await page.keyboard.down('KeyW'); await page.waitForTimeout(ms); await page.keyboard.up('KeyW'); };
const pitch = (rad) => page.evaluate((r) => window.__testSetShopPitch(r), rad);

// Level view (and a nearly level one, inside the dead zone): height is held while walking.
await pitch(0);
const z0 = await z();
await walk(1500);
check(Math.abs((await z()) - z0) < 0.05, 'a level view flies level');
await pitch(0.05);
const z1 = await z();
await walk(1000);
check(Math.abs((await z()) - z1) < 0.05, 'a view inside the dead zone flies level');

// Looking up and walking forward climbs, moving back reverses it.
await pitch(0.5);
const z2 = await z();
await walk(1200);
const z3 = await z();
check(z3 > z2 + 0.5, `looking up and walking forward climbs (${z2.toFixed(2)} -> ${z3.toFixed(2)})`);
const tiltUp = await page.evaluate(() => window.__shopAvatarOrientation.pitchRad);
await page.waitForTimeout(600);
const tiltUpSettled = await page.evaluate(() => window.__shopAvatarOrientation.pitchRad);
await pitch(-0.5);
await page.waitForTimeout(900);
const tiltDown = await page.evaluate(() => window.__shopAvatarOrientation.pitchRad);
check(tiltUpSettled > tiltDown + 0.2, `the body tips nose-up looking up and nose-down looking down (${tiltUpSettled.toFixed(2)} vs ${tiltDown.toFixed(2)} rad)`);

// The top of the sky: it levels off, stays, and says so once.
await pitch(0.6);
await page.keyboard.down('KeyW');
const sawTop = await page.waitForFunction(() => document.getElementById('shop-status').textContent.includes('top of the sky'), null, { timeout: 40000 }).then(() => true, () => false);
await page.keyboard.up('KeyW');
check(sawTop, 'the top of the sky is said in plain words');
await page.waitForTimeout(500);
const top1 = await z();
await walk(2000);
const top2 = await z();
check(Math.abs(top2 - top1) < 0.05, `it rests at the top of the sky and does not bounce (${top1.toFixed(2)}, ${top2.toFixed(2)})`);

// The bottom: descends to the lowest hover, says so, does not land.
await pitch(-0.6);
await page.keyboard.down('KeyW');
const sawLow = await page.waitForFunction(() => document.getElementById('shop-status').textContent.includes('as low as you can fly'), null, { timeout: 60000 }).then(() => true, () => false);
await page.keyboard.up('KeyW');
check(sawLow, 'the lowest hover is said in plain words');
await page.waitForTimeout(500);
const low1 = await z();
await walk(1500);
const low2 = await z();
check(Math.abs(low2 - low1) < 0.05, 'it rests at the lowest hover and does not bounce');
check(await page.evaluate(() => document.body.classList.contains('shop-flying')), 'flying into the ground does not land by itself');
check((await page.locator('#shop-up-btn, #shop-down-btn, #shop-vertical-controls').count()) === 0, 'the up and down arrows are gone');

await finish(browser, { pass: pass && errors.length === 0, label: '#3769: flight follows the view; the limits are felt and said once', errors });
