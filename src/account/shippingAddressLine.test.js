import { describe, it, expect } from 'vitest';
import { shippingAddressLine } from './myPurchases.js';

describe('shippingAddressLine (#4599)', () => {
  it('reads an address on one line, skipping what is empty', () => {
    expect(shippingAddressLine({ name: 'Ada Lovelace', line1: '1 Main St', line2: '', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' }))
      .toBe('Ada Lovelace, 1 Main St, Portland, OR 97201, US');
    expect(shippingAddressLine({ name: 'Linus', line1: '2 Rue', line2: 'Apt 4', city: 'Lyon', region: '', postalCode: '69001', country: 'FR' }))
      .toBe('Linus, 2 Rue, Apt 4, Lyon, 69001, FR');
  });
  it('is null when the order has no address', () => {
    expect(shippingAddressLine(null)).toBeNull();
    expect(shippingAddressLine(undefined)).toBeNull();
  });
});
