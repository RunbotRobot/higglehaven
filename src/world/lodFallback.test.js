// #4111: which version an item shows when the one asked for does not exist. A missing mid is the full
// model (it used to be far, so a model the generator could not simplify was drawn as its roughest
// version across the mid range); a missing far is mid when there is one.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

// models.js builds its ground texture on a canvas when it loads; give the node environment one.
const noop = () => {};
globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }),
};
const { setInstanceLodState } = await import('./models.js');
import { TIER_FULL, TIER_MID, TIER_FAR } from '../shop/lodTier.js';

function item({ mid, far }) {
  const object = new THREE.Group();
  const full = new THREE.Group();
  object.add(full);
  const tiers = {};
  if (mid) { tiers.mid = new THREE.Group(); tiers.mid.visible = false; object.add(tiers.mid); }
  if (far) { tiers.far = new THREE.Group(); tiers.far.visible = false; object.add(tiers.far); }
  object.userData.lodTiers = tiers;
  return { object, full, ...tiers };
}

describe('setInstanceLodState fallback (#4111)', () => {
  it('a product with no mid stays on its full model in the mid range, even when it has a far', () => {
    const { object, full, far } = item({ mid: false, far: true });
    expect(setInstanceLodState(object, TIER_MID)).toBe(TIER_FULL);
    expect(full.visible).toBe(true);
    expect(far.visible).toBe(false);
  });

  it('still shows the far version when far is asked for', () => {
    const { object, far } = item({ mid: false, far: true });
    expect(setInstanceLodState(object, TIER_FAR)).toBe(TIER_FAR);
    expect(far.visible).toBe(true);
  });

  it('a product with a mid shows it in the mid range', () => {
    const { object, mid } = item({ mid: true, far: true });
    expect(setInstanceLodState(object, TIER_MID)).toBe(TIER_MID);
    expect(mid.visible).toBe(true);
  });

  it('a missing far falls to mid when there is one, otherwise to full', () => {
    expect(setInstanceLodState(item({ mid: true, far: false }).object, TIER_FAR)).toBe(TIER_MID);
    expect(setInstanceLodState(item({ mid: false, far: false }).object, TIER_FAR)).toBe(TIER_FULL);
  });
});
