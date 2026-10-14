// #1950 (sub-issue of #1947): when the Settings > Build "Low Stock" panel's
// filter (#1949) is actually active, the matching placed items should be
// visually highlighted directly in the builder's own 3D Build-mode view --
// not just listed in the panel -- so they can find a soon-to-be-empty slot
// without cross-referencing the list against the scene by hand. Asserts via
// window.__testLowStockHighlightedInstanceIds (the established window.__test*
// hook convention this codebase already uses for otherwise-unreachable 3D
// scene state, e.g. window.__testProductScreenPositions), not DOM/pixel
// inspection.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish } from './helpers.mjs';

const LABEL = 'Low Stock Highlight Tester';
const MATCHING_INSTANCE_ID = 'low-stock-highlight-matching-instance';
const UNMATCHING_INSTANCE_ID = 'low-stock-highlight-unmatching-instance';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// One one-of-a-kind (stockQuantity 1) product -- will match a "max
// remaining: 1" filter -- and one also-finite-stock product with a much
// higher remaining count, which appears in the low-stock list (so this
// genuinely exercises "fails the threshold," not just "isn't finite stock
// at all") but must still never be highlighted once the filter excludes it.
await fetchJson('/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: 'low-stock-highlight-matching', name: 'Matching Product', color: '#ff0000',
    dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, stockQuantity: 1,
  }),
});
await fetchJson('/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: 'low-stock-highlight-unmatching', name: 'Unmatching Product', color: '#00ff00',
    dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, stockQuantity: 50,
  }),
});

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: MATCHING_INSTANCE_ID, landletId: landlet.landletId, templateId: 'low-stock-highlight-matching', x: 0, y: 0 }),
});
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: UNMATCHING_INSTANCE_ID, landletId: landlet.landletId, templateId: 'low-stock-highlight-unmatching', x: 5, y: 5 }),
});

// Both instances were placed via a direct API call, not the live page's own
// placement flow -- a reload is needed so bootstrap() actually loads them
// into productMeshes, the same way the manual verification for #1949 needed
// one to see freshly-API-placed instances show up at all. A raw reload
// lands in Shop mode by default (see START_MODE_KEY's own comment in
// src/main.js) unless this is set first, the same way every one of the
// app's own reload-triggering paths (mode-nav, logout) already does --
// confirmed via bundle-rename-sync.test.mjs's own identical comment.
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'build'));
await page.reload();
await page.waitForFunction(() => typeof window.__testLowStockHighlightedInstanceIds === 'function', undefined, { timeout: 20000 });
await page.waitForTimeout(500);

const beforeFilter = await page.evaluate(() => window.__testLowStockHighlightedInstanceIds());
console.log('highlighted instances before any filter is set (should be empty):', beforeFilter);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForSelector('.low-stock-list', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.low-stock-row').length >= 2, undefined, { timeout: 10000 });

const qtyInput = page.locator('.low-stock-filter-input').first();
await qtyInput.fill('1');

await page.waitForFunction(
  (id) => window.__testLowStockHighlightedInstanceIds().includes(id),
  MATCHING_INSTANCE_ID,
  { timeout: 5000 },
);
const afterFilter = await page.evaluate(() => window.__testLowStockHighlightedInstanceIds());
console.log('highlighted instances after setting "Max remaining" to 1 (should be exactly the matching instance):', afterFilter);

// Closing Settings must not clear the highlight -- the whole point is
// finding the item in the live 3D view without the list still open.
await page.click('#settings-close-btn');
await page.waitForTimeout(300);
const afterClose = await page.evaluate(() => window.__testLowStockHighlightedInstanceIds());
console.log('highlighted instances after closing Settings (should be unchanged):', afterClose);

// Reopening Settings and clearing the filter back to "Any" should remove
// the highlight again.
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForSelector('.low-stock-list', { timeout: 10000 });
const reopenedQtyInput = page.locator('.low-stock-filter-input').first();
const restoredValue = await reopenedQtyInput.inputValue();
console.log('filter input value after reopening Settings (should still read "1", confirming it persisted):', restoredValue);
await reopenedQtyInput.fill('');
await page.waitForFunction(() => window.__testLowStockHighlightedInstanceIds().length === 0, undefined, { timeout: 5000 });
const afterClear = await page.evaluate(() => window.__testLowStockHighlightedInstanceIds());
console.log('highlighted instances after clearing the filter back to "Any" (should be empty):', afterClear);

const pass = beforeFilter.length === 0
  && afterFilter.length === 1 && afterFilter[0] === MATCHING_INSTANCE_ID
  && afterClose.length === 1 && afterClose[0] === MATCHING_INSTANCE_ID
  && restoredValue === '1'
  && afterClear.length === 0
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#1950: the low-stock filter highlights only matching placed items in the 3D view, survives closing Settings, and clears when the filter is cleared',
  errors,
});
