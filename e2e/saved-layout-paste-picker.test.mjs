// #648: fixes a real gap in #636's own shipped implementation, which
// assumed a builder can only ever hold one claimed landlet and always
// pasted onto whichever one an unordered query happened to return first,
// with no way to choose otherwise. That assumption is false in this
// codebase — #199 (see LANDLET_RELEASED_VIA_AUCTION_SQL's own comment in
// worker/index.js) frees a seller's "one claimed landlet" slot the moment
// they start even a $0 auction on it, letting them claim a second one
// immediately, no bid or resolution required (the same setup shortcut
// e2e/land-auctions.test.mjs's own picker test already uses). This test's
// own point is the picker itself: it only appears once the builder owns
// more than one claimed landlet, defaults sensibly, and actually lets a
// different target be chosen and pasted onto.
import {
  launchPage, chooseIdentity, claimLandlet, openAccountMenu, finish,
  grantLandCapHeadroomAsAdmin, createGreenbeltLandletAsAdmin,
} from './helpers.mjs';

const LABEL = 'Saved Layout Paste Picker Suite Tester';
const LEVEL_HEIGHT_M = 10;
const SECOND_LANDLET_ID = 'saved-layout-paste-picker-second-landlet';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

async function fetchJson(pathAndQuery, options) {
  return page.evaluate(async ([p, opts]) => {
    const res = await fetch(p, opts);
    return { status: res.status, body: await res.json() };
  }, [pathAndQuery, options]);
}

const { builders } = (await fetchJson('/api/builders')).body;
const me = builders.find((b) => b.label === LABEL);
await grantLandCapHeadroomAsAdmin(me.builderId);

const { landlets } = (await fetchJson(`/api/landlets?status=claimed&ownerBuilderId=${me.builderId}&limit=100`)).body;
const firstLandletId = landlets[0].landletId;

// Build up a real saved layout on the first landlet, same shape as the
// other saved-layout e2e suites.
await fetchJson(`/api/landlets/${firstLandletId}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});
await fetchJson('/api/instances', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    instanceId: 'saved-layout-paste-picker-instance', landletId: firstLandletId, templateId: 'placeholder-tree', x: 6, y: 7, z: LEVEL_HEIGHT_M * 1.5,
  }),
});
await fetchJson(`/api/landlets/${firstLandletId}/levels/1`, { method: 'DELETE' });

// #199: a $0-starting auction frees the "one claimed landlet" slot
// immediately, letting this same builder claim a second one right away —
// no bid, no resolution, no second party needed.
const auctionStarted = await fetchJson(`/api/landlets/${firstLandletId}/auction`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startingBidCents: 0 }),
});
console.log('starting a $0 auction to free the claim slot (should be 201):', auctionStarted.status);

await createGreenbeltLandletAsAdmin(SECOND_LANDLET_ID);
const secondClaimed = await fetchJson(`/api/landlets/${SECOND_LANDLET_ID}/claim`, { method: 'POST' });
console.log('claiming a second landlet while the first has a live $0 auction (should be 200):', secondClaimed.status);

// The second landlet needs its own level for the saved instance's z=15 to
// fit once pasted there — same z-bounds requirement any normal
// instance-create has.
await fetchJson(`/api/landlets/${SECOND_LANDLET_ID}/levels`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
});

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="build"]');
await page.waitForFunction(() => document.querySelectorAll('.version-row').length >= 1, { timeout: 10000 });
const savedLayoutRow = page.locator('.settings-field', { hasText: 'Saved Layouts' }).locator('.version-row');
await savedLayoutRow.locator('button', { hasText: 'Preview' }).click();
await page.waitForFunction(() => document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForTimeout(1000); // let the model actually load/render, and the picker to populate, before interacting

const pickerHiddenInitially = await page.locator('#layout-preview-paste-target').isHidden();
console.log('picker starts hidden while it populates (may be true or already-populated-and-visible by now):', pickerHiddenInitially);

await page.waitForFunction(
  () => document.getElementById('layout-preview-paste-target')?.options.length === 2,
  { timeout: 10000 },
);
const pickerVisible = await page.locator('#layout-preview-paste-target').isVisible();
console.log('picker visible once the builder owns 2 claimed landlets (should be true):', pickerVisible);
const pickerOptionValues = await page.locator('#layout-preview-paste-target option').evaluateAll((opts) => opts.map((o) => o.value));
console.log('picker option values (should contain both owned landlets):', pickerOptionValues);
const defaultSelection = await page.locator('#layout-preview-paste-target').inputValue();
console.log('picker defaults to the landlet Build mode was last on (should be the first landlet):', defaultSelection);

// Select the SECOND landlet and paste onto it instead of the default.
await page.selectOption('#layout-preview-paste-target', SECOND_LANDLET_ID);
await page.mouse.move(10, 10);
await page.mouse.down();
await page.mouse.move(410, 850, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const selectionAfterDrag = await page.locator('#layout-preview-selection-count').textContent();
console.log('selection count after marquee-drag (should be "1 selected"):', selectionAfterDrag);

await page.click('#layout-preview-paste-btn');
await page.waitForFunction(() => !document.getElementById('layout-preview-toolbar')?.classList.contains('visible'), { timeout: 15000 });
await page.waitForSelector('#add-item-btn', { timeout: 10000 });

const onFirstLandlet = (await fetchJson(`/api/instances?landletId=${firstLandletId}&limit=100`)).body.instances;
const onSecondLandlet = (await fetchJson(`/api/instances?landletId=${SECOND_LANDLET_ID}&limit=100`)).body.instances;
console.log('instances on the FIRST (default/unselected) landlet after pasting onto the picked one (should be 0):', onFirstLandlet.length);
console.log('instances on the SECOND (picked) landlet after pasting (should be 1):', onSecondLandlet.length);
const landedOnChosenTarget = onFirstLandlet.length === 0 && onSecondLandlet.length === 1 &&
  onSecondLandlet[0].x === 6 && onSecondLandlet[0].y === 7 && onSecondLandlet[0].z === LEVEL_HEIGHT_M * 1.5;

const pass = auctionStarted.status === 201 &&
  secondClaimed.status === 200 &&
  pickerVisible &&
  pickerOptionValues.length === 2 &&
  pickerOptionValues.includes(firstLandletId) &&
  pickerOptionValues.includes(SECOND_LANDLET_ID) &&
  defaultSelection === firstLandletId &&
  selectionAfterDrag.includes('1 selected') &&
  landedOnChosenTarget &&
  errors.length === 0;
await finish(browser, { pass, label: 'Saved-layout paste shows a real landlet picker for a builder owning two claimed landlets (#648)', errors });
