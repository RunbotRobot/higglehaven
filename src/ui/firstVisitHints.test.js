import { describe, expect, it } from 'vitest';
import { createFirstVisitHints, FIRST_HINT_STEPS } from './firstVisitHints.js';

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
