// #3889: a failed equip or "Load more" in Settings > Shop is said in the list
// where the control was used (the owner decision "A message that limits or
// refuses an action ...", the shapes in docs/DESIGN.md "Things said out of
// turn"), not in a modal over the world. The owned lists are mocked so no
// product has to be bought; every failure is a 500 from a mocked route.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function patch(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patch);
await page.route('**/api/auth/signup', patch);

// A request carrying a cursor is the "Load more" click: it fails; the first page succeeds.
await page.route('**/api/builders/me/avatars*', (route) => (route.request().url().includes('cursor=')
  ? json(route, 500, { error: 'The avatar list is down.' })
  : json(route, 200, { avatars: [{ templateId: 'mock-avatar', name: 'Mock Avatar', purchasedAt: null }], nextCursor: 'more-avatars' })));
await page.route('**/api/builders/me/avatar', (route) => (route.request().method() === 'PUT'
  ? json(route, 500, { error: 'The equip service is down.' })
  : json(route, 200, { avatar: { equippedTemplateId: null, modelUrl: null } })));
await page.route('**/api/builders/me/animations*', (route) => (route.request().url().includes('cursor=')
  ? json(route, 500, { error: 'The animation list is down.' })
  : json(route, 200, { animations: [{ templateId: 'mock-anim', name: 'Mock Dance', purchasedAt: null, skeletonSignature: null }], nextCursor: 'more-animations' })));
await page.route('**/api/builders/me/animation', (route) => (route.request().method() === 'PUT'
  ? json(route, 500, { error: 'The animation service is down.' })
  : json(route, 200, { animation: { equippedTemplateId: null } })));

await chooseIdentity(page, { mode: 'shop', label: 'EquipFail' + (Date.now() % 100000), isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');

const avatars = page.locator('.settings-field', { hasText: 'My avatars' });
const animations = page.locator('.settings-field', { hasText: 'My animations' });
await avatars.locator('.version-row', { hasText: 'Mock Avatar' }).waitFor({ timeout: 30000 });
await animations.locator('.version-row', { hasText: 'Mock Dance' }).waitFor({ timeout: 30000 });

// The two "Load more" and two equip failures: the page also logs the mocked 500s as console errors.
const modalCount = () => page.evaluate(() => document.querySelectorAll('#notice-modal.visible, .notice-modal.visible').length);
const results = {};

await avatars.locator('.version-row', { hasText: 'Mock Avatar' }).locator('button', { hasText: 'Equip' }).click();
await avatars.locator('.inline-action-status', { hasText: "Couldn't equip this avatar" }).waitFor({ timeout: 10000 });
results.equipAvatar = await avatars.locator('.inline-action-status').first().textContent();

await animations.locator('.version-row', { hasText: 'Mock Dance' }).locator('button', { hasText: 'Apply' }).click();
await animations.locator('.inline-action-status', { hasText: "Couldn't apply this animation" }).waitFor({ timeout: 10000 });
results.applyAnimation = await animations.locator('.inline-action-status').first().textContent();

await avatars.locator('button', { hasText: 'Load more' }).click();
await avatars.locator('.inline-action-status', { hasText: "Couldn't load more avatars" }).waitFor({ timeout: 10000 });
await animations.locator('button', { hasText: 'Load more' }).click();
await animations.locator('.inline-action-status', { hasText: "Couldn't load more animations" }).waitFor({ timeout: 10000 });
results.loadMoreAvatars = await avatars.locator('.inline-action-status', { hasText: "Couldn't load more avatars" }).textContent();
results.loadMoreAnimations = await animations.locator('.inline-action-status', { hasText: "Couldn't load more animations" }).textContent();

results.modals = await modalCount();
results.retryEnabled = await avatars.locator('.version-row', { hasText: 'Mock Avatar' }).locator('button', { hasText: 'Equip' }).isEnabled();
// Selectable: the status must not disable text selection or pointer events.
results.selectable = await page.evaluate(() => {
  const el = document.querySelector('.inline-action-status');
  const cs = getComputedStyle(el);
  return cs.userSelect !== 'none' && cs.pointerEvents !== 'none';
});
console.log('equip failure said in the list:', results);

const pass = /Couldn't equip this avatar\. The equip service is down\./.test(results.equipAvatar || '')
  && /Couldn't apply this animation\. The animation service is down\./.test(results.applyAnimation || '')
  && /Couldn't load more avatars\. The avatar list is down\./.test(results.loadMoreAvatars || '')
  && /Couldn't load more animations\. The animation list is down\./.test(results.loadMoreAnimations || '')
  && results.modals === 0 && results.retryEnabled && results.selectable;
// The mocked 500s are the only console errors this test provokes on purpose.
const unexpected = errors.filter((e) => !/status of 500|500 \(|Failed to load resource/.test(String(e)));
await finish(browser, { pass, label: 'Failed equips and load-more in Settings > Shop are said in their lists, not in a modal (#3889)', errors: unexpected });
