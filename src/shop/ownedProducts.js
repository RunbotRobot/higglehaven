// #3681 (follow-up to #3651, the bud's product card): which digital goods the
// shopper already owns, so a product's card can say so and not offer Buy again.
//
// What counts: the avatars and animations a shopper has bought. They are the
// digital goods that stay with their buyer for good (AGENTS.md, "A seller
// removing a digital good that buyers own delists it; the buyers keep what they
// bought"), so buying one twice is never what anyone wants. A physical product
// is a different question (someone can want a second one) and still allows Buy.
//
// How it knows without a request per tap: the owned lists are read once (every
// page, bounded) the first time a card asks, kept for the page's life, and read
// again after a purchase finishes. The server stays the authority: a purchase of
// something already owned is still refused there; this only changes what the card
// says. A read that fails leaves the set as it was (nothing owned is shown rather
// than something guessed), and the next card tries again.
import { fetchMyOwnedAvatars, fetchMyOwnedAnimations } from '../api.js';

// Pages read per list: a shopper with more than this many avatars or animations
// still gets the right answer for the first ones; it only bounds the work.
const MAX_PAGES = 20;

let ownedIds = new Set();
let loaded = false;
let loading = null;

async function readAllPages(fetchPage, key) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    for (const item of result[key] ?? []) if (item?.templateId) ids.push(item.templateId);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

// Resolves once the owned set is known (or the read failed). Never throws.
export function loadOwnedProducts({ force = false } = {}) {
  if (loaded && !force) return Promise.resolve();
  if (!loading) {
    loading = Promise.all([
      readAllPages(fetchMyOwnedAvatars, 'avatars'),
      readAllPages(fetchMyOwnedAnimations, 'animations'),
    ])
      .then(([avatars, animations]) => {
        ownedIds = new Set([...avatars, ...animations]);
        loaded = true;
      })
      .catch(() => {})
      .finally(() => { loading = null; });
  }
  return loading;
}

export function isOwnedProduct(templateId) {
  return !!templateId && ownedIds.has(templateId);
}
