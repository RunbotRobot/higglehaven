import { describe, it, expect } from 'vitest';
import { addressRemovedText } from './myPurchases.js';

// #4636: the line where an order's address copy has been cleared.
describe('addressRemovedText', () => {
  it('names the day it was removed', () => {
    const iso = '2026-05-04T12:00:00.000Z';
    expect(addressRemovedText(iso)).toBe(`Address removed on ${new Date(iso).toLocaleDateString()}`);
  });
  it('says only that it is gone for an order cleared before the date was recorded', () => {
    expect(addressRemovedText(null)).toBe('Address no longer kept');
    expect(addressRemovedText('nonsense')).toBe('Address no longer kept');
  });
});
