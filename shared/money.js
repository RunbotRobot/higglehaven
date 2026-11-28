// #4681: the one formatter for an amount of money a person reads, given in whole cents (higgles and real prices are both
// cents, so one function serves both). It used to be written out five times (src/main.js twice, myPurchases.js,
// worker/index.js, the email layout) and six admin pages did it by hand with toFixed, which printed "$1234.56" and
// "$-24.00" where everything else printed "$1,234.56" and "-$24.00". Anything that turns cents into text calls this;
// src/money.test.js fails if a second copy appears. public/admin-money.js is the same function for the admin pages, which are
// plain scripts that cannot import a module, and the same test pins it to this one.
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatCents(cents) {
  return USD.format(cents / 100);
}
