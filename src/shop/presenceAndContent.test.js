import { describe, expect, it } from 'vitest';

// #2864: pure-JS mirror of updateOtherShopAvatars/pollNearbyPresenceIfNeeded's
// own snapshot-timing bookkeeping (src/shop/presenceAndContent.js) — not
// imported directly, since that module pulls in three.js/scene/world
// modules purely for other exports it also defines, the same reasoning
// src/shop/sky.test.js's own header comment gives for mirroring its shader
// formula instead of importing it. Keep this IN SYNC BY HAND with the real
// entry-update/lerp logic if either ever changes.
//
// The bug this guards against: updateOtherShopAvatars used to divide by a
// fixed assumed interval (SHOP_PRESENCE_POLL_INTERVAL_MS, 1000ms) regardless
// of how long the real gap between two landed snapshots actually was. Under
// an uneven poll cadence (network jitter, a throttled/backgrounded tab, a
// skipped tick), the real gap can run much longer than 1000ms — the old
// code clamped t at 1 after only 1000ms and sat frozen at the (by-then-
// stale) target for the rest of the real gap, then visibly snapped once the
// next snapshot finally landed. The fix tracks the real elapsed gap between
// consecutive snapshots (lerpDurationMs) and lerps against that instead.

const POLL_INTERVAL_MS = 1000;

function applySnapshot(entry, avatar, now) {
  if (!entry) {
    return { fromX: avatar.x, toX: avatar.x, receivedAt: now, lerpDurationMs: POLL_INTERVAL_MS };
  }
  return {
    fromX: entry.toX,
    toX: avatar.x,
    receivedAt: now,
    lerpDurationMs: Math.max(1, now - entry.receivedAt),
  };
}

function renderedX(entry, now) {
  const t = Math.min(1, (now - entry.receivedAt) / entry.lerpDurationMs);
  return entry.fromX + (entry.toX - entry.fromX) * t;
}

describe('other-shop-avatar snapshot lerp timing (#2864)', () => {
  it('lerps across the real elapsed gap between snapshots, not a fixed 1000ms assumption', () => {
    let entry = applySnapshot(null, { x: 0 }, 0);
    // A normal, on-schedule snapshot 1000ms later — unaffected either way.
    entry = applySnapshot(entry, { x: 10 }, 1000);
    expect(renderedX(entry, 1000)).toBeCloseTo(0, 5); // t=0 right as it lands
    expect(renderedX(entry, 1500)).toBeCloseTo(5, 5); // halfway through the normal 1000ms window

    // An uneven cadence: the NEXT snapshot doesn't land until 2600ms later
    // (well past the old fixed 1000ms assumption), moving from 10 to 30.
    const JITTER_GAP_MS = 2600;
    const landedAt = 1000 + JITTER_GAP_MS;
    entry = applySnapshot(entry, { x: 30 }, landedAt);

    // 1300ms after this snapshot lands — past the OLD fixed 1000ms
    // duration (which would have already clamped to the full target, x=30,
    // and sat frozen there), but only halfway through the REAL 2600ms gap.
    const renderedPartway = renderedX(entry, landedAt + 1300);
    expect(renderedPartway).toBeGreaterThan(10);
    expect(renderedPartway).toBeLessThan(30);
    expect(renderedPartway).toBeCloseTo(10 + 20 * (1300 / JITTER_GAP_MS), 5);

    // By the time the real gap fully elapses, it reaches the target.
    expect(renderedX(entry, landedAt + JITTER_GAP_MS)).toBeCloseTo(30, 5);
    // And stays there (clamped), rather than overshooting, if the next
    // snapshot is itself delayed too.
    expect(renderedX(entry, landedAt + JITTER_GAP_MS + 500)).toBeCloseTo(30, 5);
  });

  it('a brand-new avatar (no prior snapshot) renders at its first position immediately, not mid-lerp from anywhere', () => {
    const entry = applySnapshot(null, { x: 42 }, 0);
    expect(renderedX(entry, 0)).toBeCloseTo(42, 5);
    expect(renderedX(entry, 500)).toBeCloseTo(42, 5);
  });
});
