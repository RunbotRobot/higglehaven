import { describe, expect, it } from 'vitest';
import { hasFractionOfACent } from './priceInput.js';

describe('hasFractionOfACent (#4368)', () => {
  it('is true for digits past the cent', () => {
    for (const text of ['12.999', '1.005', '$0.001', '3.141']) expect(hasFractionOfACent(text)).toBe(true);
  });
  it('is false for whole cents, trailing zeros and plain numbers', () => {
    for (const text of ['12.99', '12.5', '12', '1.500', '1,000.00', '$12.00', '', '0', '.5', 'abc']) expect(hasFractionOfACent(text)).toBe(false);
  });
});
