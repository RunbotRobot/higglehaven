// #4612: pure helpers for the Basket leaf (src/shop/basketLeaf.js), apart from it so they test without a page.

const UNKNOWN_SELLER = 'Unknown seller';

// Lines grouped by seller, in the order each seller's first line was added. A line whose seller is gone is grouped
// under one plain heading, never dropped.
export function groupBasketLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.sellerId ?? '';
    if (!groups.has(key)) groups.set(key, { sellerName: line.sellerName || UNKNOWN_SELLER, lines: [] });
    groups.get(key).lines.push(line);
  }
  return [...groups.values()];
}

