// #4681: one formatter for money a person reads. The awkward values, the admin pages' copy kept identical to it, and the
// worker's and the email's entry points reading the same. (That nobody writes a second copy is scripts/check-money-formatter.mjs,
// a pretest step.) A sale row once showed $0.24 on a $24.00 sale because one place divided by 100 twice.
import { describe, expect, it } from 'vitest';
import adminMoneySource from '../public/admin-money.js?raw';
import { formatCents } from '../shared/money.js';
import { formatCents as workerFormatCents } from '../worker/index.js';
import { basketReceiptMessage } from '../worker/lib/email-layout.js';

// [cents, what a person reads]
const AWKWARD = [
  [0, '$0.00'], // a free product
  [5, '$0.05'],
  [99, '$0.99'],
  [100, '$1.00'],
  [2400, '$24.00'], // the amount that once read $0.24
  [123456, '$1,234.56'],
  [2000000, '$20,000.00'],
  [-2400, '-$24.00'], // a refund shown as a negative
  [0.5, '$0.01'], // a half-cent share rounds the way every page rounds it
];

describe('formatCents (#4681)', () => {
  it.each(AWKWARD)('%s cents reads %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('reads the same through the worker and the email', () => {
    for (const [cents, text] of AWKWARD) expect(workerFormatCents(cents), `${cents}`).toBe(text);
    const mail = basketReceiptMessage([{ sellerName: 'Shop', lines: [{ name: 'Thing', quantity: 1, totalCents: 123456 }] }], 123456);
    expect(mail.text).toContain('$1,234.56');
  });

  it("reads the same in the admin pages' copy (public/admin-money.js)", () => {
    const window = {};
    new Function('window', adminMoneySource)(window);
    expect(typeof window.hhFormatCents).toBe('function');
    for (const [cents, text] of AWKWARD) expect(window.hhFormatCents(cents), `${cents}`).toBe(text);
  });
});
