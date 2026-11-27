import { describe, expect, it } from 'vitest';
import {
  disputeErrorText, disputeSuccessText, purchaseAfterDispute, DISPUTE_PROMPT_TEXT, disputePromptText, isDigitalPurchase,
} from './disputeOutcome.js';

// #3199: wording and row update for the buyer's "Report a problem" action.
describe('dispute outcomes (#3199)', () => {
  it('says the refund was issued when the dispute auto-resolved', () => {
    expect(disputeSuccessText({ autoResolved: true })).toBe('Your refund has been issued.');
  });

  it('does not promise a review when it was not auto-resolved, and never states the rule', () => {
    const text = disputeSuccessText({ autoResolved: false });
    expect(text).toContain('Contact the seller or support');
    expect(text.toLowerCase()).not.toMatch(/established|threshold|\$|new account|policy/);
  });

  it('maps a 409 (already paid out) to a contact-support message and otherwise shows the server wording', () => {
    expect(disputeErrorText({ status: 409, message: 'raw' })).toContain('contact support');
    expect(disputeErrorText({ status: 400, message: 'This purchase has already been refunded' }))
      .toBe('This purchase has already been refunded');
    expect(disputeErrorText({})).toMatch(/try again/i);
  });

  it('turns the row into a refunded one after an auto-resolved dispute, using the server timestamps', () => {
    const before = {
      purchaseId: 'p1', totalCents: 1250, refundedAt: null, refundedAmountCents: null, canDispute: true, canLeaveFeedback: true,
    };
    const after = purchaseAfterDispute(before, {
      autoResolved: true, purchase: { refundedAt: '2026-03-03T00:00:00.000Z', refundedAmountCents: 1237 },
    });
    expect(after).toMatchObject({
      refundedAt: '2026-03-03T00:00:00.000Z', refundedAmountCents: 1237, canDispute: false, canLeaveFeedback: false,
    });
    expect(before.refundedAt).toBeNull(); // input is not mutated
  });

  it('keeps the order as it was but stops offering the button when the dispute did not auto-resolve', () => {
    const before = { purchaseId: 'p1', refundedAt: null, canDispute: true };
    expect(purchaseAfterDispute(before, { autoResolved: false })).toEqual({ purchaseId: 'p1', refundedAt: null, canDispute: false });
    expect(before.canDispute).toBe(true); // input is not mutated
  });

  it('exports the confirm prompt wording', () => {
    expect(DISPUTE_PROMPT_TEXT).toBe('Report a problem with this order?');
  });

  // #4573: the confirmation says a refund may follow at once, and that a digital item leaves what the buyer owns.
  it('tells the buyer a refund may follow at once, and that a digital item is then removed', () => {
    expect(disputePromptText({ isDigitalGood: false })).toBe("Report a problem with this order? If it can be refunded right away, you'll get your money back.");
    expect(disputePromptText({ isDigitalGood: true })).toContain('the item leaves what you own');
    // An avatar or an animation is digital whether or not the seller set the disclaimer flag.
    expect(isDigitalPurchase({ isDigitalGood: false, productKind: 'avatar' })).toBe(true);
    expect(isDigitalPurchase({ isDigitalGood: false, productKind: 'animation' })).toBe(true);
    expect(isDigitalPurchase({ isDigitalGood: false, productKind: 'furniture' })).toBe(false);
    expect(disputePromptText({ productKind: 'avatar' })).toContain('the item leaves what you own');
    expect(disputePromptText({ isDigitalGood: true })).not.toMatch(/threshold|established|policy/i);
  });
});
