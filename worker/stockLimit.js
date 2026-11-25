// #4343: how much stock a listing may state, from one place. The Worker's catalog routes and the Sell screens both read
// it, so the limit a person is told about is the one the server enforces. Pure (no imports), like earthCurvature.js, so
// the client can import it.
//
// A count of physical units, not money or bytes, so it is bounded generously (#1948).
export const MAX_STOCK_QUANTITY = 1_000_000;

// What a person is told when a stock value is refused. Names the limit (it comes from MAX_STOCK_QUANTITY, never a second
// copy) and what blank means where blank is allowed.
export function stockLimitMessage({ blankMeansNoLimit = false } = {}) {
  const limit = MAX_STOCK_QUANTITY.toLocaleString('en-US');
  return blankMeansNoLimit
    ? `Stock must be a whole number from 0 to ${limit}, or left blank for no limit.`
    : `Stock must be a whole number from 0 to ${limit}, or left blank.`;
}

// True when `number` is a stock count the server accepts.
export function isValidStockQuantity(number) {
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_STOCK_QUANTITY;
}

// Reads what a person typed into a stock field. Blank is "no limit" (quantity null). Returns { quantity } or { error }.
export function parseStockInput(text, options) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { quantity: null };
  const number = Number(trimmed);
  if (!isValidStockQuantity(number)) return { error: stockLimitMessage(options) };
  return { quantity: number };
}
