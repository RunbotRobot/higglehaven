import { describe, expect, it } from 'vitest';
import { sellerKeepsCents } from './saleEarnings.js';

// #4585
describe('sellerKeepsCents', () => {
  const card = { refundCents: 2376, totalCents: 2400, commissionCents: 48, builderShareCents: 24, refundedAmountCents: 0 };

  it('is the total minus the commission for a card sale, not the host commission', () => {
    expect(sellerKeepsCents(card)).toBe(2352);
    expect(sellerKeepsCents(card)).not.toBe(card.builderShareCents);
  });

  it('shrinks with a partial refund, as the payout does', () => {
    expect(sellerKeepsCents({ ...card, refundedAmountCents: 1200 })).toBe(1176);
  });

  it('is null for a sale with no card payment', () => {
    expect(sellerKeepsCents({ ...card, refundCents: null })).toBeNull();
  });

  it('never goes below zero and handles a free sale', () => {
    expect(sellerKeepsCents({ ...card, totalCents: 0, commissionCents: 0, refundCents: 0 })).toBe(0);
    expect(sellerKeepsCents({ ...card, commissionCents: 9999 })).toBe(0);
  });
});
