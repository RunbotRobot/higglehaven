// #2480 (sub-issue of #2475), follow-up to the sit-only pass that already
// landed: lean's own shopLeanBlend now gets the identical randomized
// settle-delay pattern shop-idle-sit-randomization.test.mjs already
// verifies for sit (see that file's own header comment for the full
// rationale) -- shopLeanSettleDelayS randomizes once per lean episode and
// gates when shopLeanBlend actually starts easing in, so leaning against
// the same wall repeatedly doesn't always settle at the exact same
// instant. Target-selection randomization itself (findShopIdleInteractionTarget)
// is already proven kind-agnostic by the sit test, so this file only
// covers the settle-delay timing half, for lean.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Idle Lean Randomization Builder';
const LANDLET_ID = 'idle-lean-randomization-landlet';
const TEMPLATE_ID = `idle-lean-randomization-wall-${Date.now()}`;

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
// deflection" idiom the sibling idle tests already document -- reused
// below, between idle episodes, to force real movement input and re-arm
// the idle timer for the next episode.
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

// Same ownership/creation shortcuts the sibling idle tests' own comments
// explain in full.
await chooseIdentity(page, { mode: 'sell', label: LABEL, isNew: true });
const seller = (await fetchJson(page, '/api/sellers/me')).body.seller;

const templateCreated = await fetchJson(page, '/api/catalog', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    templateId: TEMPLATE_ID,
    name: 'Idle Lean Randomization Test Wall',
    color: '#665544',
    dimensions: { width: 1.0, depth: 1.0, height: 2.0 },
    sellerId: seller.sellerId,
    priceCents: 500,
    metadata: { leanTarget: { offsetXM: 0, offsetYM: 0.3, heightM: 1.0, facingRad: Math.PI } },
  }),
});
console.log('leanable wall template created (status should be 201):', templateCreated.status, templateCreated.body);

const builder = (await fetchJson(page, '/api/builders/me')).body.builder;

const landletCreated = await fetchJson(page, '/api/landlets', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    landletId: LANDLET_ID,
    name: 'Idle Lean Randomization Landlet',
    areaM2: 1000,
    status: 'claimed',
    ownerBuilderId: builder.builderId,
  }),
});
console.log('landlet created at the default (0,0) center (status should be 201):', landletCreated.status);

const WALL_X = 10;
const WALL_Y = 10;
const placed = await fetchJson(page, '/api/instances/batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    instances: [{
      templateId: TEMPLATE_ID,
      landletId: LANDLET_ID,
      x: WALL_X,
      y: WALL_Y,
      z: 1.0,
      rotationZ: 0,
    }],
  }),
});
console.log('wall instance placed (status should be 201):', placed.status, placed.body);

await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: false });
await page.waitForSelector('#shop-fly-btn.visible', { timeout: 15000 });
await page.waitForSelector('#shop-status:not(.visible)', { state: 'attached', timeout: 10000 });

await deflectMoveJoystick(page);
const AVATAR_X = WALL_X;
const AVATAR_Y = WALL_Y - 2;
await page.evaluate(([x, y]) => {
  window.__testTeleportShopAvatar(x, y, 0);
  window.__testForceShopProximityCheck();
}, [AVATAR_X, AVATAR_Y]);
await page.waitForTimeout(500); // lets the just-forced landlet instance load actually finish

// Drives several real idle episodes in a row (deflect to end one episode
// and re-arm the idle timer, wait out the idle delay plus a margin, read
// the settle delay this fresh episode randomized, repeat) and confirms
// more than one distinct delay value shows up -- plus, within one
// episode, that blend stays exactly 0 until settleElapsedS first reaches
// settleDelayS. Same approach shop-idle-sit-randomization.test.mjs's own
// part 2 already uses for sit.
const EPISODE_SAMPLES = 6;
const settleDelays = new Set();
let sawBlendHeldAtZeroDuringSettle = false;
for (let i = 0; i < EPISODE_SAMPLES; i++) {
  await deflectMoveJoystick(page); // ends the previous episode, re-arms the idle timer
  // Re-teleported back to the exact same spot each iteration -- the real
  // movement input deflectMoveJoystick drives above displaces the avatar
  // by a small real amount each time (not just a keypress with zero
  // displacement), and this spot's own margin to the 3m search radius
  // (0.7m) is tight enough that a few iterations of accumulated drift
  // would otherwise walk the avatar out of range, as discovered by this
  // test actually doing that reliably (3/3 standalone runs failed with a
  // waitForFunction timeout here before this fix).
  await page.evaluate(([x, y]) => window.__testTeleportShopAvatar(x, y, 0), [AVATAR_X, AVATAR_Y]);
  // #2598: waitForFunction's signature is (pageFunction, arg, options) --
  // this 2-arg call put { timeout: 15000 } in the arg slot instead, so the
  // real applied timeout was always Playwright's own default (30000ms),
  // not 15000ms -- and even the intended 15000ms wasn't enough margin
  // under current CI load. The explicit `null` arg reaches the options
  // slot, and the timeout is widened for real headroom.
  await page.waitForFunction(() => window.__testShopIdleInteractionTarget()?.kind === 'lean', null, { timeout: 60000 });
  const rightAfterSelection = await page.evaluate(() => window.__testShopLeanPose());
  settleDelays.add(Math.round(rightAfterSelection.settleDelayS * 1000)); // ms, so float noise doesn't fracture the set
  if (rightAfterSelection.settleElapsedS < rightAfterSelection.settleDelayS && rightAfterSelection.blend === 0) {
    sawBlendHeldAtZeroDuringSettle = true;
  }
}
console.log(`lean settle delay took ${settleDelays.size} distinct value(s) across ${EPISODE_SAMPLES} episodes (should be > 1):`, [...settleDelays]);
console.log('lean blend observed held at exactly 0 during at least one settle window (should be true):', sawBlendHeldAtZeroDuringSettle);

const pass =
  landletCreated.status === 201 &&
  placed.status === 201 &&
  settleDelays.size > 1 &&
  sawBlendHeldAtZeroDuringSettle &&
  errors.length === 0;

await finish(session.browser, {
  pass,
  label: '#2480: lean settle timing is randomized across repeated idle episodes',
  errors,
});
