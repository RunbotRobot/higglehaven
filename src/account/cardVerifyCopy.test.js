import { describe, expect, it } from 'vitest';
import { describeCardRefusal, VERIFY_INTRO, VERIFY_INTRO_PROOF_ONLY, CARD_STEP_INTRO, ID_INSTEAD_LABEL } from './cardVerifyCopy.js';

// #3565: a refusal is never Stripe's sentence alone.
describe('describeCardRefusal', () => {
  it('rewrites a bank decline in our own words, naming the likely cause', () => {
    const text = describeCardRefusal({ type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' });
    expect(text).toContain('declined');
    expect(text).toContain('Prepaid');
    expect(text).toContain('under 18');
    expect(text).not.toContain('Your card was declined.');
  });
  it('maps the usual field mistakes to a plain sentence', () => {
    expect(describeCardRefusal({ code: 'expired_card' })).toMatch(/^That card has expired\./);
    expect(describeCardRefusal({ code: 'incorrect_cvc' })).toMatch(/^That security code does not look right\./);
    expect(describeCardRefusal({ code: 'incomplete_number' })).toMatch(/^That card number is not complete\./);
  });
  it('falls back to a general sentence, never the raw one', () => {
    const text = describeCardRefusal({ type: 'api_error', message: 'Something raw from the provider' });
    expect(text).toMatch(/^The card couldn't be verified\./);
    expect(text).not.toContain('raw');
    expect(describeCardRefusal(undefined)).toMatch(/^The card couldn't be verified\./);
  });
  it('every refusal ends by saying nothing was charged and naming the ID route', () => {
    for (const error of [{ code: 'expired_card' }, { code: 'card_declined' }, {}, null]) {
      const text = describeCardRefusal(error);
      expect(text).toContain('Nothing was charged.');
      expect(text).toContain('government ID');
    }
  });
  it('the copy carries no internals', () => {
    for (const text of [describeCardRefusal({ code: 'card_declined' }), VERIFY_INTRO, VERIFY_INTRO_PROOF_ONLY, CARD_STEP_INTRO, ID_INSTEAD_LABEL]) {
      expect(text).not.toMatch(/#\d|docs\/|API|stripe|SetupIntent|funding/i);
    }
  });
  it('the intro gives the reason for the rule', () => {
    expect(CARD_STEP_INTRO).toContain('only issued to adults');
    expect(VERIFY_INTRO).toContain('never charged');
    expect(VERIFY_INTRO_PROOF_ONLY).toContain('never charged');
  });
  it('the intro for an account that already gave its age speaks only of the proof (#3734)', () => {
    expect(VERIFY_INTRO).toContain('confirming you are 18');
    expect(VERIFY_INTRO_PROOF_ONLY).not.toMatch(/confirming|two things/i);
    expect(VERIFY_INTRO_PROOF_ONLY).toContain('18 or older');
  });
});
