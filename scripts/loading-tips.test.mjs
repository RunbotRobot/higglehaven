import { describe, expect, it } from 'vitest';
import handbook from '../docs/assistant-handbook.md?raw';
import { parseHandbook } from './assistant-handbook-lib.mjs';
import { LOADING_TIPS } from '../src/ui/loadingTips.js';

// #3738 (part of #3735): the opening screen's tips are short forms of handbook
// entries, kept true by this test. A tip names its entry and the phrases it
// borrows; when the interface changes and the handbook entry is rewritten, a tip
// that still says the old thing fails here.
const entries = parseHandbook(handbook);
const normal = (value) => String(value).toLowerCase().replace(/\s+/g, ' ');

describe('the opening screen tips', () => {
  it('has a handful of them', () => {
    expect(LOADING_TIPS.length).toBeGreaterThanOrEqual(4);
  });

  for (const tip of LOADING_TIPS) {
    describe(tip.text, () => {
      const entry = entries.find((candidate) => candidate.title === tip.handbook);

      it('names a handbook entry that exists', () => {
        expect(entry, tip.handbook).toBeTruthy();
      });

      it('only borrows words that entry still uses', () => {
        expect(tip.words.length).toBeGreaterThan(0);
        for (const word of tip.words) {
          expect(normal(`${entry.title}\n${entry.text}`).includes(normal(word)), `"${word}" is not in "${tip.handbook}"`).toBe(true);
        }
      });

      it('reads well: one short line, "lándlet" with its accent, nothing internal', () => {
        expect(tip.text.length).toBeLessThanOrEqual(100);
        expect(tip.text).not.toMatch(/\b(?:land|landlet|lánd|plot|lot)s?\b/i);
        expect(tip.text).not.toMatch(/#\d+|\.(?:js|mjs|md|html|css)\b|\b(?:docs|src|worker)\//);
      });
    });
  }
});
