import { describe, expect, it } from 'vitest';
import { cardNotAcceptedMessage, CARD_ALREADY_USED_MESSAGE } from './lib/card-refusal.js';

// #3565: the card step's server-side refusals name what was seen, give the
// reason, say nothing was charged, and point at the ID route.
describe('card refusal copy', () => {
  it.each([
    ['prepaid', /^That is a prepaid card\./],
    ['debit', /^That is a debit card\./],
    ['unknown', /^That card is not a credit card we can recognise\./],
    [null, /^That card is not a credit card we can recognise\./],
  ])('says what it saw for %s', (funding, lead) => {
    const text = cardNotAcceptedMessage(funding);
    expect(text).toMatch(lead);
    expect(text).toContain('under 18');
    expect(text).toContain('Nothing was charged.');
    expect(text).toContain('government ID');
  });
  it('carries no internals', () => {
    for (const text of [cardNotAcceptedMessage('prepaid'), CARD_ALREADY_USED_MESSAGE]) {
      expect(text).not.toMatch(/#\d|docs\/|API|stripe|funding|fingerprint/i);
    }
  });
  it('the already-used refusal also says nothing was charged and names the ID route', () => {
    expect(CARD_ALREADY_USED_MESSAGE).toContain('already been used to verify a different account');
    expect(CARD_ALREADY_USED_MESSAGE).toContain('Nothing was charged.');
    expect(CARD_ALREADY_USED_MESSAGE).toContain('government ID');
  });
});
