import { describe, expect, it } from 'vitest';
import {
  COUNTRY_CODES, SHIPPING_ZONE_IDS, shipsToCountry, shippingNote, shippingZoneOfCountry, shippingZonesOf, shippingZonesProblem,
} from '../../shared/shipping-zones.js';

describe('the country list and the zones (#4601)', () => {
  it('holds the 249 assigned codes once each', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect(COUNTRY_CODES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
  });

  it('puts every country in exactly one known zone', () => {
    for (const code of COUNTRY_CODES) {
      expect(SHIPPING_ZONE_IDS).toContain(shippingZoneOfCountry(code));
    }
  });

  it('puts the named countries where the list says', () => {
    expect(shippingZoneOfCountry('US')).toBe('us');
    expect(shippingZoneOfCountry('ca')).toBe('ca');
    expect(shippingZoneOfCountry(' mx ')).toBe('mx');
    expect(shippingZoneOfCountry('GB')).toBe('gb');
    expect(['AU', 'NZ'].map(shippingZoneOfCountry)).toEqual(['anz', 'anz']);
    expect(['JP', 'KR'].map(shippingZoneOfCountry)).toEqual(['jpkr', 'jpkr']);
    const eu = COUNTRY_CODES.filter((code) => shippingZoneOfCountry(code) === 'eu');
    expect(eu).toHaveLength(27);
    expect(eu).toContain('FR');
    expect(eu).not.toContain('GB');
    expect(eu).not.toContain('NO');
  });

  it('puts territories and everything unnamed in everywhere else, and refuses what is not a country', () => {
    expect(['PR', 'GU', 'CH', 'NO', 'BR'].map(shippingZoneOfCountry)).toEqual(['rest', 'rest', 'rest', 'rest', 'rest']);
    expect(['', 'USA', 'U', 'XX', null, undefined, 4].map(shippingZoneOfCountry)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe('what a product ships to (#4601)', () => {
  it('reads the old flag as what it always meant', () => {
    expect(shippingZonesOf({ domesticOnly: true })).toEqual(['us']);
    expect(shippingZonesOf({ domesticOnly: false })).toEqual(SHIPPING_ZONE_IDS);
    expect(shippingZonesOf({})).toEqual(SHIPPING_ZONE_IDS);
    expect(shippingZonesOf(undefined)).toEqual(SHIPPING_ZONE_IDS);
  });

  it('reads shippingZones when there is one, in the list order, ignoring the old flag', () => {
    expect(shippingZonesOf({ shippingZones: ['eu', 'us'], domesticOnly: true })).toEqual(['us', 'eu']);
  });

  it('answers by country', () => {
    expect(shipsToCountry({ domesticOnly: true }, 'US')).toBe(true);
    expect(shipsToCountry({ domesticOnly: true }, 'CA')).toBe(false);
    expect(shipsToCountry({}, 'JP')).toBe(true);
    expect(shipsToCountry({ shippingZones: ['us', 'ca'] }, 'CA')).toBe(true);
    expect(shipsToCountry({ shippingZones: ['us', 'ca'] }, 'MX')).toBe(false);
    expect(shipsToCountry({}, 'nowhere')).toBe(false);
  });

  it('words the card from the zones', () => {
    expect(shippingNote({})).toBe('ships worldwide');
    expect(shippingNote({ domesticOnly: true })).toBe('ships to United States only');
    expect(shippingNote({ shippingZones: ['us', 'ca'] })).toBe('ships to United States and Canada');
    expect(shippingNote({ shippingZones: ['us', 'ca', 'gb'] })).toBe('ships to United States, Canada and United Kingdom');
    expect(shippingNote({ shippingZones: [] })).toBe('does not ship');
  });

  it('checks what a seller sends', () => {
    expect(shippingZonesProblem(['us', 'eu'])).toBeNull();
    expect(shippingZonesProblem('us')).toMatch(/list/);
    expect(shippingZonesProblem([])).toMatch(/at least one/);
    expect(shippingZonesProblem(['us', 'mars'])).toMatch(/may only hold/);
    expect(shippingZonesProblem(['us', 'us'])).toMatch(/repeat/);
  });
});
