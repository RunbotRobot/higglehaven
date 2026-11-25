// #4368: a price is typed in dollars and kept in cents, so a fraction of a cent ("12.999") cannot be kept. It used to be
// rounded without a word (and 1.005 became 100 cents through float error). Callers refuse it where the field is.
export const FRACTION_OF_A_CENT_MESSAGE = 'Prices go to the cent, like 12.99.';

// True when the text has digits past the second decimal place that are not all zeros ("1.500" is fine).
export function hasFractionOfACent(raw) {
  const cleaned = String(raw ?? '').trim().replace(/[$,]/g, '');
  const match = /^[+-]?\d*\.(\d+)$/.exec(cleaned);
  return Boolean(match && /[1-9]/.test(match[1].slice(2)));
}
