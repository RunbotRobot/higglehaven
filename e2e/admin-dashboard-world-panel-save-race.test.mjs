// #2099: saveWorld()/expandWorld() (public/admin-dashboard.html, World
// panel) never touched worldLoadToken at all -- unlike loadWorld(), which
// already guarded its own renderWorld() call against a slower, now-stale
// response landing after a fresher one. This let a slow, still-in-flight
// Refresh (loadWorld()'s own GET /api/world) land AFTER a quick Save
// (saveWorld()'s PATCH) and silently overwrite the just-saved radius with
// the pre-save value Refresh's own GET had captured before the save ever
// happened. Same monotonic-token-guard idiom and same captured-then-
// delayed route.fulfill() shape as the sibling admin-dashboard-world-
// panel-race.test.mjs (#1927), but here the race is between loadWorld()
// and saveWorld() sharing one token, not two loadWorld() calls racing
// each other.
import { chromium } from 'playwright';
import { ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const sessionCookie = await ensureAdminSession(); // "hh_session=<token>"
const [, token] = sessionCookie.split('=');

async function getWorld() {
  const response = await fetch(`${BASE_URL}/api/world`, { headers: { Cookie: `hh_session=${token}` } });
  const body = await response.json();
  if (response.status !== 200) throw new Error(`getWorld failed (${response.status}): ${JSON.stringify(body)}`);
  return body.world;
}

const initialWorld = await getWorld();
const savedRadiusM = initialWorld.radiusM + 100;
console.log('world radiusM before the race (the stale value the delayed Refresh GET will carry):', initialWorld.radiusM);
console.log('world radiusM the Save should win with:', savedRadiusM);

const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);

// The page's own initial GET /api/world (on load) passes straight through,
// so the panel starts correctly populated. Only the SECOND GET -- the one
// the Refresh click below fires -- is captured then delayed, so it carries
// genuinely pre-save data by the time it's finally delivered.
let getCount = 0;
await page.route('**/api/world', async (route) => {
  if (route.request().method() !== 'GET') {
    await route.continue();
    return;
  }
  getCount += 1;
  if (getCount !== 2) {
    await route.continue();
    return;
  }
  const response = await route.fetch();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await route.fulfill({ response });
});

await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'load' });
await page.click('button[data-panel="world"]');
await page.waitForFunction(
  (radiusM) => document.getElementById('worldRadiusInput').value === String(radiusM),
  initialWorld.radiusM,
  { timeout: 10000 },
);
// The radius/etc inputs live inside the collapsed <details class="edit-world">
// (see index.html's own markup) -- expanding it is what makes them visible/
// fillable at all, regardless of data having already loaded above.
await page.click('.edit-world summary');
await page.locator('#worldRadiusInput').waitFor({ state: 'visible', timeout: 10000 });

// Fires the slow, now-intercepted second GET -- still in flight (delayed)
// when Save below runs.
await page.click('#worldRefreshBtn');

await page.fill('#worldRadiusInput', String(savedRadiusM));
await page.click('#worldSaveBtn');
await page.waitForFunction(
  (radiusM) => document.getElementById('worldRadiusInput').value === String(radiusM),
  savedRadiusM,
  { timeout: 10000 },
);
const radiusAfterSave = await page.locator('#worldRadiusInput').inputValue();
console.log('radiusM input right after Save resolves (should be the just-saved value):', radiusAfterSave);

// Wait out the delayed, stale Refresh response too, and confirm it didn't
// land late and revert the UI back to the pre-save radius.
await page.waitForTimeout(2200);
const finalRadius = await page.locator('#worldRadiusInput').inputValue();
console.log('radiusM input after the stale, delayed Refresh response also lands (should stay the saved value, not revert):', finalRadius);

const pass = radiusAfterSave === String(savedRadiusM) &&
  finalRadius === String(savedRadiusM) &&
  errors.length === 0;
await finish(browser, {
  pass,
  label: '#2099: a stale, delayed Refresh response does not revert a fresher Save\'s radius',
  errors,
});
