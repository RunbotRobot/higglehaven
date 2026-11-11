// #3463: one reviews request per product, shared by every placement of it.
// A landlet with hundreds of identical items (an 829-brick wall) used to fire
// one identical GET /catalog/:id/reviews per item as it entered the world; the
// browser ran out of connections for most of them (307 failures in one short
// look at the live site) and each was a Worker call and a D1 read on the free
// tier. Now the first placement starts the request and the rest wait on the
// same promise.
//
// - A settled answer is reused for REVIEW_CACHE_TTL_MS, so landlets that load
//   and unload as the avatar moves do not refetch the same product each time.
// - A shopper's own post, edit or delete calls invalidate(), so the next
//   placement to load sees the change.
// - A failure is remembered only for REVIEW_FAILURE_BACKOFF_MS (every waiting
//   placement sees it, none retries at once), then the next placement tries
//   again: a failing product cannot become a request loop, and does not stay
//   broken either.
//
// Dependency-free, with the fetch and the clock passed in, so it runs in the
// plain vitest pool.

export const REVIEW_CACHE_TTL_MS = 60_000;
export const REVIEW_FAILURE_BACKOFF_MS = 5_000;

export function createReviewCache({ fetchReviews, now = () => Date.now() }) {
  const entries = new Map(); // templateId -> { promise, expiresAt }
  let requests = 0;

  function get(templateId) {
    const current = entries.get(templateId);
    if (current && now() < current.expiresAt) return current.promise;
    requests += 1;
    const entry = { promise: null, expiresAt: Infinity }; // Infinity: in flight
    entry.promise = Promise.resolve()
      .then(() => fetchReviews(templateId))
      .then(
        (value) => {
          if (entries.get(templateId) === entry) entry.expiresAt = now() + REVIEW_CACHE_TTL_MS;
          return value;
        },
        (error) => {
          if (entries.get(templateId) === entry) entry.expiresAt = now() + REVIEW_FAILURE_BACKOFF_MS;
          throw error;
        },
      );
    entries.set(templateId, entry);
    return entry.promise;
  }

  // The next get() for this product asks the server again.
  function invalidate(templateId) {
    entries.delete(templateId);
  }

  function clear() {
    entries.clear();
  }

  return { get, invalidate, clear, requestCount: () => requests };
}
