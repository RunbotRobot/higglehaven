// #1954: player-facing copy for the server's stable error codes.
//
// The Worker attaches a `code` (worker/lib/http.js's ERROR_CODES) to errors
// whose English `message` is written for logs and developers ("Landlet changed
// concurrently — refetch and retry"). src/api.js shows this copy instead of
// that message, so a raw server string never reaches a player through the many
// `err.message || '...'` fallbacks in the UI. An error with no code keeps its
// own message, which is right for the validation and auth messages that are
// already written for players. These strings are customer-facing, so they use
// the accented spelling; a test requires an entry here for every server code.
export const PLAYER_ERROR_COPY = Object.freeze({
  internal_error: 'Something went wrong on our end. Try again in a moment.',
  changed_concurrently: 'That changed while you were working on it. Try again.',
  landlet_not_found: "That lándlet couldn't be found. It may have been removed.",
  landlet_not_claimable: "That lándlet isn't available to claim any more. Pick another one.",
  landlet_ownership_lost: "You don't own this lándlet any more. Reload to see its current state.",
  auction_already_active: 'This lándlet already has an auction running.',
  auction_not_owner: 'Only the current owner of a claimed lándlet can start an auction on it.',
  service_unavailable: "That isn't available right now. Try again later.",
  upstream_failed: "That didn't go through on our side. Try again in a moment.",
  unreadable_request: "That didn't go through. Reload and try again.",
  stale_reference: 'Something you were working with was removed or changed. Reload and try again.',
  seller_suspended: "That product isn't available right now.",
  // #3372: the Build client stops a move at the top and bottom level, so this
  // only shows for stale level data or a second tab; the items are put back.
  out_of_level_range: "That's beyond the top or bottom level of this lándlet.",
  // #4198: Build stops a move at the lándlet's outline, so this only shows for stale lándlet data or a second tab.
  outside_landlet_outline: "That's past the edge of this lándlet.",
  // #3948: refused before any card is charged, so each says so and what to do next.
  sold_out: 'That sold out before you could buy it. You were not charged.',
  not_for_sale: "That product isn't for sale right now. You were not charged. Try another product.",
  // #4289: finalising a purchase before the card payment succeeded; the wording says whether the card was charged.
  payment_incomplete: "Your payment didn't go through. You were not charged. Try again, or use another card.",
  payment_processing: 'Your payment is still being confirmed. This can take a moment. Check My purchases before paying again.',
});

// The player-facing text for a server error: the mapped copy for a known code,
// otherwise `fallback` (the server's own message, or a generic line).
export function playerErrorMessage(code, fallback) {
  return (code && Object.hasOwn(PLAYER_ERROR_COPY, code) && PLAYER_ERROR_COPY[code]) || fallback;
}
