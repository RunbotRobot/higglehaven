import { describe, expect, it } from 'vitest';
import { tapRingLevels, TAP_RING_MIN_S, TAP_RING_MAX_S, TAP_RING_FADE_S } from './assistantTapRing.js';

describe('the ring under a tapped assistant (#3773)', () => {
  it('opens from nothing and is visible at once', () => {
    expect(tapRingLevels(0).opacity).toBe(0);
    expect(tapRingLevels(0.3).opacity).toBeGreaterThan(0.4);
  });

  it('stays while the window has not come up, until the safety limit', () => {
    expect(tapRingLevels(5).opacity).toBeGreaterThan(0.4);
    expect(tapRingLevels(5).done).toBe(false);
    expect(tapRingLevels(TAP_RING_MAX_S + TAP_RING_FADE_S).done).toBe(true);
  });

  it('an immediate release still shows the ring for its minimum, then fades out', () => {
    expect(tapRingLevels(TAP_RING_MIN_S - 0.05, 0.05).opacity).toBeGreaterThan(0.4);
    expect(tapRingLevels(TAP_RING_MIN_S + TAP_RING_FADE_S / 2, 0.05).opacity).toBeLessThan(0.4);
    expect(tapRingLevels(TAP_RING_MIN_S + TAP_RING_FADE_S, 0.05).done).toBe(true);
  });

  it('with reduced motion it does not grow or breathe', () => {
    const a = tapRingLevels(0.1, null, { reducedMotion: true });
    const b = tapRingLevels(2, null, { reducedMotion: true });
    expect(a.scale).toBe(1);
    expect(b.scale).toBe(1);
  });
});
