// #4664: Add to basket and the Basket petal are drawn only while the server says a basket can be paid for
// (GET /api/basket-config). With the answer "no", or no answer at all, the Shop stem is Friends, My purchases, Chat,
// Nearby and a product's card offers Buy and nothing about a basket; with "yes" both appear (e2e/shop-basket.test.mjs
// covers using them). The answer is mocked here, whatever the e2e server's own switch says.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Basket Gate Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });
let answer = { status: 200, body: { checkoutEnabled: false } };
await page.route('**/api/basket-config', (route) => route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) }));
// The page launchPage opened has already asked the real server; load it again so the mocked answer is the one read.
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });

async function openStem() {
  const expanded = await page.evaluate(() => document.getElementById('account-menu-panel')?.classList.contains('expanded'));
  if (!expanded) await page.click('#account-menu-toggle');
  await page.waitForSelector('#bud-petal-shop-nearby', { timeout: 8000 });
}
async function stemIds() {
  return page.evaluate(() => [...document.querySelectorAll('#account-menu-panel [id^="bud-petal-shop-"]')].map((e) => e.id));
}

await openStem();
const off = await stemIds();
console.log('stem with the switch off:', off);

// No answer at all (a failed read) draws nothing either.
answer = { status: 500, body: { error: 'down' } };
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await openStem();
const failed = await stemIds();
console.log('stem when the answer cannot be read:', failed);

answer = { status: 200, body: { checkoutEnabled: true } };
await page.reload();
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await openStem();
await page.waitForSelector('#bud-petal-shop-basket', { timeout: 8000 });
const on = await stemIds();
console.log('stem with the switch on:', on);

const pass = !off.includes('bud-petal-shop-basket') && off.includes('bud-petal-shop-nearby')
  && !failed.includes('bud-petal-shop-basket') && on.includes('bud-petal-shop-basket') && errors.filter((e) => !/Failed to load resource/.test(e)).length === 0;
await finish(browser, { pass, label: '#4664: the Basket petal is drawn only while a basket can be paid for', errors });
