import { describe, expect, it } from 'vitest';
import {
  disputeErrorText, disputeSuccessText, purchaseAfterDispute, DISPUTE_PROMPT_TEXT,
} from './disputeOutcome.js';

// #3199: wording and row update for the buyer's "Report a problem" action.
describe('dispute outcomes (#3199)', () => {
  it('says the refund was issued when the dispute auto-resolved', () => {
    expect(disputeSuccessText({ autoResolved: true })).toBe('Your refund has been issued.');
  });

  it('does not promise a review when it was not auto-resolved, and never states the rule', () => {
    const text = disputeSuccessText({ autoResolved: false });
    expect(text).toContain('contact the seller or support');
    expect(text.toLowerCase()).not.toMatch(/established|threshold|\$|new account|policy/);
  });

  it('maps a 409 (already paid out) to a contact-support message and otherwise shows the server wording', () => {
    expect(disputeErrorText({ status: 409, message: 'raw' })).toContain('contact support');
    expect(disputeErrorText({ status: 400, message: 'This purchase has already been refunded' }))
      .toBe('This purchase has already been refunded');
    expect(disputeErrorText({})).toMatch(/try again/);
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
});
