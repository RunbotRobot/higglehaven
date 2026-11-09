import { describe, expect, it } from 'vitest';
import { shouldOfferCopy } from './copyableErrorRule.js';

describe('shouldOfferCopy (#3303)', () => {
  it('offers Copy for text on an error line', () => {
    expect(shouldOfferCopy({ text: 'Wrong email or password.', hasErrorClass: true, role: 'status' })).toBe(true);
  });
  it('offers Copy for any text on a role=alert line', () => {
    expect(shouldOfferCopy({ text: 'Could not delete this product.', hasErrorClass: false, role: 'alert' })).toBe(true);
  });
  it('does not offer Copy for an empty line or a plain progress note', () => {
    expect(shouldOfferCopy({ text: '   ', hasErrorClass: true, role: 'alert' })).toBe(false);
    expect(shouldOfferCopy({ text: '', hasErrorClass: true, role: 'status' })).toBe(false);
    expect(shouldOfferCopy({ text: 'Uploading…', hasErrorClass: false, role: 'status' })).toBe(false);
    expect(shouldOfferCopy({ text: undefined, hasErrorClass: false, role: 'alert' })).toBe(false);
  });
});
