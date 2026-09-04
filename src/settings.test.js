import { describe, expect, it } from 'vitest';
import { fromDisplayLength, formatLength, toDisplayLength, unitSuffix } from './settings.js';

// getUnits/setUnits aren't covered here: they read/write localStorage, a
// browser global this test pool (workerd, not jsdom) doesn't provide.
// Every function below is exercised with an explicit `units` argument so
// none of them fall through to getUnits()'s localStorage read. The
// localStorage-backed pair stays covered by e2e/'s real Units toggle.

describe('unitSuffix', () => {
  it('returns ft for feet', () => {
    expect(unitSuffix('ft')).toBe('ft');
  });

  it('returns m for meters', () => {
    expect(unitSuffix('m')).toBe('m');
  });

  it('falls back to m for anything else', () => {
    expect(unitSuffix('yards')).toBe('m');
    expect(unitSuffix('')).toBe('m');
  });
});

describe('toDisplayLength', () => {
  it('passes meters through unchanged', () => {
    expect(toDisplayLength(10, 'm')).toBe(10);
    expect(toDisplayLength(0, 'm')).toBe(0);
  });

  it('converts meters to feet', () => {
    expect(toDisplayLength(1, 'ft')).toBeCloseTo(3.28084, 4);
    expect(toDisplayLength(0.3048, 'ft')).toBeCloseTo(1, 10);
  });

  it('treats an unrecognized unit as meters', () => {
    expect(toDisplayLength(10, 'yards')).toBe(10);
  });
});

describe('fromDisplayLength', () => {
  it('passes meters through unchanged', () => {
    expect(fromDisplayLength(10, 'm')).toBe(10);
  });

  it('converts feet to meters', () => {
    expect(fromDisplayLength(1, 'ft')).toBeCloseTo(0.3048, 10);
    expect(fromDisplayLength(3.28084, 'ft')).toBeCloseTo(1, 4);
  });

  it('round-trips through toDisplayLength/fromDisplayLength in feet', () => {
    const meters = 1000;
    const roundTripped = fromDisplayLength(toDisplayLength(meters, 'ft'), 'ft');
    expect(roundTripped).toBeCloseTo(meters, 8);
  });
});

describe('formatLength', () => {
  it('formats meters with a suffix and default 2 decimals', () => {
    expect(formatLength(1, 2, 'm')).toBe('1.00m');
  });

  it('formats feet, converting and suffixing', () => {
    expect(formatLength(1, 2, 'ft')).toBe('3.28ft');
  });

  it('honors a custom decimal count', () => {
    expect(formatLength(1, 0, 'm')).toBe('1m');
    expect(formatLength(1, 4, 'ft')).toBe('3.2808ft');
  });

  it('handles zero and negative lengths', () => {
    expect(formatLength(0, 2, 'm')).toBe('0.00m');
    expect(formatLength(-5, 2, 'm')).toBe('-5.00m');
  });
});
