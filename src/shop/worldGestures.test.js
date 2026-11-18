import { describe, expect, it } from 'vitest';
import { createWorldGestures, deflection, TAP_SLOP_PX, DEADZONE_PX, FULL_DEFLECTION_PX, DOUBLE_TAP_MS, TAP_MAX_MS } from './worldGestures.js';

function rig() {
  const events = [];
  const gestures = createWorldGestures({
    onMove: (x, y) => events.push(['move', x, y]),
    onLook: (x, y) => events.push(['look', x, y]),
    onDoubleTap: () => events.push(['double']),
    splitX: () => 200, // a 400 px wide screen: x < 200 is the left half
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

const LEFT = 100;
const RIGHT = 300;

describe('walking (the left half)', () => {
  it('a finger that stays within the tap slop is not a drag', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 100, 0);
    gestures.move(1, LEFT + TAP_SLOP_PX, 100);
    expect(events).toEqual([]);
  });

  it('a drag walks, from where the finger landed, and stops on lift', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 300, 0);
    gestures.move(1, LEFT, 300 - FULL_DEFLECTION_PX);
    expect(events.at(-1)).toEqual(['move', 0, -1]);
    gestures.move(1, LEFT, 300 - FULL_DEFLECTION_PX / 2);
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

describe('looking (the right half)', () => {
  it('one finger alone looks, with nothing else down: a person can stand still and look around', () => {
    const { events, gestures } = rig();
    gestures.down(1, RIGHT, 400, 0);
    gestures.move(1, RIGHT + FULL_DEFLECTION_PX / 2, 400);
    expect(events.at(-1)[0]).toBe('look');
    expect(events.at(-1)[1]).toBeCloseTo(0.5);
    expect(events.some((e) => e[0] === 'move')).toBe(false);
    gestures.up(1, 500);
    expect(events.at(-1)).toEqual(['look', 0, 0]);
  });

  it('both halves work at once, whichever finger went down first', () => {
    const first = rig();
    first.gestures.down(1, RIGHT, 400, 0);
    first.gestures.down(2, LEFT, 400, 20);
    first.gestures.move(2, LEFT, 400 - FULL_DEFLECTION_PX);
    first.gestures.move(1, RIGHT + FULL_DEFLECTION_PX, 400);
    expect(first.events).toContainEqual(['move', 0, -1]);
    expect(first.events).toContainEqual(['look', 1, 0]);
    first.gestures.up(2, 500);
    expect(first.events.at(-1)).toEqual(['move', 0, 0]);
    first.gestures.up(1, 520);
    expect(first.events.at(-1)).toEqual(['look', 0, 0]);

    const second = rig();
    second.gestures.down(1, LEFT, 400, 0);
    second.gestures.down(2, RIGHT, 400, 20);
    second.gestures.move(1, LEFT, 400 - FULL_DEFLECTION_PX);
    second.gestures.move(2, RIGHT + FULL_DEFLECTION_PX, 400);
    expect(second.events).toContainEqual(['move', 0, -1]);
    expect(second.events).toContainEqual(['look', 1, 0]);
  });

  it('a still finger on one half asks for nothing while the other half drags', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 400, 0);
    gestures.down(2, RIGHT, 400, 20);
    gestures.move(2, RIGHT + FULL_DEFLECTION_PX, 400);
    expect(events.some((e) => e[0] === 'move')).toBe(false);
  });

  it('a second finger on a half that already has one does nothing', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 0, 0);
    gestures.down(2, LEFT + 50, 0, 5);
    gestures.move(2, LEFT + 50, 60);
    expect(events).toEqual([]);
    gestures.move(1, LEFT, 60);
    expect(events.at(-1)[0]).toBe('move');
  });

  it('the dividing line is the middle: left of it walks, at it and right of it looks', () => {
    const left = rig();
    left.gestures.down(1, 199, 0, 0);
    left.gestures.move(1, 199, FULL_DEFLECTION_PX);
    expect(left.events.at(-1)[0]).toBe('move');
    const right = rig();
    right.gestures.down(1, 200, 0, 0);
    right.gestures.move(1, 200, FULL_DEFLECTION_PX);
    expect(right.events.at(-1)[0]).toBe('look');
  });

  it('two fingers are never a tap, whatever they do', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 0, 0);
    gestures.down(2, RIGHT, 0, 5);
    gestures.up(2, 50);
    gestures.up(1, 60);
    gestures.down(3, LEFT, 0, 100);
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

  it('works on either half of the screen', () => {
    for (const x of [LEFT, RIGHT]) {
      const { events, gestures } = rig();
      gestures.down(1, x, 50, 0); gestures.up(1, 30);
      gestures.down(2, x, 50, 100); gestures.up(2, 130);
      expect(events).toEqual([['double']]);
    }
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
    gestures.down(1, LEFT, 0, 0);
    gestures.down(2, RIGHT, 0, 5);
    gestures.move(1, LEFT, -50);
    gestures.move(2, RIGHT + 50, 0);
    events.length = 0;
    gestures.cancel();
    expect(events).toEqual([['move', 0, 0], ['look', 0, 0]]);
    expect(gestures.activeFingers()).toBe(0);
  });
});
