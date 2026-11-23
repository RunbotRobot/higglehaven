import { describe, expect, it } from 'vitest';
import { createFirstVisitHints, FIRST_HINT_STEPS, FIRST_HINTS_KEY, adoptAccountFirstHints } from './firstVisitHints.js';

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

// #4080: every arrival starts in the air, so the first hint must not be about walking.
describe('first-visit hints follow where the person is', () => {
  function airHarness(flying) {
    const log = { shown: [], marked: 0 };
    const state = { flying };
    const hints = createFirstVisitHints({
      show: (t) => log.shown.push(t),
      hide: () => {},
      done: () => false,
      markDone: () => { log.marked++; },
      inFlight: () => state.flying,
    });
    return { hints, log, state };
  }

  it('teaches flying first when the person is in the air, then looking, then coming down', () => {
    const { hints, log } = airHarness(true);
    hints.start();
    expect(log.shown).toEqual([FIRST_HINT_STEPS[0].airText]);
    expect(log.shown[0]).not.toMatch(/walk/i);
    hints.onGesture('walk');
    hints.onGesture('look');
    expect(log.shown.at(-1)).toBe(FIRST_HINT_STEPS[2].airText);
    expect(log.shown.at(-1)).toMatch(/land/i);
  });

  it('changes the words on screen when the person lands, and never repeats a learned gesture', () => {
    const { hints, log, state } = airHarness(true);
    hints.start();
    state.flying = false;
    hints.refresh();
    expect(log.shown).toEqual([FIRST_HINT_STEPS[0].airText, FIRST_HINT_STEPS[0].text]);
    // A drag on the left half is one gesture whether flying or walking: done once, not taught twice.
    state.flying = true;
    hints.onGesture('walk');
    state.flying = false;
    hints.refresh();
    expect(log.shown.at(-1)).toBe(FIRST_HINT_STEPS[1].text);
  });

  it('does not show a fresh line when nothing about the person changed', () => {
    const { hints, log } = airHarness(true);
    hints.start();
    hints.refresh();
    hints.refresh();
    expect(log.shown).toHaveLength(1);
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
