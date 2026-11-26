// #4440: the switch in the address picks a variant and only a known one; the drawn petals are what each variant lists.
import { describe, expect, it } from 'vitest';
import { BLOOM_VARIANTS, bloomVariantFromSearch } from './bloom.js';

describe('bloom variants (#4440)', () => {
  it('reads a known variant from the address and nothing else', () => {
    expect(bloomVariantFromSearch('?bloom=petals')).toBe('petals');
    expect(bloomVariantFromSearch('?x=1&bloom=ring')).toBe('ring');
    expect(bloomVariantFromSearch('?bloom=sepals')).toBe('sepals');
    expect(bloomVariantFromSearch('')).toBeNull();
    expect(bloomVariantFromSearch('?bloom=')).toBeNull();
    expect(bloomVariantFromSearch('?bloom=toString')).toBeNull();
    expect(bloomVariantFromSearch('?bloom=nope')).toBeNull();
  });
  it('draws no petal at the angles of the three mode petals in the large variant, so they are never covered', () => {
    for (const mode of [6, 36, 66]) expect(BLOOM_VARIANTS.petals.some((p) => p.a === mode)).toBe(false);
  });
  it('every petal has an angle, a length between 0 and 1 and a known tone', () => {
    for (const petals of Object.values(BLOOM_VARIANTS)) {
      for (const p of petals) {
        expect(Number.isFinite(p.a)).toBe(true);
        expect(p.len).toBeGreaterThan(0);
        expect(p.len).toBeLessThanOrEqual(1);
        expect(['pale', 'green', 'cream', 'sepal']).toContain(p.tone);
      }
    }
  });
});
