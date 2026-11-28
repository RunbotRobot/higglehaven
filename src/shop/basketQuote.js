// #4666 (Basket 8/8, slice 1, part of #4604): pure helpers for showing what the server quoted for a basket
// (GET /api/basket/quote, #4613), apart from the leaf so they test without a page. The server prices and judges
// every line; this only reads what it answered and says it plainly. Nothing here moves money.

// The sentence for a line whose status is not "ok", or null for an ok line. `money` formats cents (the leaf passes
// formatPriceCents). A status this build does not know says the server's own message, never nothing.
export function statusSentence(line, money) {
  switch (line.status) {
    case 'ok': return null;
    case 'price_changed': return `The price changed: now ${money(line.unitPriceCents)}.`;
    case 'sold_out': return 'Sold out.';
    case 'seller_not_selling': return 'This seller is not selling right now.';
    case 'not_for_sale': return 'Not for sale right now.';
    case 'seller_not_ready': return 'This seller cannot take payments yet.';
    case 'already_owned': return 'You already own this.';
    case 'item_gone': return 'No longer on a lándlet.';
    default: return line.message || "This can't be bought right now.";
  }
}

// The quote's lines by the item they belong to.
export function quoteLinesByInstance(quote) {
  const byInstance = new Map();
  for (const line of quote?.lines || []) byInstance.set(line.instanceId, line);
  return byInstance;
}

// What the person last saw, for `?expected=`: every ok line's unit price from the previous quote, up to the 20 the
// route accepts. A price_changed line is deliberately not remembered, so it stays flagged until the person accepts it.
export function expectedPrices(quote, accepted = new Map()) {
  const seen = new Map(accepted);
  for (const line of quote?.lines || []) {
    if (line.status === 'ok' && Number.isInteger(line.unitPriceCents)) seen.set(line.instanceId, line.unitPriceCents);
  }
  return [...seen].slice(0, 20);
}

// One seller's figures from the quote, or null when the quote has none for that seller (every line refused).
export function sellerTotals(quote, sellerId) {
  return (quote?.sellers || []).find((seller) => (seller.sellerId ?? '') === (sellerId ?? '')) || null;
}
