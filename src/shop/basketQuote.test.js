import { describe, expect, it } from 'vitest';
import { statusSentence, quoteLinesByInstance, expectedPrices, sellerTotals } from './basketQuote.js';

// #4666
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

describe('statusSentence', () => {
  it('says nothing for an ok line and a plain sentence for each refusal', () => {
    expect(statusSentence({ status: 'ok' }, money)).toBeNull();
    expect(statusSentence({ status: 'sold_out' }, money)).toBe('Sold out.');
    expect(statusSentence({ status: 'seller_not_selling' }, money)).toBe('This seller is not selling right now.');
    expect(statusSentence({ status: 'already_owned' }, money)).toBe('You already own this.');
    expect(statusSentence({ status: 'item_gone' }, money)).toBe('No longer on a lándlet.');
  });

  it('names the new price on a price change', () => {
    expect(statusSentence({ status: 'price_changed', unitPriceCents: 1250 }, money)).toBe('The price changed: now $12.50.');
  });

  it("uses the server's message for a status it does not know, never nothing", () => {
    expect(statusSentence({ status: 'future_status', message: 'Because.' }, money)).toBe('Because.');
    expect(statusSentence({ status: 'cannot_buy' }, money)).toBe("This can't be bought right now.");
  });
});

describe('expectedPrices', () => {
  const quote = { lines: [
    { instanceId: 'a', status: 'ok', unitPriceCents: 500 },
    { instanceId: 'b', status: 'price_changed', unitPriceCents: 900 },
    { instanceId: 'c', status: 'sold_out' },
  ] };

  it('remembers ok lines only, so a changed price stays flagged until accepted', () => {
    expect(expectedPrices(quote)).toEqual([['a', 500]]);
  });

  it('adds what the person accepted, and stops at the twenty the route takes', () => {
    expect(expectedPrices(quote, new Map([['b', 900]]))).toEqual([['b', 900], ['a', 500]]);
    const many = { lines: Array.from({ length: 30 }, (_, i) => ({ instanceId: `i${i}`, status: 'ok', unitPriceCents: 100 })) };
    expect(expectedPrices(many)).toHaveLength(20);
  });
});

describe('quote lookups', () => {
  it('finds a line and a seller by their ids', () => {
    const quote = { lines: [{ instanceId: 'a' }], sellers: [{ sellerId: 's1', goodsCents: 500 }] };
    expect(quoteLinesByInstance(quote).get('a')).toEqual({ instanceId: 'a' });
    expect(sellerTotals(quote, 's1').goodsCents).toBe(500);
    expect(sellerTotals(quote, 's2')).toBeNull();
    expect(sellerTotals(null, 's1')).toBeNull();
  });
});
