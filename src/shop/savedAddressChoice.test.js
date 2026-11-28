import { describe, expect, it } from 'vitest';
import { formFromSaved, savedFromForm, sameAsSaved, savedFittingCountries, startingSaved, savedLabel } from './savedAddressChoice.js';

const saved = { addressId: 'a1', recipientName: 'Ana Rivera', line1: '12 Orchard Lane', line2: null, city: 'Portland', region: 'OR', postalCode: '97201', country: 'US', isDefault: true };

describe('saved address choice (#4674)', () => {
  it('turns a saved address into the form and back', () => {
    expect(formFromSaved(saved)).toEqual({ name: 'Ana Rivera', line1: '12 Orchard Lane', line2: '', city: 'Portland', region: 'OR', postalCode: '97201', country: 'US' });
    expect(savedFromForm(formFromSaved(saved))).toMatchObject({ recipientName: 'Ana Rivera', line2: '', country: 'US' });
  });

  it('knows a typed address is the saved one despite case and spacing', () => {
    const typed = { ...formFromSaved(saved), name: '  ana   rivera ', city: 'PORTLAND' };
    expect(sameAsSaved(typed, saved)).toBe(true);
    expect(sameAsSaved({ ...typed, line1: '13 Orchard Lane' }, saved)).toBe(false);
  });

  it('keeps the saved addresses the seller sends to and starts with the default that fits', () => {
    const canada = { ...saved, addressId: 'a2', country: 'CA', isDefault: false };
    expect(savedFittingCountries([saved, canada], ['CA'])).toEqual([canada]);
    expect(savedFittingCountries([saved, canada], null)).toHaveLength(2);
    expect(startingSaved([canada, saved])).toBe(saved);
    expect(startingSaved([canada])).toBe(canada);
    expect(startingSaved([])).toBeNull();
  });

  it('labels a choice with who, where and the city', () => {
    expect(savedLabel(saved)).toBe('Ana Rivera, 12 Orchard Lane, Portland');
  });
});
