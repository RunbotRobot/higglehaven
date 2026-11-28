// #4681: the admin pages' copy of shared/money.js's formatCents (they are plain scripts and cannot import it). Loaded before
// the dashboard's own scripts; src/money.test.js runs both over the same awkward values and fails if they ever differ.
window.hhFormatCents = (function () {
  const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  return function formatCents(cents) {
    return USD.format(cents / 100);
  };
})();
