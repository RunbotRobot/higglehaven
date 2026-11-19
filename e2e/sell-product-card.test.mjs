// #3702 (Sell in the bud, 4/6; part of #3655, #3648): a product tapped in the showroom blooms a
// card beside it, with the actions on the product directly under its name: Rename, Price and Stock
// (inline fields, so both are on the card), Delete (its own in-app confirmation) and More (My
// products on that product's row). The card follows the product, closes on its X, on Escape and
// on a tap on empty ground, and tapping a product no longer opens My products by itself.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, openAddProductLeaf, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');
const { browser, page, errors } = await launchPage({ promptAnswer: 'Sell Card Tester', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: 'Sell Card Tester', isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// One product, added from the bud with My products closed: it must appear on the shelf by itself.
await page.click('#seller-close-btn');
await openAddProductLeaf(page);
await page.fill('#upload-name', 'Card Crate');
await page.fill('#upload-price', '5');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), null, { timeout: 30000 });
await page.waitForTimeout(1500);
const shelf = await page.evaluate(() => window.__testSellerShowcaseCount());
console.log('products on the shelf with My products closed (should be 1):', shelf);
check(shelf === 1, 'a product added from the bud with My products closed appears on the shelf by itself');

async function tapProduct() {
  for (const fy of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
    for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      await page.mouse.click(390 * fx, 844 * fy);
      await page.waitForTimeout(420); // slower than a double-tap, which flies
      if (await page.locator('#seller-product-card').isVisible()) return true;
    }
  }
  return false;
}
const tapped = await tapProduct();
check(tapped, 'tapping the product blooms its card');
check(!(await page.locator('#seller-modal.visible').count()), 'a tap no longer opens My products');
await page.waitForTimeout(600);
const info = await page.evaluate(() => {
  const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
  const card = r('seller-product-card');
  return {
    name: document.getElementById('seller-product-card-name').textContent,
    price: document.getElementById('seller-product-card-price').textContent,
    card,
    actions: r('seller-product-card-actions'),
    nameBox: r('seller-product-card-name'),
    anchor: window.__testSellerCardAnchor?.() ?? null,
    vw: innerWidth, vh: innerHeight,
    buttons: [...document.querySelectorAll('#seller-product-card-actions button')].map((b) => b.textContent.trim()),
    rowsTops: [...document.querySelectorAll('#seller-product-card-actions button')].map((b) => Math.round(b.getBoundingClientRect().top)),
  };
});
console.log('card:', JSON.stringify({ name: info.name, price: info.price, buttons: info.buttons, tops: info.rowsTops }));
check(info.name === 'Card Crate', `the card is titled with the product's name (${info.name})`);
check(info.price === '$5.00', `the price is on the card (${info.price})`);
check(info.buttons.join() === 'Rename,Price,Stock,Delete,More', `the actions are Rename, Price, Stock, Delete, More (${info.buttons})`);
check(info.actions.top >= info.nameBox.bottom - 1, 'the actions sit directly under the name');
check(new Set(info.rowsTops).size === 1, `the card's buttons do not wrap (tops ${info.rowsTops})`);
check(info.card.left >= 0 && info.card.right <= info.vw && info.card.top >= 0 && info.card.bottom <= info.vh, 'the card is inside the screen');

// Price, inline.
await page.click('#seller-product-card-price-btn');
await page.fill('#seller-product-card-price-input', '7.5');
await page.click('#seller-product-card-price-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-price').textContent === '$7.50', null, { timeout: 10000 });
check(true, 'price saved from the card');
await page.click('#seller-product-card-price-btn');
await page.fill('#seller-product-card-price-input', 'abc');
await page.click('#seller-product-card-price-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-status').textContent.length > 0, null, { timeout: 5000 });
check((await page.textContent('#seller-product-card-status')).includes('non-negative'), 'a bad price is refused on the card, in words');

// Stock, inline: a new product has no limit; a number is what is left; 0 reads as sold out.
check((await page.textContent('#seller-product-card-stock')) === 'No limit on stock', 'a new product reads as no limit on stock');
await page.click('#seller-product-card-stock-btn');
check(!(await page.locator('#seller-product-card-price-edit').isVisible()), 'opening Stock puts the price field away');
check(await page.locator('#seller-product-card-stock-hint').isVisible(), 'the stock field says what blank means');
await page.fill('#seller-product-card-stock-input', '3');
await page.click('#seller-product-card-stock-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-stock').textContent === '3 in stock', null, { timeout: 10000 });
check(true, 'stock saved from the card');
await page.click('#seller-product-card-stock-btn');
await page.fill('#seller-product-card-stock-input', '0');
await page.click('#seller-product-card-stock-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-stock').textContent === 'Sold out', null, { timeout: 10000 });
check(true, 'zero reads as sold out');
await page.click('#seller-product-card-stock-btn');
await page.fill('#seller-product-card-stock-input', '-2');
await page.click('#seller-product-card-stock-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-status').textContent.length > 0, null, { timeout: 5000 });
check((await page.textContent('#seller-product-card-status')).includes('whole number'), 'a bad stock is refused on the card, in words');
await page.fill('#seller-product-card-stock-input', '');
await page.click('#seller-product-card-stock-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-stock').textContent === 'No limit on stock', null, { timeout: 10000 });
check(true, 'a blank field puts the product back to no limit');

// Rename, in its modal.
await page.click('#seller-product-card-rename-btn');
await page.waitForSelector('#bundle-name-modal.visible', { timeout: 5000 });
await page.fill('#bundle-name-input', 'Renamed Crate');
await page.click('#bundle-name-save-btn');
await page.waitForFunction(() => document.getElementById('seller-product-card-name').textContent === 'Renamed Crate', null, { timeout: 10000 }).catch(() => {});
check((await page.textContent('#seller-product-card-name')) === 'Renamed Crate', 'renamed from the card');

// More opens My products on this product's row.
await page.click('#seller-product-card-more-btn');
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
check((await page.locator('.seller-row.expanded').count()) >= 1, 'More opens My products on the product row');
check(!(await page.locator('#seller-product-card').isVisible()), 'the card is put away when More opens the sheet');
await page.click('#seller-close-btn');
await page.waitForTimeout(400);

// Escape and a tap on empty ground put the card away.
check(await tapProduct(), 'tapping again blooms the card again');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await page.locator('#seller-product-card').isVisible()), 'Escape puts the card away');
await tapProduct();
await page.click('#seller-product-card-close-btn');
check(!(await page.locator('#seller-product-card').isVisible()), 'the X puts the card away');

// Delete, with its confirmation; the shelf loses the product by itself.
await tapProduct();
await page.click('#seller-product-card-delete-btn');
await page.waitForSelector('#confirm-modal.visible', { timeout: 5000 });
await page.click('#confirm-modal-confirm-btn');
await page.waitForFunction(() => !document.getElementById('seller-product-card') || document.getElementById('seller-product-card').hidden, null, { timeout: 15000 });
await page.waitForTimeout(1500);
const shelfAfter = await page.evaluate(() => window.__testSellerShowcaseCount());
console.log('products on the shelf after Delete (should be 0):', shelfAfter);
check(shelfAfter === 0, 'the deleted product is gone from the shelf without opening My products');

await finish(browser, { pass: pass && errors.length === 0, label: 'sell-product-card (#3702)', errors });
