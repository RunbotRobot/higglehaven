// #3873: Build's start asked for "my lándlet" only after the builder id came back (two requests back to back). For an
// account already verified it now asks `ownerBuilderId=me` while GET /api/builders/me is still in flight, so the
// two overlap. Here a builder with a claimed lándlet enters Build again: the early ask must be the one sent (no
// second ask by the builder's own id), it must start before builders/me has answered, the lándlet must load, and
// nothing may be refused (a 403 would log a console error).
import { launchPage, chooseIdentity, claimLandlet, goToMode, finish } from './helpers.mjs';

const LABEL = 'Early Landlet Tester';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForFunction(() => document.body?.dataset.mode === 'build', null, { timeout: 30000 });

const seen = [];
let buildersMeAnswered = false;
page.on('request', (request) => {
  const url = request.url();
  if (url.includes('/api/landlets?') && url.includes('ownerBuilderId=')) seen.push({ url, buildersMeAnswered });
});
page.on('response', (response) => { if (response.url().endsWith('/api/builders/me')) buildersMeAnswered = true; });

// Leave Build for Shop and come back: each mode switch reloads the page into the new mode.
await goToMode(page, 'shop');
await page.waitForSelector('body.shop-ready', { timeout: 30000 });
seen.length = 0;
buildersMeAnswered = false;
await goToMode(page, 'build');
await page.waitForFunction(() => document.body?.dataset.mode === 'build', null, { timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);

const asks = seen.filter((entry) => entry.url.includes('status=claimed'));
console.log('lándlet asks on re-entering Build:', JSON.stringify(asks.map((a) => ({ url: a.url.replace(/^.*\/api/, ''), afterBuildersMe: a.buildersMeAnswered }))));
const early = asks.length === 1 && asks[0].url.includes('ownerBuilderId=me') && asks[0].buildersMeAnswered === false;
await finish(browser, {
  pass: early && errors.length === 0,
  label: '#3873: Build asks for my lándlet while the builder id is still on its way, once, and nothing is refused',
  errors,
});
