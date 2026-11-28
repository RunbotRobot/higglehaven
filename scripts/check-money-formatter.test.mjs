import { describe, expect, it } from 'vitest';
import { findHandFormattedMoney } from './check-money-formatter.mjs';

// #4681: only the pure part is tested here (same split as check-no-inline-blocks.test.mjs); main() reads the real repository
// files and is exercised by `pretest` itself.
const currency = "x.toLocaleString('en-US', { style: 'currency', currency: 'USD' })";

describe('findHandFormattedMoney (#4681)', () => {
  it('passes the formatter itself, its admin copy, and the one price-field use in src/main.js', () => {
    expect(findHandFormattedMoney([
      { path: 'shared/money.js', text: currency },
      { path: 'public/admin-money.js', text: currency },
      { path: 'src/main.js', text: currency },
    ])).toEqual([]);
  });

  it('flags a second currency format in src/main.js and any in another file', () => {
    const found = findHandFormattedMoney([
      { path: 'src/main.js', text: `${currency}\n${currency}` },
      { path: 'src/account/myPurchases.js', text: currency },
      { path: 'worker/lib/email-layout.js', text: currency },
    ]);
    expect(found.map((f) => f.path)).toEqual(['src/main.js', 'src/account/myPurchases.js', 'worker/lib/email-layout.js']);
  });

  it('flags an admin page that divides by 100 and prints with toFixed, in either bracket style', () => {
    const found = findHandFormattedMoney([
      { path: 'public/admin-dashboard-3.js', text: "return '$' + (cents / 100).toFixed(2);" },
      { path: 'public/admin-dashboard-4.js', text: '<td>${(f.totalCents / 100).toFixed(2)}</td>' },
      { path: 'public/admin-dashboard-5.js', text: 'window.hhFormatCents(cents)' },
    ]);
    expect(found.map((f) => f.path)).toEqual(['public/admin-dashboard-3.js', 'public/admin-dashboard-4.js']);
  });

  it('leaves a meters-to-text toFixed alone outside the admin pages', () => {
    expect(findHandFormattedMoney([{ path: 'src/settings.js', text: 'return (meters / 100).toFixed(2);' }])).toEqual([]);
  });
});
