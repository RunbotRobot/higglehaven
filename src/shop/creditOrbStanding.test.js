import { describe, expect, it } from 'vitest';
import { creditOrbStandingState, creditOrbLimitNow } from './creditOrbStanding.js';

describe('credit orb standing bookkeeping (#3441)', () => {
  const reply = (remaining, retryAfterSeconds) => ({ limit: 20, windowSeconds: 900, remaining, retryAfterSeconds });

  it('is not limited while collects remain, and says nothing', () => {
    const state = creditOrbStandingState(reply(7, 400), 1000);
    expect(state.limitedUntilMs).toBeNull();
    expect(creditOrbLimitNow(state, 1000)).toBeNull();
  });

  it('is limited at zero remaining, counting the wait down from the server number', () => {
    const state = creditOrbStandingState(reply(0, 420), 10_000);
    expect(creditOrbLimitNow(state, 10_000)).toEqual({ limit: 20, windowSeconds: 900, retryAfterSeconds: 420 });
    expect(creditOrbLimitNow(state, 10_000 + 120_000).retryAfterSeconds).toBe(300);
  });

  it('lifts on its own once the stated time has passed, with no reload', () => {
    const state = creditOrbStandingState(reply(0, 60), 0);
    expect(creditOrbLimitNow(state, 59_999)).not.toBeNull();
    expect(creditOrbLimitNow(state, 60_000)).toBeNull();
  });

  it('a later reply with collects left replaces an earlier limit', () => {
    const limited = creditOrbStandingState(reply(0, 600), 0);
    const freed = creditOrbStandingState(reply(1, 300), 5000);
    expect(creditOrbLimitNow(limited, 5000)).not.toBeNull();
    expect(creditOrbLimitNow(freed, 5000)).toBeNull();
  });

  it('ignores a reply with no usable numbers', () => {
    expect(creditOrbStandingState(null, 0)).toBeNull();
    expect(creditOrbStandingState({}, 0)).toBeNull();
    expect(creditOrbLimitNow(null, 0)).toBeNull();
  });
});
