import { describe, expect, it } from 'vitest';
import {
  creditOrbContact, creditOrbRefusalKind, creditOrbMayRetry,
  CREDIT_ORB_SWEEP_MAX_STEP_M, CREDIT_ORB_RETRY_WINDOW_MS,
} from './creditOrbCollect.js';

const REACH = 0.55; // 0.3 m avatar half-width + 0.25 m orb radius

describe('creditOrbContact (#3392)', () => {
  it('fires when the body meets the orb surface, not before', () => {
    const at = (x) => creditOrbContact({ orbX: 0, orbY: 0, from: null, to: { x, y: 0 }, reachM: REACH });
    expect(at(0.5)).toBe(true);
    expect(at(0.56)).toBe(false);
    // The old 1.5 m trigger would already have fired here, visibly short of the orb.
    expect(at(1.4)).toBe(false);
  });

  it('catches a fast pass through the orb between two frames', () => {
    const base = { orbX: 0, orbY: 0, reachM: REACH };
    // 6 m in one frame straight through the orb: neither end point is near it.
    expect(creditOrbContact({ ...base, from: { x: -3, y: 0 }, to: { x: 3, y: 0 } })).toBe(true);
    // A pass that misses it sideways does not.
    expect(creditOrbContact({ ...base, from: { x: -3, y: 2 }, to: { x: 3, y: 2 } })).toBe(false);
  });

  it('judges a teleport-sized jump at its end point only', () => {
    const jump = CREDIT_ORB_SWEEP_MAX_STEP_M + 5;
    const through = creditOrbContact({
      orbX: 0, orbY: 0, from: { x: -jump / 2, y: 0 }, to: { x: jump / 2, y: 0 }, reachM: REACH,
    });
    expect(through).toBe(false);
    const landed = creditOrbContact({
      orbX: 0, orbY: 0, from: { x: -jump, y: 0 }, to: { x: 0.2, y: 0 }, reachM: REACH,
    });
    expect(landed).toBe(true);
  });

  it('handles an avatar that did not move', () => {
    expect(creditOrbContact({ orbX: 1, orbY: 1, from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, reachM: REACH })).toBe(false);
    expect(creditOrbContact({ orbX: 5, orbY: 5.2, from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, reachM: REACH })).toBe(true);
  });
});

describe('creditOrbRefusalKind (#3392)', () => {
  it('maps the server answers to what happens to the popped orb', () => {
    expect(creditOrbRefusalKind({ status: 404 })).toBe('gone');
    expect(creditOrbRefusalKind({ status: 429 })).toBe('limited');
    expect(creditOrbRefusalKind({ status: 403 })).toBe('retry');
    expect(creditOrbRefusalKind({ status: 500 })).toBe('retry');
    expect(creditOrbRefusalKind(new TypeError('Failed to fetch'))).toBe('retry');
    expect(creditOrbRefusalKind(undefined)).toBe('retry');
  });
});

describe('creditOrbMayRetry (#3392)', () => {
  it('retries inside the window and gives up at its end', () => {
    expect(creditOrbMayRetry(0)).toBe(true);
    expect(creditOrbMayRetry(CREDIT_ORB_RETRY_WINDOW_MS / 2)).toBe(true);
    expect(creditOrbMayRetry(CREDIT_ORB_RETRY_WINDOW_MS)).toBe(false);
    expect(creditOrbMayRetry(CREDIT_ORB_RETRY_WINDOW_MS - 100)).toBe(false);
  });
});
