// #2480 (sub-issue of #2475): once a sit/lean target exists to pick from
// (#2477) and at least one pose consumes it (sit, #2478), the idle state
// machine should pick *and time* that pose with some randomization, per
// docs/SPEC.md §2's "with randomization" line -- matching how the
// existing stand sway already randomizes its own sway period/head-turn
// interval, applied here to (a) *which* in-range target gets selected
// when more than one qualifies, and (b) *when* the sit pose actually
// starts easing in within a given idle episode. Checks both
// independently: a statistical check that repeated searches don't always
// return the same chair out of several, and a statistical check that the
// randomized settle delay actually varies across repeated idle episodes
// (not just "some fixed delay every time").
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Idle Sit Randomization Builder';
const LANDLET_ID = 'idle-sit-randomization-landlet';

const session = await launchPage({ promptAnswer: LABEL });
const { errors, page } = session;

async function fetchJson(p, path, options) {
  return p.evaluate(async ([pathArg, opts]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(pathArg, opts);
        return { status: res.status, body: await res.json() };
      } catch (err) {
        if (attempt > 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [path, options]);
}

// Same "break the hands-off spawn orbit with a brief real joystick
// deflection" idiom e2e/shop-idle-sit-lean-targeting.test.mjs's own header
// comment documents -- otherwise shopSpawnRotating overwrites
// shopAvatarPosition.x/y every frame regardless of what this test
// teleports it to. Reused below, between idle episodes, to force real
// movement input and re-arm the idle timer for the next episode.
async function deflectMoveJoystick(p) {
  const moveJoystickBox = await p.locator('#shop-move-joystick').boundingBox();
  const moveCenterX = moveJoystickBox.x + moveJoystickBox.width / 2;
  const moveCenterY = moveJoystickBox.y + moveJoystickBox.height / 2;
  await p.mouse.move(moveCenterX, moveCenterY);
  await p.mouse.down();
  await p.mouse.move(moveCenterX + 25, moveCenterY, { steps: 5 });
  await p.waitForTimeout(100);
  await p.mouse.up();
  await p.waitForTimeout(100);
}

// Same ownership/creation shortcuts e2e/shop-idle-sit-lean-targeting.test.mjs's
// own comments explain in full: a seller-owned template (the shared
// fixture placeholder-chair can't be PATCHed by this account), builder
// fetched directly (bypassing Build mode's own claim-modal), landlet at
// the default (0,0) center.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
const seller = (await fetchJson(page, '/api/sellers/me')).body.seller;

const CHAIR_COUNT = 4;
const chairTemplateIds = [];
for (let i = 0; i < CHAIR_COUNT; i++) {
  const templateId = `idle-sit-randomization-chair-${i}-${Date.now()}`;
  chairTemplateIds.push(templateId);
  const created = await fetchJson(page, '/api/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId,
      name: `Idle Sit Randomization Test Chair ${i}`,
      color: '#447788',
      dimensions: { width: 0.7, depth: 0.7, height: 1.0 },
      sellerId: seller.sellerId,
      priceCents: 500,
      metadata: { sitTarget: { offsetXM: 0, offsetYM: -0.2, heightM: 0.45, facingRad: 0 } },
    }),
  });
  if (created.status !== 201) console.log(`chair ${i} template creation unexpectedly failed:`, created.status, created.body);
}

const builder = (await fetchJson(page, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(page, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Idle Sit Randomization Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builder.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

// Four chairs spaced around the search origin (0,0 world-local offset
// from the avatar's own teleport-to spot below), each well within
// SHOP_IDLE_INTERACTION_SEARCH_RADIUS_M (3m) of it but far enough apart
// from each other that they're each unambiguously a distinct candidate,
// not overlapping footprints.
const AVATAR_X = 10;
const AVATAR_Y = 10;
const CHAIR_OFFSETS = [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]];
const placedInstances = [];
for (let i = 0; i < CHAIR_COUNT; i++) {
  const [dx, dy] = CHAIR_OFFSETS[i];
  const placed = await fetchJson(page, '/api/instances/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instances: [{
        templateId: chairTemplateIds[i],
        landletId: LANDLET_ID,
        x: AVATAR_X + dx,
        y: AVATAR_Y + dy,
        z: 0.5,
        rotationZ: 0,
      }],
    }),
  });
  if (placed.status !== 201) console.log(`chair ${i} instance placement unexpectedly failed:`, placed.status, placed.body);
  placedInstances.push(placed);
}

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await deflectMoveJoystick(page);
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [AVATAR_X, AVATAR_Y]);
await page.waitForTimeout(500); // lets the just-forced landlet instance loads actually finish

// Part 1: random target selection. Drives the real search function
// directly (no idle-timer wait needed for this half, same shortcut
// e2e/shop-idle-sit-lean-targeting.test.mjs's own "direct search" check
// uses) many times and confirms more than one distinct chair gets picked
// -- not just "always non-null," which the old deterministic nearest-
// wins code already satisfied trivially.
const SEARCH_SAMPLES = 60;
const pickedInstanceIds = new Set();
for (let i = 0; i < SEARCH_SAMPLES; i++) {
  const target = await page.evaluate(([x, y]) => window.__testFindShopIdleInteractionTarget(x, y), [AVATAR_X, AVATAR_Y]);
  if (target) pickedInstanceIds.add(target.instanceId);
}
console.log(`random selection picked ${pickedInstanceIds.size} distinct chair(s) out of ${CHAIR_COUNT} across ${SEARCH_SAMPLES} samples (should be > 1):`, [...pickedInstanceIds]);

// Part 2: randomized settle-delay timing. Drives several real idle
// episodes in a row (deflect to end one episode and re-arm the idle
// timer, wait out SHOP_IDLE_DELAY_S + a margin, read the settle delay
// this fresh episode randomized, repeat) and confirms more than one
// distinct delay value shows up -- plus, within one episode, that blend
// stays exactly 0 until settleElapsedS first reaches settleDelayS.
const EPISODE_SAMPLES = 6;
const settleDelays = new Set();
let sawBlendHeldAtZeroDuringSettle = false;
// #2728: this loop's own waitForFunction below is a known, repeatedly-
// escalated flake under heavy CI load (#2598/#2655/#2704/#2724 -- see its
// own comment) -- its real failure mode isn't a clean, bounded "this test
// failed," it's an *uncaught* TimeoutError thrown before finish() (below)
// ever runs. finish() is the only place that calls browser.close() +
// process.exit(); skip it and the Playwright browser connection stays
// open, which keeps Node's event loop alive and hangs run-all.mjs's own
// untimed execSync call for the *entire shard* indefinitely, not just for
// 300000ms -- the same mechanism #2719's own CI investigation found and
// fixed in e2e/shop-submit-feedback.test.mjs. Catching it here and falling
// through to finish({ pass: false, ... }) turns that indefinite shard hang
// back into an ordinary, bounded test failure.
try {
  for (let i = 0; i < EPISODE_SAMPLES; i++) {
    await deflectMoveJoystick(page); // ends the previous episode, re-arms the idle timer
    // Polls for the fresh episode's own target selection rather than a fixed
    // wait, same #2423-established reasoning as the sibling targeting test.
    // #2598: waitForFunction's signature is (pageFunction, arg, options) --
    // this 2-arg call put { timeout: 15000 } in the arg slot instead, so the
    // real applied timeout was always Playwright's own default (30000ms),
    // not 15000ms -- and even the intended 15000ms wasn't enough margin
    // under current CI load. The explicit `null` arg reaches the options
    // slot, and the timeout is widened for real headroom.
    // #2655: #2598's 60000ms margin timed out again under tonight's heavier
    // CI load, same well-established timing-margin flake class -- widened
    // further to 120000ms, matching #2589/#2632's own settled value for the
    // same recurring flake shape.
    // #2704: 120000ms timed out twice in a row under an even heavier CI
    // load night -- widened further to 180000ms.
    // #2724: 180000ms timed out again within hours -- the 4th escalation of
    // the identical flake in under 36 hours. Repeated similar-sized bumps
    // aren't converging, so this jumps straight to 300000ms (5 minutes),
    // matching e2e/helpers.mjs's chooseIdentity wait (#2400), this suite's
    // own established "generous ceiling" margin for the same reason.
    await page.waitForFunction(() => window.__testShopIdleInteractionTarget()?.kind === 'sit', null, { timeout: 300000 });
    const rightAfterSelection = await page.evaluate(() => window.__testShopSitPose());
    settleDelays.add(Math.round(rightAfterSelection.settleDelayS * 1000)); // ms, so float noise doesn't fracture the set
    if (rightAfterSelection.settleElapsedS < rightAfterSelection.settleDelayS && rightAfterSelection.blend === 0) {
      sawBlendHeldAtZeroDuringSettle = true;
    }
  }
} catch (err) {
  console.log('episode loop threw before completing all samples (see #2728):', err.message);
  await finish(session.browser, {
    pass: false,
    label: '#2480: sit target selection and settle timing are both randomized across repeated idle episodes',
    errors: [...errors, `episode loop error: ${err.message}`],
  });
}
console.log(`settle delay took ${settleDelays.size} distinct value(s) across ${EPISODE_SAMPLES} episodes (should be > 1):`, [...settleDelays]);
console.log('blend observed held at exactly 0 during at least one settle window (should be true):', sawBlendHeldAtZeroDuringSettle);

const allChairsPlaced = placedInstances.every((p) => p.status === 201);

const pass =
  landletCreated.status === 201 &&
  allChairsPlaced &&
  pickedInstanceIds.size > 1 &&
  settleDelays.size > 1 &&
  sawBlendHeldAtZeroDuringSettle &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2480: sit target selection and settle timing are both randomized across repeated idle episodes',
  errors,
});
