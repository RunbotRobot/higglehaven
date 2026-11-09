import { describe, expect, it } from 'vitest';
import { isErrorLine } from './copyableErrorRule.js';

describe('isErrorLine (#3303/#3348)', () => {
  it('counts as an error: text on an error line', () => {
    expect(isErrorLine({ text: 'Wrong email or password.', hasErrorClass: true, role: 'status' })).toBe(true);
  });
  it('counts as an error: any text on a role=alert line', () => {
    expect(isErrorLine({ text: 'Could not delete this product.', hasErrorClass: false, role: 'alert' })).toBe(true);
  });
  it('is not an error: an empty line or a plain progress note', () => {
    expect(isErrorLine({ text: '   ', hasErrorClass: true, role: 'alert' })).toBe(false);
    expect(isErrorLine({ text: '', hasErrorClass: true, role: 'status' })).toBe(false);
    expect(isErrorLine({ text: 'Uploading…', hasErrorClass: false, role: 'status' })).toBe(false);
    expect(isErrorLine({ text: undefined, hasErrorClass: false, role: 'alert' })).toBe(false);
  });
});
