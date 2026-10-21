// #2068 (leaf sub-issue of #1973/#1947, owner requirement): "On the build
// screen looking at their land, they should be able to toggle on/off
// grayed-out items that have disappeared which they haven't dismissed
// yet." Asserts the 3D ghost-box rendering via window.__testSoldOutMarkerMeshIds
// (the established window.__test* hook convention this codebase already
// uses for otherwise-unreachable 3D scene state, e.g.
// window.__testLowStockHighlightedInstanceIds for #1950's sibling panel),
// not DOM/pixel inspection, plus a real click through the Settings > Build
// panel's toggle and per-marker Dismiss button.
import { launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish, emailForLabel, grantAdmin } from './helpers.mjs';

const LABEL = 'Sold Out Marker Tester';
const INSTANCE_ID = 'sold-out-marker-instance';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

// A one-of-a-kind (stockQuantity 1) product -- one purchase sweeps it from
// every landlet it's placed on and creates exactly one sold_out_markers row.
await fetchJson('/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: 'sold-out-marker-template', name: 'Marker Fixture Product', color: '#ff00ff',
    dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, stockQuantity: 1,
  }),
});

const { builders } = (await fetchJson('/api/builders')).body;
const builder = builders.find((b) => b.label === LABEL);
const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${builder.builderId}&limit=100`)).body;
const landlet = landlets[0];

await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: INSTANCE_ID, landletId: landlet.landletId, templateId: 'sold-out-marker-template', x: 2, y: 3 }),
});
// #653: the simulated path is now admin-only (this template has no
// seller_id at all here, so it's never Stripe-connected either) — grant
// it to this same browser-session account rather than switching to a
// separate one, so this purchase still lands against the landlet this
// test already built up under this session's own cookie.
await grantAdmin(emailForLabel(LABEL));
const purchased = await fetchJson(`/api/instances/${INSTANCE_ID}/purchase`, { method: 'POST' });
console.log('purchase that sells out the template (should be 201):', purchased.status);

// Reload so bootstrap() picks up Build mode fresh -- same reasoning
// low-stock-highlight.test.mjs's own identical reload comment explains.
await page.evaluate(() => sessionStorage.setItem('higglehaven.startMode', 'build'));
await page.reload();
await page.waitForFunction(() => typeof window.__testSoldOutMarkerMeshIds === 'function', undefined, { timeout: 20000 });
await page.waitForTimeout(500);

const beforeToggle = await page.evaluate(() => window.__testSoldOutMarkerMeshIds());
console.log('ghost-box markers rendered before opening Settings/toggling on (should be empty):', beforeToggle);

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForSelector('.sold-out-marker-list', { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('.sold-out-marker-row').length >= 1, undefined, { timeout: 10000 });

const rowText = await page.locator('.sold-out-marker-row-info').first().textContent();
console.log('sold-out marker row text (should mention the product name):', rowText);

// The toggle defaults off -- no ghost boxes until it's actually checked.
const stillBeforeToggle = await page.evaluate(() => window.__testSoldOutMarkerMeshIds());
console.log('ghost-box markers rendered with the list visible but the toggle still off (should be empty):', stillBeforeToggle);

await page.click('#sold-out-marker-toggle');
await page.waitForFunction(() => window.__testSoldOutMarkerMeshIds().length === 1, undefined, { timeout: 5000 });
const afterToggle = await page.evaluate(() => window.__testSoldOutMarkerMeshIds());
console.log('ghost-box markers rendered after checking the toggle (should be exactly one):', afterToggle);

// Unchecking removes the ghost box again without needing to reload the list.
await page.click('#sold-out-marker-toggle');
await page.waitForFunction(() => window.__testSoldOutMarkerMeshIds().length === 0, undefined, { timeout: 5000 });
const afterUntoggle = await page.evaluate(() => window.__testSoldOutMarkerMeshIds());
console.log('ghost-box markers rendered after unchecking the toggle (should be empty):', afterUntoggle);

// Re-check it, then dismiss via the list's own button -- both the row and
// the ghost box should disappear together, and the real DELETE should have
// actually landed server-side (re-fetchable via GET, confirmed below).
await page.click('#sold-out-marker-toggle');
await page.waitForFunction(() => window.__testSoldOutMarkerMeshIds().length === 1, undefined, { timeout: 5000 });
await page.click('.sold-out-marker-row-dismiss');
await page.waitForFunction(() => document.querySelectorAll('.sold-out-marker-row').length === 0, undefined, { timeout: 5000 });
const afterDismiss = await page.evaluate(() => window.__testSoldOutMarkerMeshIds());
console.log('ghost-box markers rendered after dismissing via the list (should be empty):', afterDismiss);
const emptyNoteVisible = await page.locator('.settings-field:has(.sold-out-marker-list) .settings-empty-note').isVisible();
console.log('empty-state note visible after the only marker is dismissed (should be true):', emptyNoteVisible);

const refetched = await fetchJson(`/api/landlets/${landlet.landletId}/sold-out-markers`);
console.log('markers refetched directly from the API after dismissing (should be empty):', refetched.body.markers);

const pass = purchased.status === 201
  && beforeToggle.length === 0
  && rowText.includes('Marker Fixture Product')
  && stillBeforeToggle.length === 0
  && afterToggle.length === 1
  && afterUntoggle.length === 0
  && afterDismiss.length === 0
  && emptyNoteVisible === true
  && refetched.body.markers.length === 0
  && errors.length === 0;
await finish(browser, {
  pass,
  label: '#2068: Build-mode sold-out markers toggle on/off as grayed-out ghost boxes and can be dismissed from the Settings panel',
  errors,
});
