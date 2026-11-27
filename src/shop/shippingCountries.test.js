import { describe, it, expect } from 'vitest';
import { SHIPPING_COUNTRY_CODES, shippingCountryOptions, countryName } from './shippingCountries.js';
import { listKnownCountryCodes } from '../../worker/lib/country-codes.js';

describe('the shipping country list (#4599)', () => {
  it('is exactly the set of countries the server accepts', () => {
    expect([...SHIPPING_COUNTRY_CODES].sort()).toEqual(listKnownCountryCodes());
  });
  it('names each country and sorts by name', () => {
    expect(countryName('US', 'en')).toBe('United States');
    const options = shippingCountryOptions('en');
    expect(options).toHaveLength(SHIPPING_COUNTRY_CODES.length);
    expect(options.find((o) => o.code === 'FR').name).toBe('France');
    const names = options.map((o) => o.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names);
  });
});
