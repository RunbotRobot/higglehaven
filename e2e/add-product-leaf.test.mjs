// #3703 (Sell in the bud, 5/6; part of #3655, #3648): every way of adding a product starts at the
// bud's Add a product petal, which opens one leaf under the bud (no dimming scrim) asking which
// way. Upload keeps its steps and refuses an empty required field on the step that holds it; Sell
// This Too is the other answer. The + Upload Model and Sell This Too buttons are gone from My
// products, and closing the leaf puts My products back only if it was open underneath.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Add Product Leaf', viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'sell', label: 'Add Product Leaf', isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

check((await page.locator('#upload-model-btn').count()) === 0, 'the + Upload Model button is gone');
check((await page.locator('#sell-this-too-btn').count()) === 0, 'the Sell This Too button is gone');

async function openLeaf() {
  const expanded = await page.evaluate(() => document.getElementById('account-menu-panel').classList.contains('expanded'));
  if (!expanded) await openAccountMenu(page);
  await page.click('#bud-petal-sell-add-product');
  await page.waitForSelector('#upload-step-choose:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(400);
}
const sellerOpen = () => page.evaluate(() => document.getElementById('seller-modal').classList.contains('visible'));
const status = () => page.evaluate(() => document.getElementById('upload-status').textContent.trim());
const stepsShown = () => page.evaluate(() => ({
  file: !document.getElementById('upload-step-file').hidden,
  dims: !document.getElementById('upload-step-dimensions').hidden,
}));

// My products is open underneath (Sell still opens on it).
await openLeaf();
const m = await page.evaluate(() => {
  const rect = (el) => el.getBoundingClientRect().toJSON();
  const bg = getComputedStyle(document.getElementById('upload-modal')).backgroundColor;
  const alpha = (c) => { const x = c.match(/[\d.]+/g).map(Number); return x.length > 3 ? x[3] : 1; };
  return {
    bud: rect(document.getElementById('account-menu-toggle')),
    content: rect(document.getElementById('upload-modal-content')),
    close: rect(document.getElementById('upload-cancel-btn')),
    scrimAlpha: alpha(bg),
    vh: window.innerHeight,
    title: document.getElementById('upload-modal-title').textContent.trim(),
  };
});
check(m.title === 'Add a product', `the leaf is titled "Add a product" (${m.title})`);
check(m.scrimAlpha === 0, `no dimming scrim (alpha ${m.scrimAlpha})`);
check(m.content.top >= m.bud.bottom, `the leaf starts under the bud (top ${Math.round(m.content.top)}, bud bottom ${Math.round(m.bud.bottom)})`);
check(m.content.left < 30, `the leaf grows from the bud's corner (left ${Math.round(m.content.left)})`);
check(m.content.bottom <= m.vh && m.content.top >= 0, 'the leaf is inside the screen');
check(m.close.left + m.close.width / 2 > m.content.left + m.content.width * 0.75, 'the close control is upper right');
check((await stepsShown()).file === false, 'the upload steps wait for the answer');
check(!(await page.locator('#upload-submit-btn').isVisible()), 'no Add Product button shows while the leaf is still asking which way');

// Upload my own model: the upload steps, a required field refused on its own step.
await page.click('#add-product-upload-btn');
await page.waitForSelector('#upload-step-file:not([hidden])', { timeout: 5000 });
await page.click('#upload-submit-btn');
check((await status()) === 'Name is required.', `an empty name is refused on the first step (${await status()})`);
await page.fill('#upload-name', 'Leaf Crate');
await page.click('#upload-submit-btn');
check((await status()).startsWith('Enter a price'), `an empty price is refused on the first step (${await status()})`);
await page.fill('#upload-price', '3');
await page.click('#upload-submit-btn');
check((await status()).startsWith('Choose a .glb'), `a missing file is refused on the first step (${await status()})`);
const s = await stepsShown();
check(s.file && !s.dims, 'the seller stays on the step that holds the empty field');

// Closing it puts My products back, since it was open underneath.
await page.click('#upload-cancel-btn');
await page.waitForSelector('#upload-modal', { state: 'hidden', timeout: 5000 });
check(await sellerOpen(), 'My products is back after closing the leaf (it was open underneath)');

// With My products closed, the leaf opens and closes without bringing it back.
await page.click('#seller-close-btn');
await page.waitForSelector('#seller-modal', { state: 'hidden', timeout: 5000 });
await openLeaf();
await page.click('#upload-cancel-btn');
await page.waitForSelector('#upload-modal', { state: 'hidden', timeout: 5000 });
check(!(await sellerOpen()), 'My products stays closed when it was not open underneath');

// Sell one that is already here.
await openLeaf();
await page.click('#add-product-sell-too-btn');
await page.waitForSelector('#sell-this-too-modal.visible', { timeout: 5000 });
check(await page.evaluate(() => !document.getElementById('upload-modal').classList.contains('visible')), 'the leaf hands over to the Sell This Too sheet');
await page.click('#sell-this-too-close-btn');
await page.waitForSelector('#sell-this-too-modal', { state: 'hidden', timeout: 5000 });
check(!(await sellerOpen()), 'closing Sell This Too does not bring My products back either');

await finish(browser, { pass: pass && errors.length === 0, label: 'add-product-leaf (#3703)', errors });
