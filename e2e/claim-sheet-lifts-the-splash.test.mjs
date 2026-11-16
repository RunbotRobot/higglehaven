// #3562: Build with no landlet stops at the claim sheet, and bootstrap() does not
// settle until a landlet is claimed, so the title splash (#loading-screen) used
// to stay solid behind the sheet, hiding the world the sheet says to fly around.
// The claim flow lifts the splash as it opens the sheet.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Claim Splash Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await page.waitForSelector('#claim-modal.visible', { timeout: 10000 });
// The fade is a CSS transition; the class is the signal, the computed opacity the proof.
const splashHidden = await page.waitForFunction(
  () => document.getElementById('loading-screen')?.classList.contains('loading-screen-hidden') === true,
  null,
  { timeout: 10000 },
).then(() => true).catch(() => false);
const opacity = await page.evaluate(() => {
  const el = document.getElementById('loading-screen');
  return el ? Number(getComputedStyle(el).opacity) : 0;
});
console.log('splash lifted while the claim sheet is open (should be true):', splashHidden);
console.log('splash opacity once lifted (should be 0, or removed):', opacity);

const pass = splashHidden && opacity < 0.05 && errors.length === 0;
await finish(browser, { pass, label: 'claim-sheet-lifts-the-splash', errors });
