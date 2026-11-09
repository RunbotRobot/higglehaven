import { describe, expect, it } from 'vitest';
import { rateLimitMessage, rateLimitNoticeText } from './rateLimitNotice.js';

describe('rateLimitNoticeText (#3258)', () => {
  it('states the limit, the window and the wait', () => {
    expect(rateLimitNoticeText('orbs', { limit: 20, windowSeconds: 900, retryAfterSeconds: 400 }))
      .toBe('You can collect up to 20 orbs every 15 minutes. Try again in about 7 minutes.');
  });
  it('rounds the wait up to whole minutes and singularises one minute', () => {
    expect(rateLimitNoticeText('orbs', { limit: 20, windowSeconds: 900, retryAfterSeconds: 61 }))
      .toBe('You can collect up to 20 orbs every 15 minutes. Try again in about 2 minutes.');
    expect(rateLimitNoticeText('orbs', { limit: 5, windowSeconds: 60, retryAfterSeconds: 60 }))
      .toBe('You can collect up to 5 orbs every 1 minute. Try again in about 1 minute.');
  });
  it('says "under a minute" for a short wait', () => {
    expect(rateLimitNoticeText('orbs', { limit: 20, windowSeconds: 900, retryAfterSeconds: 12 }))
      .toBe('You can collect up to 20 orbs every 15 minutes. Try again in under a minute.');
  });
  it('returns null when the response carried no numbers', () => {
    expect(rateLimitNoticeText('orbs', undefined)).toBeNull();
  });
});

describe('rateLimitMessage (#3275)', () => {
  it('states the limit, the window and the wait for any action', () => {
    expect(rateLimitMessage({ limit: 20, windowSeconds: 900, retryAfterSeconds: 400 }))
      .toBe("You've reached the limit for this (20 every 15 minutes). Try again in about 7 minutes.");
  });
  it('singularises one minute and says "under a minute" for a short wait', () => {
    expect(rateLimitMessage({ limit: 5, windowSeconds: 60, retryAfterSeconds: 60 }))
      .toBe("You've reached the limit for this (5 every 1 minute). Try again in about 1 minute.");
    expect(rateLimitMessage({ limit: 5, windowSeconds: 60, retryAfterSeconds: 9 }))
      .toBe("You've reached the limit for this (5 every 1 minute). Try again in under a minute.");
  });
  it('returns null when the response carried no numbers', () => {
    expect(rateLimitMessage(undefined)).toBeNull();
  });
});
