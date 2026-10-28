// #2864 (symptom 2): the owner reported that during a live two-device test,
// both avatars briefly stopped rendering each other entirely, then
// recovered on their own a few minutes later with no reload. That issue's
// own leading, unconfirmed hypothesis: the owner's attention (and so browser
// focus) moved between the two device screens during testing, backgrounding
// whichever tab wasn't currently being looked at.
//
// Why this test doesn't actually background a real browser tab via CDP
// (the issue's own suggested approach): confirmed empirically, in this
// exact headless-Chromium e2e environment, neither page.bringToFront() (two
// pages, one page brought to front, the other's own rAF ticks kept firing
// at a full, unthrottled ~60fps the whole time) nor the CDP
// Page.setWebLifecycleState('frozen') call (same result -- rAF kept ticking
// at full speed) actually reproduces real-browser background-tab
// throttling here. Headless Chromium's automation-driven page lifecycle
// just doesn't implement the same OS-window-visibility-driven rAF
// throttling a real, visible, unfocused tab gets in a real browser -- so a
// test built on top of either technique would assert nothing real; both
// pages would always stay mutually visible regardless of which was
// "backgrounded," making the test either trivially pass without exercising
// anything, or hang waiting for throttling that will never happen.
//
// What this test does instead: directly simulates the one thing real
// background-tab throttling actually DOES to this app -- stopping
// enterShopMode's own per-frame requestAnimationFrame loop (src/world/
// scene.js's animate(), which is what drives reportOwnPresenceIfNeeded/
// pollNearbyPresenceIfNeeded/updateOtherShopAvatars every tick, confirmed
// by reading updateShopMovement's own call site in src/shop/
// flightMovement.js) -- by intercepting window.requestAnimationFrame
// itself from outside the page, deferring every call for as long as the
// simulated backgrounding lasts, then immediately re-firing the pending
// call for real once it ends. This is a faithful stand-in for the real
// mechanism (the loop genuinely stops making report/poll calls, exactly as
// it would under severe real throttling) without depending on a browser
// behavior this environment doesn't actually exhibit.
//
// Root cause this confirms, read directly from the code (worker/lib/
// social.js's handlePresence): GET /api/presence derives which landlet to
// query from the CALLER's OWN most recent avatar_presence row
// (callersCurrentLandletId, PRESENCE_STALE_AFTER_MS = 10s) -- not a
// client-supplied id (#2269's own anti-spoof design). Once builder A's own
// report loop stops long enough for A's own row to go stale, A's own
// landlet lookup returns null regardless of B, AND B's own query for
// "who's nearby" excludes A's now-stale row too -- so the moment A's
// report loop stalls, A effectively vanishes from everyone's view
// (including, if A's own loop resumes polling before B's row would also go
// stale, A's view of B), with no explicit despawn/error on either side,
// exactly matching the owner's "both accounts stopped rendering each other
// entirely... recovered on its own" report. Nothing server-side needs
// fixing here -- this is the deliberate, correct behavior #2269 built on
// purpose; this test exists to confirm the mechanism and the automatic,
// reload-free recovery, not to propose a server-side change.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL_A = 'Presence Suite Backgrounded A';
const LABEL_B = 'Presence Suite Watching B';
const LANDLET_ID = 'presence-suite-bg-landlet';
// worker/lib/social.js's PRESENCE_STALE_AFTER_MS -- how long before A's own
// avatar_presence row is excluded from anyone else's "who's nearby" query.
const PRESENCE_STALE_AFTER_MS = 10_000;

const sessionA = await launchPage({ promptAnswer: LABEL_A });
const sessionB = await launchPage({ promptAnswer: LABEL_B });
const pageA = sessionA.page;
const pageB = sessionB.page;

async function fetchJson(page, path, options) {
  return page.evaluate(async ([p, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(p, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [path, options]);
}

await chooseIdentity(pageA, { mode: 'build', label: LABEL_A, isNew: true });
const builderA = (await fetchJson(pageA, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(pageA, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Presence Suite Backgrounding Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builderA.builderId,
  }),
});
console.log('landlet created (status should be 201):', landletCreated.status);

// Same freeze-via-landing sequence as e2e/multiplayer-presence.test.mjs's
// own setup -- see that file's own comments for why each step is needed
// (random spawn-orbit, flying-avatars-are-invisible, the fixed landing
// duration margin).
await pageA.reload({ waitUntil: 'networkidle' });
await pageA.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageA.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageA.click('#shop-fly-btn');
await pageA.waitForTimeout(2500);
await pageA.waitForTimeout(2500); // past reportOwnPresenceIfNeeded's own first-report throttle

await chooseIdentity(pageB, { mode: 'build', label: LABEL_B, isNew: true });
const builderB = (await fetchJson(pageB, '/api/builders/me')).body.builder;
// #2269: B needs its own fresh presence row in this landlet before its own
// GET can see anyone else in it -- same seam e2e/multiplayer-presence.
// test.mjs's own setup uses.
await fetchJson(pageB, '/api/presence', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: 0, y: 0, z: 0, heading: 0, landletId: LANDLET_ID }),
});

await pageB.reload({ waitUntil: 'networkidle' });
await pageB.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await pageB.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });
await pageB.click('#shop-fly-btn');
await pageB.waitForTimeout(2500);

// Give both poll loops (SHOP_PRESENCE_POLL_INTERVAL_MS = 1000) a couple of
// cycles to pick each other up before touching anything.
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(500);

const othersInB_beforeBackgrounding = await pageB.evaluate(() => window.__shopOtherAvatars);
const aSeenByB_before = othersInB_beforeBackgrounding?.find((a) => a.builderId === builderA.builderId);
console.log('B sees A before backgrounding (should be present):', aSeenByB_before);

// Simulate A's tab going into the background hard enough that its own
// per-frame loop stops making any report/poll calls at all -- see this
// file's own header comment for why this, not a real CDP/visibility call,
// is the faithful reproduction in this environment. Each pending
// animate() tick gets deferred far into the future instead of firing on
// the next real frame; __resumeRealRAF cancels whatever's still pending
// and immediately re-fires it for real, exactly mirroring a real
// browser's own "tab regains focus, scheduling resumes" transition.
await pageA.evaluate(() => {
  const realRAF = window.requestAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  window.__bgSimActive = true;
  window.__bgSimPendingTimer = null;
  window.__bgSimPendingCb = null;
  window.requestAnimationFrame = (cb) => {
    if (!window.__bgSimActive) return realRAF(cb);
    window.__bgSimPendingCb = cb;
    window.__bgSimPendingTimer = realSetTimeout(() => {
      window.__bgSimPendingTimer = null;
      window.__bgSimPendingCb = null;
      cb(performance.now());
    }, 120_000); // far longer than this test's own observation window
    return window.__bgSimPendingTimer;
  };
  window.__bgSimResume = () => {
    window.__bgSimActive = false;
    if (window.__bgSimPendingTimer !== null) {
      realClearTimeout(window.__bgSimPendingTimer);
      const cb = window.__bgSimPendingCb;
      window.__bgSimPendingTimer = null;
      window.__bgSimPendingCb = null;
      if (cb) realRAF(cb); // immediately resume the self-perpetuating loop for real
    }
  };
});

// Past PRESENCE_STALE_AFTER_MS, plus margin for B's own poll cadence
// (SHOP_PRESENCE_POLL_INTERVAL_MS = 1000) to actually notice and exclude
// A's now-stale row -- generous margin for CI load, same shape every other
// e2e file's own fixed waits in this suite already use.
await pageB.waitForTimeout(PRESENCE_STALE_AFTER_MS + 3000);

const othersInB_duringBackgrounding = await pageB.evaluate(() => window.__shopOtherAvatars);
const aSeenByB_during = othersInB_duringBackgrounding?.find((a) => a.builderId === builderA.builderId);
console.log('B sees A while A is "backgrounded" (should be gone):', othersInB_duringBackgrounding, aSeenByB_during);

// Resume A's loop for real -- no page reload anywhere in this test, same
// as the owner's own "recovered on its own... no code change or reload"
// report.
await pageA.evaluate(() => window.__bgSimResume());

// reportOwnPresenceIfNeeded "always reports on its very first eligible
// tick regardless of movement" (see its own comment in src/shop/
// presenceAndContent.js) -- A's row is fresh again almost immediately once
// its loop resumes. Margin: A's first report + B's next poll + A's own
// next poll (to see B again) + a little lerp/render settle time.
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(1500);

const othersInB_afterRecovery = await pageB.evaluate(() => window.__shopOtherAvatars);
const aSeenByB_after = othersInB_afterRecovery?.find((a) => a.builderId === builderA.builderId);
const othersInA_afterRecovery = await pageA.evaluate(() => window.__shopOtherAvatars);
const bSeenByA_after = othersInA_afterRecovery?.find((a) => a.builderId === builderB.builderId);
console.log('B sees A after A\'s loop resumes, no reload (should be back):', aSeenByB_after);
console.log('A sees B after its own loop resumes, no reload (should be back):', bSeenByA_after);

const errors = [...sessionA.errors, ...sessionB.errors];
const pass =
  landletCreated.status === 201 &&
  !!aSeenByB_before && // mutual visibility established before the simulated backgrounding
  !aSeenByB_during && // confirms the #2864 symptom: A vanishes from B's view once A's own report loop stalls
  !!aSeenByB_after && !!bSeenByA_after && // confirms the owner's own observation: recovers on its own, no reload
  errors.length === 0;

await sessionB.browser.close();
await finish(sessionA.browser, {
  pass,
  label: '#2864: a stalled report/poll loop (simulating a backgrounded tab) makes a builder vanish from presence, then recover on its own once it resumes, with no reload',
  errors,
});
