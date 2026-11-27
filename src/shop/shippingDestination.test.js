import { describe, expect, it } from 'vitest';
import { doesNotShipToMe } from './shippingDestination.js';

const on = (country) => ({ country, dimUnshippable: true });
const domestic = { category: 'furniture', metadata: { domesticOnly: true } };
const everywhere = { category: 'furniture', metadata: {} };

describe('what does not ship to me (#4602)', () => {
  it('judges a physical product by the shopper\'s country', () => {
    expect(doesNotShipToMe(domestic, on('FR'))).toBe(true);
    expect(doesNotShipToMe(domestic, on('US'))).toBe(false);
    expect(doesNotShipToMe(everywhere, on('FR'))).toBe(false);
    expect(doesNotShipToMe({ category: 'furniture', metadata: { shippingZones: ['eu'] } }, on('FR'))).toBe(false);
    expect(doesNotShipToMe({ category: 'furniture', metadata: { shippingZones: ['eu'] } }, on('JP'))).toBe(true);
  });
  it('dims nothing with the switch off or with no destination', () => {
    expect(doesNotShipToMe(domestic, { country: 'FR', dimUnshippable: false })).toBe(false);
    expect(doesNotShipToMe(domestic, { country: null, dimUnshippable: true })).toBe(false);
  });
  it('never judges a digital good', () => {
    expect(doesNotShipToMe({ category: 'avatar', metadata: { domesticOnly: true } }, on('FR'))).toBe(false);
    expect(doesNotShipToMe({ category: 'animation', metadata: {} }, on('FR'))).toBe(false);
    expect(doesNotShipToMe({ category: 'furniture', metadata: { digitalGoodDisclaimer: 'x', domesticOnly: true } }, on('FR'))).toBe(false);
  });
});
