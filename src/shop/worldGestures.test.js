import { describe, expect, it } from 'vitest';
import { createWorldGestures, deflection, TAP_SLOP_PX, DEADZONE_PX, FULL_DEFLECTION_PX, DOUBLE_TAP_MS, TAP_MAX_MS } from './worldGestures.js';

function rig() {
  const events = [];
  const gestures = createWorldGestures({
    onMove: (x, y) => events.push(['move', x, y]),
    onLook: (x, y) => events.push(['look', x, y]),
    onDoubleTap: () => events.push(['double']),
  });
  return { events, gestures };
}

describe('deflection', () => {
  it('is zero inside the dead zone and one at full travel, clamped beyond', () => {
    expect(deflection(DEADZONE_PX - 1, 0)).toEqual({ x: 0, y: 0 });
    expect(deflection(FULL_DEFLECTION_PX, 0)).toEqual({ x: 1, y: 0 });
    expect(deflection(0, -FULL_DEFLECTION_PX * 3)).toEqual({ x: 0, y: -1 });
  });
  it('keeps the direction on a diagonal', () => {
    const { x, y } = deflection(FULL_DEFLECTION_PX / 2, FULL_DEFLECTION_PX / 2);
    expect(x).toBeCloseTo(y);
    expect(Math.hypot(x, y)).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe('walking', () => {
  it('a finger that stays within the tap slop is not a drag', () => {
    const { events, gestures } = rig();
    gestures.down(1, 100, 100, 0);
    gestures.move(1, 100 + TAP_SLOP_PX, 100);
    expect(events).toEqual([]);
  });

  it('a drag walks, from where the finger landed, and stops on lift', () => {
    const { events, gestures } = rig();
    gestures.down(1, 200, 300, 0);
    gestures.move(1, 200, 300 - FULL_DEFLECTION_PX);
    expect(events.at(-1)).toEqual(['move', 0, -1]);
    gestures.move(1, 200, 300 - FULL_DEFLECTION_PX / 2);
    expect(events.at(-1)[2]).toBeCloseTo(-0.5);
    gestures.up(1, 600);
    expect(events.at(-1)).toEqual(['move', 0, 0]);
    expect(events.some((e) => e[0] === 'double')).toBe(false);
  });

  it('a short drag is never read as a tap, so it cannot start a double-tap', () => {
    const { events, gestures } = rig();
    gestures.down(1, 10, 10, 0);
    gestures.move(1, 10 + TAP_SLOP_PX + 5, 10);
    gestures.up(1, 100);
    gestures.down(2, 10, 10, 150);
    gestures.up(2, 200);
    expect(events.some((e) => e[0] === 'double')).toBe(false);
  });
});

describe('looking', () => {
  it('a second finger looks while the first stays a walker', () => {
    const { events, gestures } = rig();
    gestures.down(1, 100, 400, 0);
    gestures.down(2, 300, 400, 20);
    gestures.move(2, 300 + FULL_DEFLECTION_PX, 400);
    expect(events.at(-1)).toEqual(['look', 1, 0]);
    // the walker has not moved, so it asks for nothing
    expect(events.some((e) => e[0] === 'move' && (e[1] !== 0 || e[2] !== 0))).toBe(false);
    gestures.move(1, 100, 400 - FULL_DEFLECTION_PX);
    expect(events.at(-1)).toEqual(['move', 0, -1]);
    gestures.up(2, 500);
    expect(events.at(-1)).toEqual(['look', 0, 0]);
    gestures.up(1, 520);
    expect(events.at(-1)).toEqual(['move', 0, 0]);
  });

  it('a third finger does nothing', () => {
    const { events, gestures } = rig();
    gestures.down(1, 0, 0, 0);
    gestures.down(2, 100, 0, 5);
    gestures.down(3, 200, 0, 10);
    gestures.move(3, 200 + 60, 0);
    expect(events).toEqual([]);
  });

  it('two fingers are never a tap, whatever they do', () => {
    const { events, gestures } = rig();
    gestures.down(1, 0, 0, 0);
    gestures.down(2, 100, 0, 5);
    gestures.up(2, 50);
    gestures.up(1, 60);
    gestures.down(3, 0, 0, 100);
    gestures.up(3, 150);
    expect(events.some((e) => e[0] === 'double')).toBe(false);
  });
});

describe('double-tap', () => {
  it('two quick taps in the same place take off or land', () => {
    const { events, gestures } = rig();
    gestures.down(1, 50, 50, 0);
    gestures.up(1, 80);
    gestures.down(2, 55, 52, 200);
    gestures.up(2, 240);
    expect(events).toEqual([['double']]);
  });

  it('is not a double-tap when the second tap is late, far away, or the first was a hold', () => {
    const late = rig();
    late.gestures.down(1, 50, 50, 0);
    late.gestures.up(1, 80);
    late.gestures.down(2, 50, 50, 80 + DOUBLE_TAP_MS + 50);
    late.gestures.up(2, 80 + DOUBLE_TAP_MS + 90);
    expect(late.events).toEqual([]);

    const far = rig();
    far.gestures.down(1, 50, 50, 0);
    far.gestures.up(1, 80);
    far.gestures.down(2, 250, 50, 150);
    far.gestures.up(2, 190);
    expect(far.events).toEqual([]);

    const hold = rig();
    hold.gestures.down(1, 50, 50, 0);
    hold.gestures.up(1, TAP_MAX_MS + 200);
    hold.gestures.down(2, 50, 50, TAP_MAX_MS + 260);
    hold.gestures.up(2, TAP_MAX_MS + 300);
    expect(hold.events).toEqual([]);
  });

  it('three quick taps are one double-tap and then a fresh first tap', () => {
    const { events, gestures } = rig();
    gestures.down(1, 0, 0, 0); gestures.up(1, 30);
    gestures.down(2, 0, 0, 100); gestures.up(2, 130);
    gestures.down(3, 0, 0, 200); gestures.up(3, 230);
    expect(events).toEqual([['double']]);
  });
});

describe('cancel', () => {
  it('lets go of everything held', () => {
    const { events, gestures } = rig();
    gestures.down(1, 0, 0, 0);
    gestures.down(2, 100, 0, 5);
    gestures.move(1, 0, -50);
    gestures.move(2, 150, 0);
    events.length = 0;
    gestures.cancel();
    expect(events).toEqual([['move', 0, 0], ['look', 0, 0]]);
    expect(gestures.activeFingers()).toBe(0);
  });
});
