import { describe, expect, it } from 'vitest';
import { LOADING_TIPS, TIP_MIN_MS, tipReadingMs } from './loadingTips.js';
import { loadingTipsEnabled, nextTipIndex, rememberTipShown, setLoadingTipsEnabled } from './loadingTipPrefs.js';

// #3763: a tip is held for as long as a slow reader needs.
describe('how long a tip is held', () => {
  it('is never under six seconds, however short the tip', () => {
    expect(tipReadingMs('Fly up.')).toBe(TIP_MIN_MS);
    expect(TIP_MIN_MS).toBe(6000);
  });

  it('is two and a half words a second for a longer tip', () => {
    const twenty = Array.from({ length: 20 }, () => 'word').join(' ');
    expect(tipReadingMs(twenty)).toBe(8000);
    const thirty = Array.from({ length: 30 }, () => 'word').join(' ');
    expect(tipReadingMs(thirty)).toBe(12000);
  });

  it('holds every real tip for at least six seconds', () => {
    for (const tip of LOADING_TIPS) expect(tipReadingMs(tip.text)).toBeGreaterThanOrEqual(6000);
  });

  it('copes with nothing at all', () => {
    expect(tipReadingMs('')).toBe(6000);
    expect(tipReadingMs(undefined)).toBe(6000);
  });

  it('keeps the tip about moving first, for the first open ever', () => {
    expect(LOADING_TIPS[0].handbook).toBe('How do I walk around and look around?');
  });
});

describe('what the opening screen remembers about tips', () => {
  const store = () => {
    const data = {};
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
  };

  it('has tips on until they are switched off, and back on again', () => {
    const storage = store();
    expect(loadingTipsEnabled(storage)).toBe(true);
    setLoadingTipsEnabled(false, storage);
    expect(loadingTipsEnabled(storage)).toBe(false);
    setLoadingTipsEnabled(true, storage);
    expect(loadingTipsEnabled(storage)).toBe(true);
  });

  it('starts at the first tip with nothing stored, then takes turns', () => {
    const storage = store();
    expect(nextTipIndex(5, storage)).toBe(0);
    rememberTipShown(0, 5, storage);
    expect(nextTipIndex(5, storage)).toBe(1);
    rememberTipShown(4, 5, storage);
    expect(nextTipIndex(5, storage)).toBe(0);
  });

  it('ignores a stored value that makes no sense', () => {
    const storage = store();
    storage.setItem('higglehaven.loadingTips.next', 'banana');
    expect(nextTipIndex(5, storage)).toBe(0);
    storage.setItem('higglehaven.loadingTips.next', '12');
    expect(nextTipIndex(5, storage)).toBe(2);
  });
});
