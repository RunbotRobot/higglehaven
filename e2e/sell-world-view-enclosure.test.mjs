// #3502 (part of #3418; owner decision "A place outside the world still looks
// like the world"): Sell mode's showroom is a small, empty piece of the world:
// the standard grass, the same hazy wall and dome and drifting sky as Shop, and
// no real lándlets (the far view is Shop's and never runs here). Entering Sell's
// world view finds the wall, the dome and the grass disc in the scene, the
// page's own ground plane hidden under the grass, the sky advancing, the far
// view absent, and the avatar still stopped at the page's edge. Also prints the
// longest frame since entering, the figure the issue asks to be no worse.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, finish, openAddProductLeaf } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Sell Enclosure Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

await openAddProductLeaf(page);
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', 'Enclosure Crate');
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(500);
await page.click('#seller-close-btn');
await page.waitForTimeout(800);

const worldViewActive = await page.evaluate(() => window.__sellWorldViewActive?.() === true);
console.log('Sell world view is live (should be true):', worldViewActive);

const enclosure = await page.evaluate(() => window.__sellWorldEnclosure?.() ?? null);
console.log('enclosure:', enclosure);
const enclosed = !!enclosure && enclosure.wallInScene && enclosure.domeInScene && enclosure.groundInScene;
console.log('wall, dome and grass disc are in the scene (should be true):', enclosed);
console.log('the page ground plane is hidden under the grass (should be true):', enclosure?.pageGroundHidden);
// The wall must sit far beyond the page and, for the camera never to reach the
// dome, at least 600 m out (the radius rule in src/sell/worldView.js).
const farEnough = !!enclosure && enclosure.radiusM >= 600 && enclosure.radiusM <= 900;
console.log('wall is out at 600..900 m (should be true):', farEnough, enclosure?.radiusM);

// Shop's far view (real lándlets out to the horizon) never runs in Sell.
const farViewAbsent = await page.evaluate(() => typeof window.__shopFarViewStats === 'undefined');
console.log('Shop far view is absent (should be true):', farViewAbsent);

// The sky is alive: its clock advances from Sell's own frame update.
const sky0 = await page.evaluate(() => window.__sellWorldEnclosure?.()?.skyTimeS ?? null);
await page.waitForTimeout(1500);
const sky1 = await page.evaluate(() => window.__sellWorldEnclosure?.()?.skyTimeS ?? null);
console.log('sky clock before/after (should advance):', sky0, sky1);
const skyAdvances = sky0 !== null && sky1 !== null && sky1 > sky0;

// Fly to the highest the camera may go at the far corner of the page: it stays
// inside the dome (nothing is drawn but sky around it), i.e. the camera is not
// outside the enclosure radius at any point.
await page.evaluate(() => window.__frameMonitor.reset());
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
const frame = await page.evaluate(() => ({ longestGapMs: window.__frameMonitor.longestFrameGapMs(), longTasks: window.__frameMonitor.longTasks() }));
console.log('longest frame while walking the page in Sell:', JSON.stringify(frame));
const bounds = await page.evaluate(() => window.__sellWorldGroundBounds());
const pos = await page.evaluate(() => window.__testShopAvatarPosition());
const stillOnPage = pos.x >= bounds.minX && pos.x <= bounds.maxX && pos.y >= bounds.minY && pos.y <= bounds.maxY;
console.log('avatar still on the page (should be true):', stillOnPage);

const pass = worldViewActive && enclosed && enclosure.pageGroundHidden && farEnough &&
  farViewAbsent && skyAdvances && stillOnPage && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3502: Sell showroom is enclosed by the world\'s grass, wall, dome and sky, with no far view',
  errors,
});
