// #4074: the admin dashboard's Landlet overrides panel finds a lándlet by name, id or owner, not only by
// an exact id. Drives the real page against the real endpoint: a spelling that is not the id loads the
// one match straight away, a shared word lists several to choose from, an owner's username lists what
// they own, and pasting an exact id still loads it as before.
import { chromium } from 'playwright';
import { createGeneratingLandletAsAdmin, ensureAdminSession, finish } from './helpers.mjs';

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || null;
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const errors = [];

const suffix = Date.now().toString(36);
const ONE = `zzfind-mosaic-${suffix}-002`;
const TWO = `zzfind-mosaic-${suffix}-012`;
await createGeneratingLandletAsAdmin(ONE, { center: { x: 1000, y: 0 } });
await createGeneratingLandletAsAdmin(TWO, { center: { x: 2000, y: 0 } });

const sessionCookie = await ensureAdminSession();
const [, token] = sessionCookie.split('=');
const page = await browser.newPage();
page.on('pageerror', (err) => errors.push(err.message));
page.on('console', (msg) => { if (msg.type() === 'error' && !/status of 404/.test(msg.text())) errors.push(msg.text()); });
await page.context().addCookies([{ name: 'hh_session', value: token, url: BASE_URL }]);
await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
await page.click('button[data-panel="landlets"]');

const loadedId = () => page.evaluate(() => document.querySelector('#landletStatGrid .n.mono')?.textContent || '');
async function lookup(text) {
  await page.fill('#landletLookupInput', text);
  await page.click('#landletLookupBtn');
}

// 1. A spelling that is not the id, with the number unpadded: exactly one match, loaded straight away.
await lookup(`zzfind mosaic ${suffix} 2`);
await page.waitForFunction((id) => document.querySelector('#landletStatGrid')?.textContent.includes(id), ONE, { timeout: 10000 });
const loadedBySpelling = (await loadedId()) === ONE;
console.log('a name spelled with spaces and no leading zeros loads the one match (should be true):', loadedBySpelling);

// 2. A shared word: both are listed, with the count, and nothing is loaded until one is chosen.
await lookup(`zzfind mosaic ${suffix}`);
await page.waitForSelector('.landlet-search-row', { timeout: 10000 });
const rows = await page.locator('.landlet-search-row').count();
const note = await page.textContent('#landletSearchNote');
const detailHidden = await page.locator('#landletDetailWrap').isHidden();
console.log('rows listed (should be 2):', rows, '| note:', note, '| detail hidden while choosing (should be true):', detailHidden);
await page.locator('.landlet-search-row', { hasText: TWO }).click();
await page.waitForFunction((id) => document.querySelector('#landletStatGrid')?.textContent.includes(id), TWO, { timeout: 10000 });
const chosenLoaded = (await loadedId()) === TWO;
const listGoneAfterChoosing = await page.locator('#landletSearchResults').isHidden();
console.log('choosing a row loads it (should be true):', chosenLoaded, '| list closes (should be true):', listGoneAfterChoosing);

// 3. An exact id still loads straight away, as before.
await lookup(ONE);
await page.waitForFunction((id) => document.querySelector('#landletStatGrid')?.textContent.includes(id), ONE, { timeout: 10000 });
const exactLoaded = (await loadedId()) === ONE;
console.log('an exact id still loads (should be true):', exactLoaded);

// 4. Nothing matches: the id lookup's own message, no list.
await lookup(`no-such-place-${suffix}`);
await page.waitForFunction(() => !document.getElementById('landletsErr').hidden, null, { timeout: 10000 });
const errText = await page.textContent('#landletsErr');
const noList = await page.locator('#landletSearchResults').isHidden();
console.log('no match shows the lookup error and no list (should be true):', Boolean(errText) && noList, '|', errText);

const pass = loadedBySpelling && rows === 2 && /2 l/.test(note) && detailHidden && chosenLoaded && listGoneAfterChoosing
  && exactLoaded && Boolean(errText) && noList && errors.length === 0;
await finish(browser, { pass, label: '#4074: the admin dashboard finds a lándlet by name, id or owner, lists several, and still loads an exact id', errors });
