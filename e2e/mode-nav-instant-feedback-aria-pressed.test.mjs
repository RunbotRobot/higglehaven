// Regression test for #2004: #mode-nav's click handler has two separate code
// paths that touch aria-pressed. updateModeNavUI() (the #1503 fix, called
// once bootstrap() finishes after the reload) sets both classList and
// aria-pressed correctly. But the click handler's own instant-feedback line
// (#1152, added so the pressed state paints before location.reload() actually
// navigates away) only ever did `classList.toggle('active', ...)` -- so a
// screen reader announced the *old* aria-pressed value on every mode-nav
// button for the whole window between the click and the reload completing.
//
// Proven by triggering the click and reading the resulting DOM state in one
// single page.evaluate() round trip: button.click() runs the handler (and
// its location.reload() call) synchronously, so the state read right after
// it returns, in that same JS turn, is exactly the handler's own
// instant-feedback write -- before the browser has had any chance to act on
// the navigation that same call kicked off. A separate page.click() followed
// by a separate read doesn't work here: both Playwright's own click() and
// any Locator-based read wait for an in-flight navigation to settle first,
// and location.reload() is a real navigation Playwright can see -- exactly
// the window this test needs to look inside of, not past.
//
// Entered via Sell rather than Build: the Seller modal's own backdrop sits
// below #mode-nav's z-index (#1596 raised #mode-nav above it specifically so
// Shop/Build stay clickable while Sell is open). Build's own claim-modal
// backdrop sits above #mode-nav instead and would block this click.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Mode Nav Instant Feedback Tester';

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL });

await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
await page.waitForSelector('#seller-modal.visible', { timeout: 30000 });
await page.waitForTimeout(300);

const result = await page.evaluate(() => {
  const shopBtn = document.querySelector('.mode-nav-btn[data-mode="shop"]');
  const sellBtn = document.querySelector('.mode-nav-btn[data-mode="sell"]');
  shopBtn.click();
  return {
    shopActive: shopBtn.classList.contains('active'),
    shopAriaPressed: shopBtn.getAttribute('aria-pressed'),
    sellActive: sellBtn.classList.contains('active'),
    sellAriaPressed: sellBtn.getAttribute('aria-pressed'),
  };
});

console.log('Shop nav button .active right after the click, same tick as the reload call (should be true):', result.shopActive);
console.log('Shop nav button aria-pressed right after the click, same tick as the reload call (should be "true"):', result.shopAriaPressed);
console.log('Sell nav button .active right after the click, same tick as the reload call (should be false):', result.sellActive);
console.log('Sell nav button aria-pressed right after the click, same tick as the reload call (should be "false"):', result.sellAriaPressed);

await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});

const pass = result.shopActive === true && result.shopAriaPressed === 'true' &&
  result.sellActive === false && result.sellAriaPressed === 'false' && errors.length === 0;
await finish(browser, { pass, label: "#2004: mode-nav's instant-feedback click handler updates aria-pressed, not just classList", errors });
