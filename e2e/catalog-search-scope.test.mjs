// #1082: the Add Item catalog picker's search box is unified across both
// the product grid and the bundle section below it, with a three-way
// scope toggle (All / Products / Bundles) picking which section(s) the
// query — and each section's own visibility — applies to.
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';

const LABEL = 'Search Scope Tester';
const BUNDLE_NAME = 'Forest Set';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);

// Place a single tree — a single-item placement is auto-selected
// (handlePlacementClick's own selectOnly for a 'template' placement, same
// as e2e/bundles.test.mjs relies on for its second tree), so Save Bundle
// is immediately available with no Multi-Select step needed.
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
await page.locator('#catalog-picker-grid button').filter({ hasText: 'Tree' }).click();
await page.waitForTimeout(300);
await page.mouse.click(200, 450);
await page.waitForTimeout(800);

// Name it something that shares no substring with any stock product name
// (notably "Tree"), so the two searches below can tell products and
// bundles apart unambiguously.
await page.evaluate((name) => { window.prompt = () => name; }, BUNDLE_NAME);
await page.click('#save-bundle-item');
await page.waitForFunction(
  () => document.getElementById('product-info').textContent.includes('Saved'),
  { timeout: 10000 },
);

await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });

const totalProductTiles = await page.locator('#catalog-picker-grid .catalog-tile').count();
const defaultScopeActive = await page.locator('.search-scope-btn[data-search-scope="both"]').evaluate((el) => el.classList.contains('active'));
console.log('reopens with "All" scope active by default (should be true):', defaultScopeActive);

// Default scope ("All") — searching the bundle's own name should filter
// the product grid down to nothing (no stock product is named "Forest")
// while leaving the bundle tile itself visible.
await page.fill('#catalog-search-input', 'Forest');
await page.waitForTimeout(200);
const productsVisibleOnBundleNameSearch = await page.locator('#catalog-picker-grid .catalog-tile:not([hidden])').count();
const catalogEmptyVisible = await page.locator('#catalog-picker-empty').isVisible();
const bundleTileVisibleOnBundleNameSearch = await page.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME }).isVisible();
console.log('product tiles visible searching the bundle\'s own name (should be 0):', productsVisibleOnBundleNameSearch);
console.log('catalog empty-state visible (should be true):', catalogEmptyVisible);
console.log('bundle tile still visible searching its own name under "All" scope (should be true):', bundleTileVisibleOnBundleNameSearch);

// Still default scope — searching "Tree" should show the product but hide
// the bundle (whose name doesn't contain "tree"), with the bundle section's
// own empty-state switching to a "no match" message.
await page.fill('#catalog-search-input', 'Tree');
await page.waitForTimeout(200);
const treeTileVisible = await page.locator('#catalog-picker-grid .catalog-tile').filter({ hasText: 'Tree' }).isVisible();
const bundleTileHiddenOnTreeSearch = await page.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME }).isHidden();
const bundleEmptyTextOnTreeSearch = await page.locator('#bundle-picker-empty').textContent();
console.log('Tree product tile visible (should be true):', treeTileVisible);
console.log('bundle tile hidden searching "Tree" (should be true):', bundleTileHiddenOnTreeSearch);
console.log('bundle empty-state text (should mention no match for "Tree"):', bundleEmptyTextOnTreeSearch);

// Clear the query, then narrow scope to Products only — the whole bundle
// section should disappear outright, not just fail to match.
await page.fill('#catalog-search-input', '');
await page.click('.search-scope-btn[data-search-scope="products"]');
await page.waitForTimeout(200);
const bundleSectionHiddenInProductsScope = await page.locator('#bundle-picker-section').isHidden();
const productGridVisibleInProductsScope = await page.locator('#catalog-picker-grid').isVisible();
const visibleProductsInProductsScope = await page.locator('#catalog-picker-grid .catalog-tile:not([hidden])').count();
console.log('bundle section hidden under Products-only scope (should be true):', bundleSectionHiddenInProductsScope);
console.log('product grid still visible under Products-only scope (should be true):', productGridVisibleInProductsScope);
console.log('all products visible under Products-only scope with no query (should equal total):', visibleProductsInProductsScope, 'of', totalProductTiles);

// Switch to Bundles only — the reverse: the product grid disappears
// outright and the bundle section (and its one tile) shows.
await page.click('.search-scope-btn[data-search-scope="bundles"]');
await page.waitForTimeout(200);
const productGridHiddenInBundlesScope = await page.locator('#catalog-picker-grid').isHidden();
const bundleSectionVisibleInBundlesScope = await page.locator('#bundle-picker-section').isVisible();
const bundleTileVisibleInBundlesScope = await page.locator('.bundle-tile').filter({ hasText: BUNDLE_NAME }).isVisible();
console.log('product grid hidden under Bundles-only scope (should be true):', productGridHiddenInBundlesScope);
console.log('bundle section visible under Bundles-only scope (should be true):', bundleSectionVisibleInBundlesScope);
console.log('bundle tile visible under Bundles-only scope with no query (should be true):', bundleTileVisibleInBundlesScope);

// Close and reopen — both the query and the scope reset to "All" (not
// just the query), so neither section is silently left hidden.
await page.click('#catalog-picker-close-btn');
await page.waitForTimeout(300);
await page.click('#add-item-btn');
await page.waitForSelector('#catalog-picker.visible', { timeout: 10000 });
const scopeResetToAllOnReopen = await page.locator('.search-scope-btn[data-search-scope="both"]').evaluate((el) => el.classList.contains('active'));
const productGridVisibleOnReopen = await page.locator('#catalog-picker-grid').isVisible();
const bundleSectionVisibleOnReopen = await page.locator('#bundle-picker-section').isVisible();
console.log('scope reset to "All" on reopen (should be true):', scopeResetToAllOnReopen);
console.log('product grid visible again on reopen (should be true):', productGridVisibleOnReopen);
console.log('bundle section visible again on reopen (should be true):', bundleSectionVisibleOnReopen);

const pass = defaultScopeActive &&
  productsVisibleOnBundleNameSearch === 0 && catalogEmptyVisible &&
  bundleTileVisibleOnBundleNameSearch &&
  treeTileVisible && bundleTileHiddenOnTreeSearch && bundleEmptyTextOnTreeSearch.includes('Tree') &&
  bundleSectionHiddenInProductsScope && productGridVisibleInProductsScope &&
  visibleProductsInProductsScope === totalProductTiles &&
  productGridHiddenInBundlesScope && bundleSectionVisibleInBundlesScope && bundleTileVisibleInBundlesScope &&
  scopeResetToAllOnReopen && productGridVisibleOnReopen && bundleSectionVisibleOnReopen &&
  errors.length === 0;
await finish(browser, { pass, label: 'Unified catalog/bundle search scope toggle (#1082)', errors });
