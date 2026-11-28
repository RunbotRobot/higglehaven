// #4651: the sentence a seller reads on a disputed order.
import { describe, expect, it } from 'vitest';
import { disputeReasonWords, disputeSentence } from './saleDispute.js';

const open = { reason: 'product_not_received', outcome: 'open', evidenceDueBy: '2026-12-03T12:00:00.000Z', evidenceSent: false };
const NOW = new Date('2026-11-30T00:00:00Z');

describe('disputeSentence (#4651)', () => {
  it('says the reason in words and when evidence is due', () => {
    expect(disputeSentence(open, { now: NOW })).toBe("Disputed: the buyer's bank says the item was not received. Evidence is due Dec 3, 2026.");
  });

  it('points a seller with no tracking at the box on the row, only while evidence can still go', () => {
    expect(disputeSentence(open, { now: NOW, canAddTracking: true })).toContain('Add the carrier and tracking number below');
    expect(disputeSentence({ ...open, evidenceSent: true }, { now: NOW, canAddTracking: true })).toBe("Disputed: the buyer's bank says the item was not received. Evidence was sent.");
    expect(disputeSentence(open, { now: new Date('2026-12-05T00:00:00Z'), canAddTracking: true })).not.toContain('Add the carrier');
  });

  it('says when the evidence period is over without claiming a loss', () => {
    const late = disputeSentence(open, { now: new Date('2026-12-05T00:00:00Z') });
    expect(late).toContain('The evidence period is over; the bank decides.');
    expect(late).not.toMatch(/lost/i);
  });

  it('says a won dispute counts toward earnings again', () => {
    expect(disputeSentence({ ...open, outcome: 'won' }, { now: NOW })).toBe("Disputed: the buyer's bank says the item was not received. Won: the money counts toward your earnings again.");
  });

  it('has plain words for every reason, a general one for anything else, and is empty with no dispute', () => {
    for (const reason of ['product_not_received', 'fraudulent', 'unrecognized', 'duplicate', 'product_unacceptable', 'credit_not_processed']) {
      expect(disputeReasonWords(reason)).not.toBe(disputeReasonWords('something_new'));
    }
    expect(disputeReasonWords('something_new')).toBe("the buyer's bank opened a dispute");
    expect(disputeReasonWords(null)).toBe("the buyer's bank opened a dispute");
    expect(disputeSentence(null)).toBe('');
  });

  it('copes with no due date', () => {
    expect(disputeSentence({ ...open, evidenceDueBy: null }, { now: NOW })).toBe("Disputed: the buyer's bank says the item was not received.");
  });
});
