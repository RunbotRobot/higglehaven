// #4298 (found in the #4277 audit): Shop asks once, at entry, for the names of the builders who own the lándlets
// in view (`GET /api/builders?ids=...`). That read used `.catch(() => {})`, so one failed request left "an unknown
// builder" on every lándlet for the whole session. It is now asked again after a short wait. This aborts the
// FIRST such request, stands on another builder's lándlet, and expects that builder's name to appear without a reload.
import { launchPage, chooseIdentity, claimLandlet, finish, shopStickBox } from './helpers.mjs';

const OWNER = 'Builder Names Retry Owner';
const LABEL = 'Builder Names Retry Visitor';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

// The owner (a second browser context) claims a lándlet; the visitor (the page under test) stands on it.
const ownerPage = await browser.newPage({ viewport: { width: 420, height: 860 } });
ownerPage.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept(OWNER);
  else await dialog.accept();
});
await ownerPage.goto(process.env.E2E_BASE_URL || 'http://127.0.0.1:8787', { waitUntil: 'networkidle' });
await ownerPage.waitForTimeout(1500);
await chooseIdentity(ownerPage, { mode: 'build', label: OWNER, isNew: true });
await claimLandlet(ownerPage);
const landlet = await ownerPage.evaluate(async (ownerLabel) => {
  const all = await (await fetch('/api/builders')).json();
  const mine = all.builders.find((b) => b.label === ownerLabel);
  const list = await (await fetch(`/api/landlets?status=claimed&ownerBuilderId=${mine.builderId}&limit=100`)).json();
  return list.landlets[0];
}, OWNER);
await ownerPage.close();

await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });

// Abort the first names request only; later ones pass.
let aborted = 0;
let passed = 0;
await page.route('**/api/builders?ids=*', async (route) => {
  if (aborted === 0) {
    aborted += 1;
    await route.abort('failed');
  } else {
    passed += 1;
    await route.continue();
  }
});

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('body.shop-ready', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 15000 });

const stick = await shopStickBox(page);
const cx = stick.x + stick.width / 2;
const cy = stick.y + stick.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 25, cy, { steps: 5 });
await page.waitForTimeout(100);
await page.mouse.up();

async function standOnLandletAndRead() {
  await page.evaluate(([x, y]) => {
    window.__testTeleportShopAvatar(x, y);
    window.__testForceShopProximityCheck();
  }, [landlet.center.x, landlet.center.y]);
  await page.waitForTimeout(600);
  return page.textContent('#account-menu-landlet-info');
}

// The first read failed; the retry comes after about two seconds (it may already have landed by now, so what is
// read here is only logged). Wait for the name and for the next proximity tick.
const before = await standOnLandletAndRead();
console.log('label right after entering (the retry may or may not have landed yet):', before);
await page.waitForFunction((owner) => document.querySelector('#account-menu-landlet-info')?.textContent?.includes(owner), OWNER, { timeout: 15000 })
  .catch(() => {});
const after = await standOnLandletAndRead();
console.log('label after the retry:', after, '| aborted:', aborted, 'passed through:', passed);

const pass = aborted === 1
  && !!after?.includes(OWNER)
  && passed >= 1
  // the aborted request is logged by the browser as a failed resource; nothing else may be
  && errors.every((e) => /ERR_FAILED/.test(String(e)));
await finish(browser, { pass, label: '#4298: a failed first read of builder names is asked again and the owner\'s name appears', errors });
