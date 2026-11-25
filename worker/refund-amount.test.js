// #4340: the figure a seller is shown for a refund is the figure Stripe is sent.
import { describe, expect, it } from 'vitest';
import { refundAmountCents } from './lib/purchase-record.js';
import { purchaseFromRow } from './lib/purchase-creation.js';

describe('refund amount (#4340)', () => {
  it('is 99% of the total, rounded to a cent', () => {
    expect(refundAmountCents(2000)).toBe(1980);
    expect(refundAmountCents(1)).toBe(1);
    expect(refundAmountCents(1250)).toBe(1238);
  });
  it('is on the order for a card payment and null for one with no card', () => {
    const base = { purchase_id: 'p', total_cents: 2000 };
    expect(purchaseFromRow({ ...base, payment_intent_id: 'pi_1' }).refundCents).toBe(1980);
    expect(purchaseFromRow({ ...base, payment_intent_id: null }).refundCents).toBeNull();
  });
});
