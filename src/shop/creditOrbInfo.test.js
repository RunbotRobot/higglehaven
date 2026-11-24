import { describe, expect, it } from 'vitest';
import { creditOrbAboutText, creditOrbBalanceWord, creditOrbCollectedText } from './creditOrbInfo.js';
import { rateLimitCapText, rateLimitNoticeText } from '../rateLimitNotice.js';

describe('creditOrbCollectedText', () => {
  it('says what was collected, how many are held, and where to use one', () => {
    const text = creditOrbCollectedText(3);
    expect(text).toContain('free credit');
    expect(text).toContain('You have 3 now.');
    expect(text).toContain('Build');
  });
  it('leaves the count out when the server did not say', () => {
    expect(creditOrbCollectedText(null)).not.toMatch(/You have/);
  });
  it('uses the accented word and no internal vocabulary', () => {
    for (const text of [creditOrbCollectedText(1), creditOrbAboutText({ limit: 20, windowSeconds: 900 })]) {
      expect(text).toContain('lándlet');
      expect(text).not.toMatch(/landlet|\bbud\b|flower|petal|leaf|modal|#\d/i);
    }
  });
});

describe('creditOrbBalanceWord', () => {
  it('says how many credits the person holds, singular for one', () => {
    expect(creditOrbBalanceWord(1)).toBe('1 credit');
    expect(creditOrbBalanceWord(2)).toBe('2 credits');
    expect(creditOrbBalanceWord(0)).toBe('0 credits');
    expect(creditOrbBalanceWord(12)).toBe('12 credits');
  });
  it('falls back to the old word until a balance is known', () => {
    expect(creditOrbBalanceWord(null)).toBe('Credit +1');
    expect(creditOrbBalanceWord(undefined)).toBe('Credit +1');
    expect(creditOrbBalanceWord(Number.NaN)).toBe('Credit +1');
    expect(creditOrbBalanceWord(-1)).toBe('Credit +1');
  });
});

describe('creditOrbAboutText', () => {
  it('states the limit from the server numbers, never a copy of its own', () => {
    expect(creditOrbAboutText({ limit: 20, windowSeconds: 900 })).toContain('You can collect up to 20 orbs every 15 minutes.');
    expect(creditOrbAboutText({ limit: 5, windowSeconds: 120 })).toContain('up to 5 orbs every 2 minutes');
  });
  it('says only what an orb is and how to collect it while no numbers are known', () => {
    const text = creditOrbAboutText(null);
    expect(text).toContain('Walk through it');
    expect(text).not.toMatch(/fly/i); // collected on contact: nothing promises flying into one (#4173)
    expect(text).not.toMatch(/up to/);
  });
});

describe('rateLimitCapText', () => {
  it('is the same sentence the limit notice starts with', () => {
    const limit = { limit: 20, windowSeconds: 900, retryAfterSeconds: 400 };
    expect(rateLimitNoticeText('orbs', limit).startsWith(rateLimitCapText('orbs', limit))).toBe(true);
  });
  it('is null without numbers', () => {
    expect(rateLimitCapText('orbs', null)).toBeNull();
    expect(rateLimitCapText('orbs', {})).toBeNull();
  });
});
