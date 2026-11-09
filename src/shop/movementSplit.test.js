// #3292 (leaf 1/6 of #3291, part of #3253): flightMovement.js depends on
// three.js and the live Shop world, so it has no unit-test pool (see
// vitest.config.js); Shop's real behaviour is covered by the shop e2e
// files. This pins the one structural promise of the split in the source
// itself: the movement core never calls a Shop-world service (that is what
// lets Sell mode run it without Shop's world), and Shop's per-frame entry
// point runs the core and then the services.
import { describe, expect, it } from 'vitest';
import source from './flightMovement.js?raw';

function functionBody(name) {
  const start = source.search(new RegExp(`export function ${name}\\(`));
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const WORLD_SERVICES = [
  'updateShopProximity', 'updateShopLandletInfo', 'reportOwnPresenceIfNeeded', 'pollNearbyPresenceIfNeeded',
  'refreshShopLandletRecordsIfNeeded', 'pollNearbyChatIfNeeded', 'updateOtherShopAvatars', 'updateShopVoiceChatIfNeeded',
  'updateSignFade', 'updateCalendarFade', 'updateReviewFade', 'updateCreditOrbs', 'updateCreditOrbPopEffects',
  'checkScheduledCalendarEvents', 'updateConfettiBursts', 'updateShopAttention',
];

describe('Shop per-frame split (#3292)', () => {
  it('the movement core calls none of the Shop-world services', () => {
    const core = functionBody('updateShopMovementCore');
    for (const name of WORLD_SERVICES) expect(core, name).not.toMatch(new RegExp(`\\b${name}\\(`));
  });

  it('the world services function calls every one of them', () => {
    const services = functionBody('updateShopWorldServices');
    for (const name of WORLD_SERVICES) expect(services, name).toMatch(new RegExp(`\\b${name}\\(`));
  });

  it('updateShopMovement runs the core and then the services with the core\'s dt', () => {
    const body = functionBody('updateShopMovement');
    const core = body.indexOf('updateShopMovementCore(now)');
    const services = body.indexOf('updateShopWorldServices(now, frame.dt)');
    expect(core).toBeGreaterThanOrEqual(0);
    expect(services).toBeGreaterThan(core);
  });

  it('the core still ends by positioning the camera, so Sell gets a camera too', () => {
    const core = functionBody('updateShopMovementCore');
    expect(core).toMatch(/positionShopCamera\(\);\s*return \{ dt, moveMagnitude, airborne \};/);
  });
});
