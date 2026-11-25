// #4343: the one definition of how many units a seller may put in stock, read by the Worker (which refuses
// a larger count) and by Sell (which stops it where it is typed and says so), so the stock fields can never
// accept a number the server will then refuse. A count of physical units, not money or bytes (#1948).
export const MAX_STOCK_QUANTITY = 1_000_000;

// What a seller reads when the stock they typed is not allowed, the same wherever stock is typed.
export const STOCK_FIELD_HINT = `Stock must be a whole number from 0 to ${MAX_STOCK_QUANTITY.toLocaleString('en-US')}, or left blank for no limit.`;

// The stock typed in a field: null for blank (no limit), the count when it is allowed, undefined when it is not.
export function parseStockInput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_STOCK_QUANTITY) return undefined;
  return number;
}
