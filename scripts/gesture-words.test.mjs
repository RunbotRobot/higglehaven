import { describe, expect, it } from 'vitest';
import handbook from '../docs/assistant-handbook.md?raw';
import { parseHandbook } from './assistant-handbook-lib.mjs';
import { GESTURE_HANDBOOK, WALK_WORDS, LOOK_WORDS, FLY_WORDS, FRIEND_WORDS, KEY_WALK_WORDS, KEY_LOOK_WORDS, KEY_FLY_WORDS } from '../src/ui/gestureWords.js';
import { FIRST_HINT_STEPS, FIRST_HINT_STEPS_KEYBOARD } from '../src/ui/firstVisitHints.js';
import { LOADING_TIPS, tipText } from '../src/ui/loadingTips.js';

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
  it('the friendship tap is taught in the opening tips, from the same words (#3555)', () => {
    const tip = LOADING_TIPS.find((candidate) => candidate.text.startsWith(FRIEND_WORDS));
    expect(tip, 'a loading tip starts with FRIEND_WORDS').toBeTruthy();
    expect(tip.handbook).toBe('How do I add a friend and send them a message?');
  });
  it('a computer is taught the keys and the mouse, in the same shared words', () => {
    expect(FIRST_HINT_STEPS_KEYBOARD.map((step) => step.text)).toEqual([KEY_WALK_WORDS, KEY_LOOK_WORDS, KEY_FLY_WORDS]);
    expect(LOADING_TIPS[0].keyText.startsWith(KEY_WALK_WORDS)).toBe(true);
    expect(LOADING_TIPS[1].keyText.startsWith(KEY_FLY_WORDS)).toBe(true);
  });
  it('picks the tip words by device: keys for a computer, gestures for touch and for anything unknown', () => {
    const win = (fine, coarse) => ({ matchMedia: (query) => ({ matches: query.includes('fine') ? fine : coarse }) });
    expect(tipText(LOADING_TIPS[0], win(true, false))).toBe(LOADING_TIPS[0].keyText);
    expect(tipText(LOADING_TIPS[0], win(false, true))).toBe(LOADING_TIPS[0].text);
    expect(tipText(LOADING_TIPS[0], win(true, true))).toBe(LOADING_TIPS[0].text);
    expect(tipText(LOADING_TIPS[0], null)).toBe(LOADING_TIPS[0].text);
    expect(tipText(LOADING_TIPS[2], win(true, false))).toBe(LOADING_TIPS[2].text);
  });
});
