import { describe, expect, it } from 'vitest';
import { ORB_LOAD_RETRY_MS, noteOrbLoadFailed, orbLoadDue } from './orbLoadRetry.js';

const fresh = () => ({ orbsLoaded: false, orbLoadToken: 0 });

describe('credit orbs are fetched again after a failed load (#4252)', () => {
  it('loads a landlet in range that is not loaded', () => {
    expect(orbLoadDue(fresh(), 20, 60, 1000)).toBe(true);
    expect(orbLoadDue(fresh(), 80, 60, 1000)).toBe(false);
    expect({ ...fresh(), orbsLoaded: true }).toSatisfy((entry) => !orbLoadDue(entry, 20, 60, 1000));
  });

  it('a failed load clears the mark and waits before the next try', () => {
    const entry = { orbsLoaded: true, orbLoadToken: 3 };
    expect(noteOrbLoadFailed(entry, 3, 5000)).toBe(true);
    expect(entry.orbsLoaded).toBe(false);
    expect(orbLoadDue(entry, 20, 60, 5000 + ORB_LOAD_RETRY_MS - 1)).toBe(false);
    expect(orbLoadDue(entry, 20, 60, 5000 + ORB_LOAD_RETRY_MS)).toBe(true);
  });

  it('a load that was superseded does not clear the newer load\'s mark', () => {
    const entry = { orbsLoaded: true, orbLoadToken: 4 };
    expect(noteOrbLoadFailed(entry, 3, 5000)).toBe(false);
    expect(entry.orbsLoaded).toBe(true);
    expect(orbLoadDue(entry, 20, 60, 999999)).toBe(false);
  });

  it('keeps trying, once per wait, while it keeps failing', () => {
    const entry = { orbsLoaded: false, orbLoadToken: 0 };
    let now = 0;
    let tries = 0;
    for (let tick = 0; tick < 100; tick += 1) {
      now += 1000;
      if (orbLoadDue(entry, 20, 60, now)) {
        entry.orbsLoaded = true;
        entry.orbLoadToken += 1;
        tries += 1;
        noteOrbLoadFailed(entry, entry.orbLoadToken, now);
      }
    }
    expect(tries).toBeGreaterThanOrEqual(6);
    expect(tries).toBeLessThanOrEqual(7); // one try per 15 s over 100 s, not one per tick
  });
});
