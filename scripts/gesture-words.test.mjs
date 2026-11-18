import { describe, expect, it } from 'vitest';
import handbook from '../docs/assistant-handbook.md?raw';
import { parseHandbook } from './assistant-handbook-lib.mjs';
import { GESTURE_HANDBOOK, WALK_WORDS, LOOK_WORDS, FLY_WORDS } from '../src/ui/gestureWords.js';
import { FIRST_HINT_STEPS } from '../src/ui/firstVisitHints.js';
import { LOADING_TIPS } from '../src/ui/loadingTips.js';

// #3657: one source for the gesture words; the handbook must say the same.
const flat = (text) => text.replace(/\s+/g, ' ').toLowerCase();
describe('gesture words', () => {
  const entries = parseHandbook(handbook);
  for (const { entry, phrases } of GESTURE_HANDBOOK) {
    it(`the handbook entry "${entry}" says what the interface says`, () => {
      const found = entries.find((e) => e.title === entry);
      expect(found, entry).toBeTruthy();
      const body = flat(JSON.stringify(found));
      for (const phrase of phrases) expect(body, phrase).toContain(phrase);
    });
  }
  it('the hints and the tips are built from the shared words', () => {
    expect(FIRST_HINT_STEPS.map((s) => s.text)).toEqual([WALK_WORDS, LOOK_WORDS, FLY_WORDS]);
    expect(LOADING_TIPS[0].text.startsWith(WALK_WORDS)).toBe(true);
    expect(LOADING_TIPS[1].text.startsWith(FLY_WORDS)).toBe(true);
  });
});
