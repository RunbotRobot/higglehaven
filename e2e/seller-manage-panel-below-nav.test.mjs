// #3250: Sell > Manage -- an opened product row made the seller panel run up
// underneath the (higher z-index) Shop/Build/Sell pills on a phone. The panel
// must start below the nav and stay inside the screen on a short phone.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Manage Panel Nav Tester';
const PRODUCT_NAME = 'Panel Nav Crate';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 600 } });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });

await page.evaluate(async (name) => {
  const { seller } = await (await fetch('/api/sellers/me')).json();
  await fetch('/api/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      color: '#999999',
      dimensions: { width: 1, depth: 1, height: 1 },
      sellerId: seller.sellerId,
      priceCents: 500,
    }),
  });
}, PRODUCT_NAME);
await page.reload();
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: false });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const row = page.locator('.seller-row').filter({ hasText: PRODUCT_NAME });
await row.locator('.seller-row-toggle').click();
await page.waitForTimeout(300);
const expanded = await row.evaluate((el) => el.classList.contains('expanded'));
console.log('product row expanded (should be true):', expanded);

// A short phone (390x600) is the harder case: the expanded row fills the
// panel's whole height cap, which is where it used to reach the nav strip.
let allClear = true;
for (const height of [600]) {
  const { navBottom, panelTop, panelBottom, viewportH } = await page.evaluate(() => {
    const nav = document.getElementById('mode-nav').getBoundingClientRect();
    const panel = document.getElementById('seller-modal-content').getBoundingClientRect();
    return { navBottom: nav.bottom, panelTop: panel.top, panelBottom: panel.bottom, viewportH: window.innerHeight };
  });
  const clear = panelTop >= navBottom && panelBottom <= viewportH;
  console.log(`390x${height}: panel top ${panelTop} vs nav bottom ${navBottom}, panel bottom ${panelBottom} (should start below the nav and fit):`, clear);
  allClear = allClear && clear;
}

const pass = expanded && allClear && errors.length === 0;
await finish(browser, { pass, label: 'Sell Manage panel clears the mode nav', errors });
