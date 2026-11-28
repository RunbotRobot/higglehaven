import { describe, expect, it } from 'vitest';
import { purchaseTrackingText, basketHeadText } from './myPurchases.js';

describe('purchaseTrackingText (#4600)', () => {
  const shipped = { shippedAt: '2026-11-27T00:00:00.000Z', refundedAt: null };
  it('says the carrier and the tracking number a shipped order has', () => {
    expect(purchaseTrackingText({ ...shipped, shippingCarrier: 'Royal Mail', trackingNumber: 'RM1' })).toBe('Royal Mail · Tracking RM1');
    expect(purchaseTrackingText({ ...shipped, shippingCarrier: 'Royal Mail', trackingNumber: null })).toBe('Royal Mail');
    expect(purchaseTrackingText({ ...shipped, shippingCarrier: null, trackingNumber: 'RM1' })).toBe('Tracking RM1');
  });
  it('says nothing for an order not shipped, refunded, or shipped without details', () => {
    expect(purchaseTrackingText({ shippedAt: null, shippingCarrier: 'Post', trackingNumber: '1' })).toBe('');
    expect(purchaseTrackingText({ ...shipped, refundedAt: 'x', shippingCarrier: 'Post', trackingNumber: '1' })).toBe('');
    expect(purchaseTrackingText({ ...shipped, shippingCarrier: null, trackingNumber: null })).toBe('');
  });
});

describe('basketHeadText (#4617)', () => {
  it('counts the lines and adds up what was paid', () => {
    expect(basketHeadText([{ totalCents: 1250 }, { totalCents: 3000 }])).toBe('One order · 2 products · $42.50');
    expect(basketHeadText([{ totalCents: 500 }])).toBe('One order · 1 product · $5.00');
  });
});
