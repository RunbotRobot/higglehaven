import { describe, expect, it } from 'vitest';
import {
  classifyHandlingKind,
  nextHandlingBlend,
  nextPhase,
  shouldEndItemHandling,
} from './itemHandling.js';

describe('classifyHandlingKind', () => {
  it('is pick-up-and-turn at/under the small threshold', () => {
    expect(classifyHandlingKind(0.5, 0.5)).toBe('pick-up-and-turn');
    expect(classifyHandlingKind(0.2, 0.5)).toBe('pick-up-and-turn');
  });

  it('is walk-around above the small threshold', () => {
    expect(classifyHandlingKind(0.51, 0.5)).toBe('walk-around');
    expect(classifyHandlingKind(3, 0.5)).toBe('walk-around');
  });
});

describe('nextHandlingBlend', () => {
  it('eases toward 1 while active', () => {
    const blend = nextHandlingBlend(0, true, 4, 0.1);
    expect(blend).toBeGreaterThan(0);
    expect(blend).toBeLessThan(1);
  });

  it('eases toward 0 while inactive', () => {
    const blend = nextHandlingBlend(1, false, 4, 0.1);
    expect(blend).toBeLessThan(1);
    expect(blend).toBeGreaterThan(0);
  });

  it('never overshoots past the target in one step', () => {
    expect(nextHandlingBlend(0, true, 100, 1)).toBe(1);
    expect(nextHandlingBlend(1, false, 100, 1)).toBe(0);
  });
});

describe('nextPhase', () => {
  it('completes exactly one full revolution after periodS seconds', () => {
    expect(nextPhase(0, 2, 2)).toBeCloseTo(Math.PI * 2, 10);
  });

  it('advances proportionally within a period', () => {
    expect(nextPhase(0, 4, 1)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('accumulates across multiple calls', () => {
    let phase = 0;
    phase = nextPhase(phase, 4, 1);
    phase = nextPhase(phase, 4, 1);
    expect(phase).toBeCloseTo(Math.PI, 10);
  });
});

describe('shouldEndItemHandling', () => {
  const base = { airborne: false, moveMagnitude: 0, elapsedS: 0, maxDurationS: 4 };

  it('is false while grounded, idle, and under the duration cap', () => {
    expect(shouldEndItemHandling(base)).toBe(false);
  });

  it('ends immediately when airborne', () => {
    expect(shouldEndItemHandling({ ...base, airborne: true })).toBe(true);
  });

  it('ends immediately on real movement input', () => {
    expect(shouldEndItemHandling({ ...base, moveMagnitude: 0.3 })).toBe(true);
  });

  it('ends once the duration cap is reached', () => {
    expect(shouldEndItemHandling({ ...base, elapsedS: 4 })).toBe(true);
    expect(shouldEndItemHandling({ ...base, elapsedS: 3.99 })).toBe(false);
  });
});
