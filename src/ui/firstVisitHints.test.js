import { describe, expect, it } from 'vitest';
import { createFirstVisitHints, FIRST_HINT_STEPS, FIRST_HINT_STEPS_KEYBOARD, FIRST_HINTS_KEY, adoptAccountFirstHints } from './firstVisitHints.js';
import { FLY_MOVE_WORDS, LAND_WORDS, WALK_WORDS, LOOK_WORDS, FLY_WORDS, KEY_FLY_MOVE_WORDS, KEY_LAND_WORDS } from './gestureWords.js';

function harness(alreadyDone = false) {
  const log = { shown: [], hidden: 0, marked: 0 };
  const hints = createFirstVisitHints({
    show: (t) => log.shown.push(t),
    hide: () => { log.hidden++; },
    done: () => alreadyDone,
    markDone: () => { log.marked++; },
  });
  return { hints, log };
}

describe('first-visit hints', () => {
  it('shows one hint at a time and moves on as each gesture is done', () => {
    const { hints, log } = harness();
    hints.start();
    expect(log.shown).toEqual([FIRST_HINT_STEPS[0].text]);
    hints.onGesture('walk');
    expect(log.shown.at(-1)).toBe(FIRST_HINT_STEPS[1].text);
    hints.onGesture('look');
    hints.onGesture('fly');
    expect(log.hidden).toBe(1);
    expect(log.marked).toBe(1);
  });

  it('skips a step already done before the hints began', () => {
    const { hints, log } = harness();
    hints.onGesture('walk');
    hints.start();
    expect(log.shown).toEqual([FIRST_HINT_STEPS[1].text]);
  });

  it('never starts again once done, and ignores the wrong gesture', () => {
    const again = harness(true);
    expect(again.hints.start()).toBe(false);
    expect(again.log.shown).toEqual([]);
    const { hints, log } = harness();
    hints.start();
    hints.onGesture('fly');
    expect(log.shown).toEqual([FIRST_HINT_STEPS[0].text]);
  });
});

// #3657: an account that has been through the hints is not taught again on a new device.
describe('first-visit hints remembered by the account', () => {
  function fakeStorage() {
    const data = new Map();
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  }

  it('copies an account that is done onto this device', () => {
    const storage = fakeStorage();
    adoptAccountFirstHints({ firstHintsDone: true }, storage);
    expect(storage.getItem(FIRST_HINTS_KEY)).toBe('1');
  });

  it('leaves the device as it is for an account that has not done them, or no account', () => {
    const storage = fakeStorage();
    adoptAccountFirstHints({ firstHintsDone: false }, storage);
    adoptAccountFirstHints({}, storage);
    adoptAccountFirstHints(null, storage);
    expect(storage.getItem(FIRST_HINTS_KEY)).toBeNull();
    storage.setItem(FIRST_HINTS_KEY, '1');
    adoptAccountFirstHints({ firstHintsDone: false }, storage);
    expect(storage.getItem(FIRST_HINTS_KEY)).toBe('1');
  });

  it('does not throw when storage is blocked', () => {
    const blocked = { setItem() { throw new Error('blocked'); } };
    expect(() => adoptAccountFirstHints({ firstHintsDone: true }, blocked)).not.toThrow();
  });
});

// #4080: every Shop arrival starts in the air, so the first words must be true there.
describe('first-visit hints follow whether the person is flying', () => {
  function flightHarness(startFlying, steps = FIRST_HINT_STEPS) {
    const state = { flying: startFlying };
    const shown = [];
    const hints = createFirstVisitHints({
      show: (t) => shown.push(t), hide: () => {}, done: () => false, markDone: () => {}, steps, isFlying: () => state.flying,
    });
    return { hints, shown, state };
  }

  it('teaches flying, looking, then how to come down, when the person arrives in the air', () => {
    const { hints, shown } = flightHarness(true);
    hints.start();
    expect(shown).toEqual([FLY_MOVE_WORDS]);
    hints.onGesture('walk');
    expect(shown.at(-1)).toBe(LOOK_WORDS);
    hints.onGesture('look');
    expect(shown.at(-1)).toBe(LAND_WORDS);
  });

  it('says walk, not fly, once the person is on the ground', () => {
    const { hints, shown, state } = flightHarness(true);
    hints.start();
    expect(shown).toEqual([FLY_MOVE_WORDS]);
    state.flying = false; // came down without dragging
    hints.onFlightChange();
    expect(shown.at(-1)).toBe(WALK_WORDS);
    state.flying = true; // and back up: the same step reads true again
    hints.onFlightChange();
    expect(shown.at(-1)).toBe(FLY_MOVE_WORDS);
  });

  it('does not repeat a gesture learned in the air with only the verb changed', () => {
    const { hints, shown, state } = flightHarness(true);
    hints.start();
    hints.onGesture('walk'); // dragged to fly
    hints.onGesture('look');
    state.flying = false;
    hints.onFlightChange();
    // The movement drag is known, so no "walk" hint: the next unlearned thing, flying, is shown.
    expect(shown).not.toContain(WALK_WORDS);
    expect(shown.at(-1)).toBe(FLY_WORDS);
  });

  it('does not show the same words twice for a flight change that changes nothing', () => {
    const { hints, shown } = flightHarness(true);
    hints.start();
    hints.onFlightChange();
    hints.onFlightChange();
    expect(shown).toEqual([FLY_MOVE_WORDS]);
  });

  it('says it in key words for a computer', () => {
    const { hints, shown } = flightHarness(true, FIRST_HINT_STEPS_KEYBOARD);
    hints.start();
    expect(shown).toEqual([KEY_FLY_MOVE_WORDS]);
    hints.onGesture('walk');
    hints.onGesture('look');
    expect(shown.at(-1)).toBe(KEY_LAND_WORDS);
  });
});
