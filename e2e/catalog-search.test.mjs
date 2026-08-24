// The Add Item catalog picker's search box filters tiles by name
// client-side, resets on reopen, and shows an empty-state message when
// nothing matches.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Catalog Search Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

const totalTiles = await page.locator('#catalog-picker-grid .catalog-tile').count();
console.log('total catalog tiles with no search (should be > 1):', totalTiles);

await page.fill('#catalog-search-input', 'Tree');
await page.waitForTimeout(200);
const visibleAfterTreeSearch = await page.locator('#catalog-picker-grid .catalog-tile:not([hidden])').count();
const treeTileVisible = await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' }).isVisible();
const brickTileHidden = await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Brick' }).isHidden();
console.log('visible tiles after searching "Tree" (should be fewer than total):', visibleAfterTreeSearch, 'of', totalTiles);
console.log('Tree tile visible (should be true):', treeTileVisible);
console.log('Brick tile hidden (should be true):', brickTileHidden);

// Clear the search — everything comes back.
await page.fill('#catalog-search-input', '');
await page.waitForTimeout(200);
const visibleAfterClear = await page.locator('#catalog-picker-grid .catalog-tile:not([hidden])').count();
console.log('visible tiles after clearing search (should equal total):', visibleAfterClear, 'of', totalTiles);

// A query that matches nothing shows the empty state, naming the query.
await page.fill('#catalog-search-input', 'zzznomatchzzz');
await page.waitForTimeout(200);
const emptyStateVisible = await page.locator('#catalog-picker-empty').isVisible();
const emptyStateText = await page.locator('#catalog-picker-empty').textContent();
console.log('empty state visible for an unmatched query (should be true):', emptyStateVisible);
console.log('empty state text (should mention the query):', emptyStateText);

// Close and reopen — the search field resets, not carrying the query over.
await page.click('#catalog-picker-close-btn');
await page.waitForTimeout(300);
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const searchValueAfterReopen = await page.locator('#catalog-search-input').inputValue();
const visibleAfterReopen = await page.locator('#catalog-picker-grid .catalog-tile:not([hidden])').count();
console.log('search field reset after reopening (should be empty):', JSON.stringify(searchValueAfterReopen));
console.log('all tiles visible again after reopening (should equal total):', visibleAfterReopen, 'of', totalTiles);

const pass = totalTiles > 1 &&
  visibleAfterTreeSearch > 0 && visibleAfterTreeSearch < totalTiles &&
  treeTileVisible && brickTileHidden &&
  visibleAfterClear === totalTiles &&
  emptyStateVisible && emptyStateText.includes('zzznomatchzzz') &&
  searchValueAfterReopen === '' && visibleAfterReopen === totalTiles &&
  errors.length === 0;
await finish(browser, { pass, label: 'Add Item catalog picker search/filter', errors });
