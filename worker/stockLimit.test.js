import { describe, it, expect } from 'vitest';
import { MAX_STOCK_QUANTITY, isValidStockQuantity, parseStockInput, stockLimitMessage } from './stockLimit.js';

describe('stock limit (#4343)', () => {
  it('accepts 0 up to the limit and nothing outside it', () => {
    expect(isValidStockQuantity(0)).toBe(true);
    expect(isValidStockQuantity(MAX_STOCK_QUANTITY)).toBe(true);
    expect(isValidStockQuantity(MAX_STOCK_QUANTITY + 1)).toBe(false);
    expect(isValidStockQuantity(-1)).toBe(false);
    expect(isValidStockQuantity(1.5)).toBe(false);
    expect(isValidStockQuantity(Number.NaN)).toBe(false);
  });

  it('reads a typed value: blank is no limit, a number in range is itself, anything else says the limit', () => {
    expect(parseStockInput('')).toEqual({ quantity: null });
    expect(parseStockInput('  ')).toEqual({ quantity: null });
    expect(parseStockInput(' 25 ')).toEqual({ quantity: 25 });
    expect(parseStockInput(String(MAX_STOCK_QUANTITY))).toEqual({ quantity: MAX_STOCK_QUANTITY });
    for (const bad of ['1000001', '-3', '2.5', 'many', '1e9']) {
      const result = parseStockInput(bad, { blankMeansNoLimit: true });
      expect(result.error).toContain('1,000,000');
      expect(result.error).toContain('no limit');
    }
  });

  it('the message is built from the one constant', () => {
    expect(stockLimitMessage()).toContain(MAX_STOCK_QUANTITY.toLocaleString('en-US'));
  });
});
