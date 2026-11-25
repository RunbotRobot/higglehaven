import { describe, it, expect } from 'vitest';
import { plainPayoutMessage, firstBlankFieldMessage } from './payoutFormText.js';

describe('payout form text (#4339)', () => {
  it('names the form label, not the API field', () => {
    expect(plainPayoutMessage('individual.ssnLast4 must be exactly 4 digits')).toBe('SSN (last 4 digits) must be exactly 4 digits');
    expect(plainPayoutMessage('individual.dobDay must be between 1 and 30')).toBe('Birth day must be between 1 and 30');
    expect(plainPayoutMessage('externalAccount.routingNumber is required')).toBe('Bank routing number is required');
    expect(plainPayoutMessage('taxIdNumber must be 9 digits (an SSN or EIN), optionally dash-formatted')).toBe('SSN or EIN must be 9 digits (an SSN or EIN), optionally dash-formatted');
  });
  it('does not read individual.addressLine1 as the bare name, and leaves other text alone', () => {
    expect(plainPayoutMessage('individual.addressLine1 is required')).toBe('Street address is required');
    expect(plainPayoutMessage('Something else went wrong')).toBe('Something else went wrong');
  });
  it('asks for the first blank field in order', () => {
    const specs = [['a', 'First name'], ['b', 'Last name']];
    expect(firstBlankFieldMessage(specs, { a: 'x', b: ' ' })).toBe('Last name is required.');
    expect(firstBlankFieldMessage(specs, { a: 'x', b: 'y' })).toBeNull();
  });
});
