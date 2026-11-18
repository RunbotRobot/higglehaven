// #1319: Shop mode used to be joystick-only. WASD / arrow keys now walk, Q/E
// turn, an active joystick wins over the keyboard, keys typed into a text
// field never move the avatar, and Space still belongs to the flight toggle.
// #3823: one press of T takes off and lands (and is ignored while typing).
// Drives real key presses in a real browser and reads the avatar's position
// and camera yaw.
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox, goToMode } from './helpers.mjs';

const LABEL = 'Keyboard Movement Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await goToMode(page, 'shop');
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForSelector('body.shop-ready', { timeout: 15000 });

const position = () => page.evaluate(() => {
  const p = window.__testShopAvatarPosition?.();
  return p ? { x: p.x, y: p.y } : null;
});
const yaw = () => page.evaluate(() => window.__shopCameraYaw);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// A trivial joystick tap ends the hands-off spawn orbit so the avatar is
// genuinely idle (same idiom as e2e/shop-afk-look-only-input.test.mjs).
const moveBox = await shopStickBox(page);
const ox = moveBox.x + moveBox.width / 2;
const oy = moveBox.y + moveBox.height / 2;
await page.mouse.move(ox, oy);
await page.mouse.down();
await page.mouse.move(ox + 20, oy, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(600);

const hasPosition = (await position()) !== null;
console.log('avatar position hook available (should be true):', hasPosition);

const start = await position();
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const afterW = await position();
const movedByW = hasPosition && dist(start, afterW) > 0.5;
console.log('holding W moves the avatar (should be true):', movedByW, hasPosition ? dist(start, afterW).toFixed(2) : 'n/a');

await page.waitForTimeout(400);
const settled = await position();
await page.waitForTimeout(500);
const stillSettled = await position();
const stoppedOnRelease = hasPosition && dist(settled, stillSettled) < 0.05;
console.log('avatar stops once the key is released (should be true):', stoppedOnRelease);

const beforeArrow = await position();
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(700);
await page.keyboard.up('ArrowDown');
await page.waitForTimeout(200);
const afterArrow = await position();
const movedByArrow = hasPosition && dist(beforeArrow, afterArrow) > 0.5;
console.log('holding ArrowDown moves the avatar (should be true):', movedByArrow);

const yawBefore = await yaw();
await page.keyboard.down('KeyE');
await page.waitForTimeout(600);
await page.keyboard.up('KeyE');
await page.waitForTimeout(200);
const yawAfterE = await yaw();
await page.keyboard.down('KeyQ');
await page.waitForTimeout(600);
await page.keyboard.up('KeyQ');
await page.waitForTimeout(200);
const yawAfterQ = await yaw();
const turnedRight = yawAfterE < yawBefore - 0.05;
const turnedLeft = yawAfterQ > yawAfterE + 0.05;
console.log('E turns right and Q turns left (should be true, true):', turnedRight, turnedLeft);

// A text field swallows the keys: nothing moves while typing in it.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.id = 'kb-test-input';
  document.body.appendChild(input);
  input.focus();
});
const beforeTyping = await position();
await page.keyboard.down('KeyW');
await page.waitForTimeout(500);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const afterTyping = await position();
const ignoredInInput = hasPosition && dist(beforeTyping, afterTyping) < 0.05;
console.log('typing W in a text field does not move the avatar (should be true):', ignoredInInput);

// #3823: one press of T toggles flight. The spawn orbit ended above, so the avatar is flying.
// (The text field from the check above is still focused, so T is first pressed there: it
// must not change anything; then focus goes back to the page.)
const flightState = () => page.evaluate(() => window.__testShopFlightState());
const stateBeforeTyping = await flightState();
await page.keyboard.press('KeyT');
await page.waitForTimeout(300);
const ignoredTypingT = (await flightState()) === stateBeforeTyping && stateBeforeTyping === 'flying';
console.log('T typed into a text field does not change flight (should be true):', ignoredTypingT, stateBeforeTyping);
await page.evaluate(() => { document.getElementById('kb-test-input')?.remove(); document.activeElement?.blur?.(); });

await page.keyboard.press('KeyT');
await page.waitForFunction(() => window.__testShopFlightState() === 'landing', null, { timeout: 5000 }).catch(() => {});
const landedByT = (await flightState()) === 'landing';
console.log('one press of T starts a landing (should be true):', landedByT);

// A press during a landing resumes flight at once (the same toggle as a double-tap).
await page.keyboard.press('KeyT');
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 5000 }).catch(() => {});
const resumedByT = (await flightState()) === 'flying';
console.log('a second press during the landing resumes flying (should be true):', resumedByT);

// From the ground, one press takes off; once up, the next lands.
const here = await position();
await page.evaluate(([x, y]) => window.__testTeleportShopAvatar(x, y, 0), [here.x, here.y]);
await page.waitForFunction(() => window.__testShopFlightState() === 'grounded', null, { timeout: 5000 }).catch(() => {});
await page.keyboard.press('KeyT');
await page.waitForFunction(() => window.__testShopFlightState() === 'takingOff', null, { timeout: 5000 }).catch(() => {});
const tookOffByT = (await flightState()) === 'takingOff';
await page.waitForFunction(() => window.__testShopFlightState() === 'flying', null, { timeout: 60000 }).catch(() => {});
await page.keyboard.press('KeyT');
await page.waitForFunction(() => window.__testShopFlightState() === 'landing', null, { timeout: 5000 }).catch(() => {});
const landedAgainByT = (await flightState()) === 'landing';
console.log('from the ground T takes off, and once up the next press lands (should be true, true):', tookOffByT, landedAgainByT);

await finish(browser, {
  pass: hasPosition && movedByW && stoppedOnRelease && movedByArrow && turnedRight && turnedLeft && ignoredInInput
    && ignoredTypingT && landedByT && resumedByT && tookOffByT && landedAgainByT,
  label: 'shop-keyboard-movement.test.mjs',
  errors,
});
