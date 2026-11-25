import { describe, expect, it } from 'vitest';
import { MAX_STOCK_QUANTITY, STOCK_FIELD_HINT, parseStockInput } from '../../shared/stock-limits.js';

describe('the stock a seller may type (#4343)', () => {
  it('reads blank as no limit and a whole number from 0 up to the cap as that number', () => {
    expect(parseStockInput('')).toBeNull();
    expect(parseStockInput('   ')).toBeNull();
    expect(parseStockInput(undefined)).toBeNull();
    expect(parseStockInput('0')).toBe(0);
    expect(parseStockInput(' 25 ')).toBe(25);
    expect(parseStockInput(String(MAX_STOCK_QUANTITY))).toBe(MAX_STOCK_QUANTITY);
  });
  it('refuses what the server refuses: above the cap, negative, fractional, not a number', () => {
    expect(parseStockInput(String(MAX_STOCK_QUANTITY + 1))).toBeUndefined();
    expect(parseStockInput('-1')).toBeUndefined();
    expect(parseStockInput('2.5')).toBeUndefined();
    expect(parseStockInput('lots')).toBeUndefined();
    expect(parseStockInput('1e21')).toBeUndefined();
  });
  it('says the cap in the words a person reads', () => {
    expect(STOCK_FIELD_HINT).toBe('Stock must be a whole number from 0 to 1,000,000, or left blank for no limit.');
  });
});
