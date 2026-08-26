// Simulated purchases (docs/SPEC.md §5's commission formula, docs/API.md's
// "Simulated purchases") — a dev-mode-only "buy" that charges nothing real
// but runs the actual 2%/50-50/0.5%-floor commission math and credits a
// real builder, completing the earning loop land cap (migrations/0050)
// normalizes against. The in-world Shop-mode "Simulate Purchase" hint isn't
// reachable without real camera movement (see docs/API.md's own testing
// note for this feature, same convention as product reviews/pricing); this
// test covers the seller's own upload → priced product → placed instance →
// purchase → commission-credited flow through the real API the hint calls
// (purchaseInstance in src/api.js), with the product actually created and
// priced through the real Seller-modal UI.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE_MODEL_PATH = path.join(REPO_ROOT, 'public', 'models', 'crate.glb');

const LABEL = 'Simulated Purchases Suite Tester';
const PRODUCT_NAME = 'Suite Purchasable Product';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 10000 });
await page.waitForTimeout(300);
await page.click('#upload-model-btn');
await page.waitForSelector('#upload-modal.visible', { timeout: 10000 });
await page.fill('#upload-name', PRODUCT_NAME);
await page.fill('#upload-price', '25');
await page.setInputFiles('#upload-file-input', CRATE_MODEL_PATH);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-step-dimensions').hidden, { timeout: 20000 });
await page.waitForTimeout(300);
await page.click('#upload-submit-btn');
await page.waitForFunction(() => !document.getElementById('upload-modal').classList.contains('visible'), { timeout: 10000 });
await page.waitForTimeout(500);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { templates } = (await fetchJson('/api/catalog?limit=100')).body;
const template = templates.find((t) => t.name === PRODUCT_NAME);
console.log('uploaded, priced product found in catalog (priceCents should be 2500):', template?.priceCents);

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
console.log('builder found by label:', !!builder);
const balanceBefore = builder.dallersBalanceCents;

const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];
console.log('builder\'s claimed lándlet found:', !!landlet);

const instanceId = 'suite-purchasable-instance';
const placed = await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId, landletId: landlet.landletId, templateId: template.templateId, x: 0, y: 0 }),
});
console.log('instance placed (status should be 201):', placed.status);

// Purchase it through the exact API the in-world hint calls
// (purchaseInstance in src/api.js) — quantity 2, a named buyer.
const purchased = await fetchJson(`/api/instances/${instanceId}/purchase`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ quantity: 2, buyerLabel: 'A Shopper' }),
});
console.log('purchase response (status should be 201):', purchased.status, purchased.body.purchase);
// $50 total (2 * $25), 2% commission = $1 (100 cents), 50/50 split = 50
// cents to the builder (well above the 0.5% floor of 25 cents on $50).
const { purchase } = purchased.body;

const { builders: buildersAfter } = (await fetchJson('/api/builders')).body;
const builderAfter = buildersAfter.find((b) => b.builderId === builder.builderId);
console.log('builder\'s dállers balance before/after (should differ by 50):', balanceBefore, builderAfter.dallersBalanceCents);

const { purchases } = (await fetchJson(`/api/purchases?builderId=${builder.builderId}`)).body;
console.log('purchase history for this builder (should list the one purchase):', purchases.map((p) => `${p.templateId} x${p.quantity}`));

const pass = template?.priceCents === 2500 &&
  !!builder && !!landlet &&
  placed.status === 201 &&
  purchased.status === 201 &&
  purchase.totalCents === 5000 &&
  purchase.commissionCents === 100 &&
  purchase.builderShareCents === 50 &&
  purchase.platformShareCents === 50 &&
  purchase.buyerLabel === 'A Shopper' &&
  builderAfter.dallersBalanceCents - balanceBefore === 50 &&
  purchases.length === 1 &&
  purchases[0].templateId === template.templateId &&
  errors.length === 0;
await finish(browser, { pass, label: 'Simulated purchases: priced product → placed instance → purchase → commission credited', errors });
