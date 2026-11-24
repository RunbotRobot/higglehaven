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

  it('two fingers that land at nearly the same moment are never a tap, whatever they do', () => {
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

describe('a double-tap while the other thumb is down (#4064)', () => {
  // The right thumb double-taps while the left one walks (flying or on the ground), and the other way round.
  function doubleTapWith(heldRole) {
    const { events, gestures } = rig();
    const heldX = heldRole === 'walk' ? LEFT : RIGHT;
    const tapX = heldRole === 'walk' ? RIGHT : LEFT;
    gestures.down(1, heldX, 300, 0);
    gestures.move(1, heldX, 300 - FULL_DEFLECTION_PX); // the held thumb is dragging
    const dragEvents = events.length;
    gestures.down(2, tapX, 100, 1000);
    gestures.up(2, 1060);
    gestures.down(3, tapX, 102, 1150);
    gestures.up(3, 1200);
    return { events, gestures, dragEvents };
  }

  it('takes off or lands from the right thumb while the left thumb walks', () => {
    const { events, dragEvents } = doubleTapWith('walk');
    expect(events.filter((e) => e[0] === 'double')).toHaveLength(1);
    expect(events.length).toBe(dragEvents + 1); // the walk is not interrupted: only the double-tap was added
  });

  it('takes off or lands from the left thumb while the right thumb looks', () => {
    const { events, dragEvents } = doubleTapWith('look');
    expect(events.filter((e) => e[0] === 'double')).toHaveLength(1);
    expect(events.length).toBe(dragEvents + 1);
  });

  it('works when the other thumb is down but still, and the walk carries on after the taps', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 300, 0);
    gestures.down(2, RIGHT, 100, 1000);
    gestures.up(2, 1050);
    gestures.down(3, RIGHT, 100, 1150);
    gestures.up(3, 1200);
    expect(events.filter((e) => e[0] === 'double')).toHaveLength(1);
    gestures.move(1, LEFT, 300 - FULL_DEFLECTION_PX);
    expect(events.at(-1)).toEqual(['move', 0, -1]);
  });

  it('a thumb landing between the two taps does not cancel the double-tap', () => {
    const { events, gestures } = rig();
    gestures.down(2, RIGHT, 100, 1000);
    gestures.up(2, 1050);
    gestures.down(1, LEFT, 300, 1100); // the walking thumb lands between the taps
    gestures.down(3, RIGHT, 100, 1200);
    gestures.up(3, 1250);
    expect(events.filter((e) => e[0] === 'double')).toHaveLength(1);
  });

  it('is still not a double-tap for a second finger on a half that already has one, a travelled finger, or a long hold', () => {
    const { events, gestures } = rig();
    gestures.down(1, RIGHT, 300, 0); // owns the right half
    gestures.down(2, RIGHT + 20, 100, 1000); // a second finger on the same half: ignored
    gestures.up(2, 1040);
    gestures.down(3, RIGHT + 20, 100, 1100);
    gestures.up(3, 1140);
    expect(events.some((e) => e[0] === 'double')).toBe(false);
    const held = rig();
    held.gestures.down(1, LEFT, 300, 0);
    held.gestures.down(2, RIGHT, 100, 1000);
    held.gestures.up(2, 1000 + TAP_MAX_MS + 50); // too long
    held.gestures.down(3, RIGHT, 100, 1500);
    held.gestures.up(3, 1550);
    expect(held.events.some((e) => e[0] === 'double')).toBe(false);
  });

  it('two fingers that land together on different halves are a fumble even if both lift quickly twice', () => {
    const { events, gestures } = rig();
    gestures.down(1, LEFT, 100, 0);
    gestures.down(2, RIGHT, 100, 20);
    gestures.up(1, 60);
    gestures.up(2, 70);
    gestures.down(3, LEFT, 100, 150);
    gestures.down(4, RIGHT, 100, 170);
    gestures.up(3, 200);
    gestures.up(4, 210);
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

describe('a computer mouse (#3831)', () => {
  it('looks wherever on the screen the drag starts, left half included', () => {
    const { events, gestures } = rig();
    gestures.down(9, 50, 400, 0, 'look');
    gestures.move(9, 50 + FULL_DEFLECTION_PX, 400);
    expect(events.at(-1)[0]).toBe('look');
    expect(events.at(-1)[1]).toBeCloseTo(1);
    expect(events.some((e) => e[0] === 'move')).toBe(false);
    gestures.up(9, 400);
    expect(events.at(-1)).toEqual(['look', 0, 0]);
  });

  it('a click that does not move is not a drag, and two clicks are never a double-tap', () => {
    const { events, gestures } = rig();
    gestures.down(9, 300, 400, 0, 'look');
    gestures.up(9, 60, 300, 400);
    gestures.down(9, 300, 400, 120, 'look');
    gestures.up(9, 180, 300, 400);
    expect(events).toEqual([]);
  });
});

describe('a finger the flight-height control claims (#4102)', () => {
  it('is forgotten without a tap, and a look it had started stops', () => {
    const { events, gestures } = rig();
    gestures.down(1, RIGHT, 400, 0);
    gestures.move(1, RIGHT + 30, 400);
    expect(events.at(-1)[0]).toBe('look');
    gestures.drop(1);
    expect(events.at(-1)).toEqual(['look', 0, 0]);
    expect(gestures.activeFingers()).toBe(0);
    events.length = 0;
    gestures.up(1, 100); // already gone: nothing happens, and it is never half of a double-tap
    expect(events).toEqual([]);
  });

  it('does nothing for a finger it never saw', () => {
    const { events, gestures } = rig();
    gestures.drop(7);
    expect(events).toEqual([]);
  });
});
