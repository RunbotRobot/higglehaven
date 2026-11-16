// #3568: Settings > Shop does not draw "My Avatars" or "My Animations" for a
// shopper who owns neither. A new account has nothing to pick, so both
// sections (and the disabled Equip button) stay out of sight.
import { launchPage, chooseIdentity, openAccountMenu, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ viewport: { width: 390, height: 844 } });
async function patch(route) {
  const response = await route.fetch();
  const body = await response.json();
  if (body.user) body.user.trustTier = 'id_verified';
  await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
}
await page.route('**/api/auth/me', patch);
await page.route('**/api/auth/signup', patch);
await chooseIdentity(page, { mode: 'shop', label: 'EmptyShop' + (Date.now() % 100000), isNew: true });
await page.waitForSelector('body.shop-ready', { timeout: 30000 });

await openAccountMenu(page);
await page.click('#settings-btn');
await page.waitForSelector('#settings-modal.visible', { timeout: 5000 });
await page.click('.settings-tab-btn[data-section="shop"]');
// The Camera field is always there; give the two owned-item loads time to settle.
await page.waitForFunction(() => document.body.textContent.includes('Ease the camera back'), null, { timeout: 10000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(500);

const state = await page.evaluate(() => {
  const visible = (text) => [...document.querySelectorAll('.settings-field')]
    .some((f) => f.textContent.includes(text) && getComputedStyle(f).display !== 'none');
  return {
    avatars: visible('My Avatars'),
    animations: visible('My Animations'),
    equipButtons: [...document.querySelectorAll('#settings-modal .version-action-btn')].filter((b) => b.offsetParent !== null).length,
    emptyLine: document.body.innerText.includes("don't own any standalone animations"),
  };
});
console.log('Settings > Shop for an empty-handed shopper:', state);
const pass = !state.avatars && !state.animations && state.equipButtons === 0 && !state.emptyLine;
await finish(browser, { pass, label: 'Settings > Shop hides empty avatar and animation sections (#3568)', errors });
