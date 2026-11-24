// #4159 (leaf 1 of #4158): Build's camera from a keyboard, with Shop's keys. W, A, S, D slide the view
// over the lándlet, Q and E turn it around what it looks at, R and F tip it, Page Up and Page Down zoom.
// Keys do nothing while a field has focus.
import { launchPage, chooseIdentity, goToMode, claimLandlet, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Build Keys Tester', viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

await chooseIdentity(page, { mode: 'shop', label: 'Build Keys Tester', isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });
await goToMode(page, 'build', { openProducts: false });
await claimLandlet(page);
await page.waitForSelector('body[data-mode="build"][data-bud="on"]', { timeout: 30000 });
await page.waitForTimeout(1500);

const pose = () => page.evaluate(() => window.__testBuildCameraPose());
const hold = async (code, ms = 700) => { await page.keyboard.down(code); await page.waitForTimeout(ms); await page.keyboard.up(code); await page.waitForTimeout(200); };
const dist = (a) => Math.hypot(a.camera.x - a.target.x, a.camera.y - a.target.y, a.camera.z - a.target.z);
const moved = (a, b) => Math.hypot(b.target.x - a.target.x, b.target.y - a.target.y);

let before = await pose();
await hold('KeyW');
let after = await pose();
check(moved(before, after) > 1, `W slides the view over the lándlet (${moved(before, after).toFixed(2)} m)`);
check(Math.abs(dist(after) - dist(before)) < 0.05, 'sliding keeps the distance to what it looks at');
const forwardBy = moved(before, after);

before = await pose();
await hold('KeyS');
after = await pose();
check(moved(before, after) > 1, 'S slides it back');

before = await pose();
await hold('KeyD');
after = await pose();
check(moved(before, after) > 1, 'D slides it to the right');

before = await pose();
await hold('KeyE');
after = await pose();
const angle = (p) => Math.atan2(p.camera.y - p.target.y, p.camera.x - p.target.x);
check(Math.abs(angle(after) - angle(before)) > 0.3, 'E turns the view around what it looks at');
check(Math.abs(dist(after) - dist(before)) < 0.05 && moved(before, after) < 0.05, 'turning keeps the distance and the target');

before = await pose();
await hold('KeyF');
after = await pose();
check(after.camera.z > before.camera.z + 0.2, `F tips the view down (camera ${before.camera.z.toFixed(2)} -> ${after.camera.z.toFixed(2)})`);
check(Math.abs(dist(after) - dist(before)) < 0.05, 'tipping keeps the distance');
await hold('KeyR', 5000);
after = await pose();
check(after.camera.z - after.target.z > 0, 'R never takes the camera below the ground');

before = await pose();
await hold('PageUp');
after = await pose();
check(dist(after) < dist(before) - 0.3, `Page Up zooms in (${dist(before).toFixed(2)} -> ${dist(after).toFixed(2)})`);
before = await pose();
await hold('PageDown', 900);
after = await pose();
check(dist(after) > dist(before) + 0.3, 'Page Down zooms out');

// A field with focus keeps its keys.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.id = 'kb-test-field';
  document.body.appendChild(input);
  input.focus();
});
before = await pose();
await hold('KeyW');
after = await pose();
check(moved(before, after) < 0.01, 'keys typed in a field do not move the camera');
await page.evaluate(() => document.getElementById('kb-test-field').remove());
check(forwardBy > 0, 'ok');

await finish(browser, { pass: pass && errors.length === 0, label: '#4159: Build moves, turns, tips and zooms its camera from the keyboard', errors });
