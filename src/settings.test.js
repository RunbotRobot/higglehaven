import { describe, expect, it } from 'vitest';
import { fromDisplayLength, formatLength, toDisplayLength, unitSuffix, areaSuffix, toDisplayArea, formatArea } from './settings.js';

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

describe('areaSuffix', () => {
  it('returns ft² for feet', () => {
    expect(areaSuffix('ft')).toBe('ft²');
  });

  it('returns m² for meters', () => {
    expect(areaSuffix('m')).toBe('m²');
  });

  it('falls back to m² for anything else', () => {
    expect(areaSuffix('yards')).toBe('m²');
  });
});

describe('toDisplayArea', () => {
  it('passes square meters through unchanged', () => {
    expect(toDisplayArea(10, 'm')).toBe(10);
    expect(toDisplayArea(0, 'm')).toBe(0);
  });

  it('converts square meters to square feet using the squared factor, not the linear one', () => {
    // 1 m == ~3.28084 ft (linear), so 1 m² == ~10.7639 ft² (squared) —
    // reusing the linear factor directly here would have been the bug.
    expect(toDisplayArea(1, 'ft')).toBeCloseTo(10.7639, 3);
    expect(toDisplayArea(0.3048 * 0.3048, 'ft')).toBeCloseTo(1, 8);
  });

  it('treats an unrecognized unit as meters', () => {
    expect(toDisplayArea(10, 'yards')).toBe(10);
  });
});

describe('formatArea', () => {
  it('formats square meters with a suffix and default 2 decimals', () => {
    expect(formatArea(1, 2, 'm')).toBe('1.00m²');
  });

  it('formats square feet, converting and suffixing', () => {
    expect(formatArea(1, 2, 'ft')).toBe('10.76ft²');
  });

  it('honors a custom decimal count', () => {
    expect(formatArea(1000, 0, 'm')).toBe('1000m²');
  });
});
