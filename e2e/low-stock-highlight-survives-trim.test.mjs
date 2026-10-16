// #2342: replaceMeshWithCrop (the Trim tool's commit path) swaps a mesh in
// productMeshes/scene without going through addInstanceToScene's own
// "single choke point" for addLowStockHighlight -- so trimming a
// low-stock-highlighted item used to leave the highlight's BoxHelper+fill
// permanently orphaned on the disposed old mesh (never cleaned up, since
// updateLowStockHighlights only ever iterates the *current* productMeshes)
// while the new, still-matching mesh never got highlighted at all. Asserts
// via window.__testLowStockHighlightTracksLiveMesh/__testLowStockHighlightCount
// (the established window.__test* hook convention, e.g.
// window.__testLowStockHighlightedInstanceIds from #1950) rather than
// DOM/pixel inspection. Sets up the scenario entirely via direct API calls
// (same idiom as low-stock-highlight.test.mjs) -- extensibility works on the
// box-geometry fallback with no real uploaded model (docs/API.md's
// "Extensible products (crop)"), so there's no need to drive the Sell-mode
// upload flow just to get a croppable instance.
import { launchPage, chooseIdentity, claimLandlet, clickUntilSelected, finish } from './helpers.mjs';

const LABEL = 'Low Stock Trim Tester';
const PRODUCT_NAME = 'Low Stock Trim Product';
const INSTANCE_ID = 'low-stock-highlight-trim-instance';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// One-of-a-kind stock (matches a "max remaining: 1" filter) and extensible
// on x with a 0.2m minimum, so the Trim tool's x-axis field is active.
await fetchJson('/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: 'low-stock-highlight-trim-template', name: PRODUCT_NAME, color: '#3366cc',
    dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, stockQuantity: 1,
    metadata: { extensible: { x: { minM: 0.2 } } },
  }),
});

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: INSTANCE_ID, landletId: landlet.landletId, templateId: 'low-stock-highlight-trim-template', x: 0, y: 0 }),
});

// Placed via a direct API call, not the live page's own placement flow -- a
// reload is needed so bootstrap() actually loads it into productMeshes,
// same reasoning as low-stock-highlight.test.mjs's own identical comment.
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'build'));
await page.reload();
await page.waitForFunction(() => typeof window.__testLowStockHighlightedInstanceIds === 'function', undefined, { timeout: 20000 });
await page.waitForTimeout(500);

// Turn on the low-stock filter so this instance gets highlighted.
await page.click('#account-menu-toggle');
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForSelector('.low-stock-list', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.low-stock-row').length >= 1, undefined, { timeout: 10000 });
const qtyInput = page.locator('.low-stock-filter-input').first();
await qtyInput.fill('1');
await page.waitForFunction(
  (id) => window.__testLowStockHighlightedInstanceIds().includes(id),
  INSTANCE_ID,
  { timeout: 5000 },
);
const highlightedBeforeTrim = await page.evaluate(() => window.__testLowStockHighlightedInstanceIds());
const countBeforeTrim = await page.evaluate(() => window.__testLowStockHighlightCount());
console.log('highlighted instances before trim (should be exactly the placed instance):', highlightedBeforeTrim);

await page.click('#settings-close-btn');
await page.waitForTimeout(300);

// Select it and trim it via the typed-length field -- the same
// replaceMeshWithCrop commit path the drag handle uses. Placed via a
// direct API call rather than the live page's own placement flow, so its
// screen position isn't known in advance -- scan for it the same way
// extensibility-trim.test.mjs's own reselect-after-reload step does.
const productInfo = await clickUntilSelected(page, {
  x: 210, yStart: 300, yEnd: 500, expectedText: PRODUCT_NAME,
});
console.log('selected product before trimming (should mention the product):', productInfo);
await page.click('#mode-trim');
await page.waitForTimeout(500);
await page.fill('.trim-axis-field[data-trim-axis="x"] .trim-length-input', '0.5');
await page.locator('.trim-axis-field[data-trim-axis="x"] .trim-length-input').dispatchEvent('change');
await page.waitForTimeout(800);

const tracksLiveMeshAfterTrim = await page.evaluate(
  (id) => window.__testLowStockHighlightTracksLiveMesh(id),
  INSTANCE_ID,
);
const countAfterTrim = await page.evaluate(() => window.__testLowStockHighlightCount());
console.log('highlight tracks the live (post-trim) mesh (should be true):', tracksLiveMeshAfterTrim);
console.log('highlight entry count before/after trim (should both be 1, no orphan left behind):', countBeforeTrim, countAfterTrim);

const pass = productInfo.includes(PRODUCT_NAME)
  && highlightedBeforeTrim.length === 1 && highlightedBeforeTrim[0] === INSTANCE_ID
  && countBeforeTrim === 1
  && tracksLiveMeshAfterTrim === true
  && countAfterTrim === 1
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2342: trimming a low-stock-highlighted item transfers the highlight to the new mesh instead of orphaning it',
  errors,
});
