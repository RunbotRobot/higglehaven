// #3775: which products the shopper has an order of that they have not rated yet. A product
// is rated once per order and only from an order (owner, 2026-11-18), so the product card
// offers "Rate this Product" only for these, never a control that can only refuse.
//
// Same shape as ownedProducts.js: the orders are read once (every page, bounded) the first
// time a card asks, kept for the page's life, and read again after a purchase or a rating.
// The server stays the authority: a rating without an eligible order is still refused there.
// A read that fails leaves the set as it was (nothing offered rather than something guessed).
import { fetchMyPurchases } from '../api.js';

const MAX_PAGES = 20;

let templateIds = new Set();
let loaded = false;
let loading = null;

export function loadUnratedOrders({ force = false } = {}) {
  if (loaded && !force) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const ids = new Set();
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await fetchMyPurchases({ cursor });
        for (const purchase of result.purchases ?? []) {
          if (purchase.canReviewProduct && purchase.templateId) ids.add(purchase.templateId);
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      templateIds = ids;
      loaded = true;
    })()
      .catch(() => {})
      .finally(() => { loading = null; });
  }
  return loading;
}

export function hasUnratedOrder(templateId) {
  return !!templateId && templateIds.has(templateId);
}

// My Purchases changed an order (a product rated, a rating removed, a refund): the set is read
// again the next time a card asks, not on every change.
if (typeof document !== 'undefined') {
  document.addEventListener('higglehaven:orders-changed', () => { loaded = false; });
}
