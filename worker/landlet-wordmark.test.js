// #3781: a landlet's wordmark choice is validated against the one shared set.
import { describe, expect, it } from 'vitest';
import { landletFromRow, validateLandlet } from './index.js';
import { WORDMARK_STYLE_IDS, WORDMARK_COLOR_IDS, DEFAULT_WORDMARK_ID } from '../shared/wordmark-set.js';

const base = { landletId: 'l1', name: 'Test', areaM2: 1000 };

describe('landlet wordmark choice (#3781)', () => {
  it('defaults to the default look', () => {
    const l = validateLandlet(base, 'l1');
    expect(l.wordmarkStyle).toBe(DEFAULT_WORDMARK_ID);
    expect(l.wordmarkColors).toBe(DEFAULT_WORDMARK_ID);
  });
  it('accepts every id in the shared set', () => {
    for (const style of WORDMARK_STYLE_IDS) for (const colors of WORDMARK_COLOR_IDS) {
      const l = validateLandlet({ ...base, wordmarkStyle: style, wordmarkColors: colors }, 'l1');
      expect([l.wordmarkStyle, l.wordmarkColors]).toEqual([style, colors]);
    }
  });
  it('refuses an id outside the set with a plain message', () => {
    expect(() => validateLandlet({ ...base, wordmarkStyle: 'comic-sans' }, 'l1')).toThrow(/lettering style/);
    expect(() => validateLandlet({ ...base, wordmarkColors: 7 }, 'l1')).toThrow(/colour choice/);
  });
  it('reads back from a row, defaulting when absent', () => {
    expect(landletFromRow({ polygon_json: '[]', metadata_json: '{}' }).wordmarkStyle).toBe(DEFAULT_WORDMARK_ID);
  });
});
