// #2538 fix: LANDLET_RELEASED_VIA_AUCTION_SQL and LAND_CAP_DISPLAY_ROUNDING_
// BUFFER_M2 both used to live as `export const`s directly in worker/index.js
// so that worker/lib/auctions.js could import them back (the same shared-
// state pattern worker/lib/reputation.js's own header documents for
// requireSessionSeller). That broke `wrangler dev` outright: wrangler
// builds its local `entrypointNames` from *every* named export of the main
// module (worker/index.js, wrangler.jsonc's "main"), not just `default`,
// treating each one as a potential named Worker entrypoint for service
// bindings -- and workerd then validates each of those against "function or
// ExportedHandler". A plain string/number constant fails that check and
// crashes the whole dev server at startup with "Incorrect type for map
// entry '<name>': the provided value is not of type 'function or
// ExportedHandler'" -- reproduced locally (`npx wrangler dev`) with exactly
// that error, naming each of these two constants in turn once the other was
// moved out of the way. Every *other* symbol worker/index.js exports for
// cross-import is a function, which satisfies that check fine; these two
// were the only plain-value exceptions, so moving them to their own module
// (never wrangler.jsonc's "main", so never scanned for entrypoints) fixes
// it without changing which files can read them.
export const LANDLET_RELEASED_VIA_AUCTION_SQL = `EXISTS (
  SELECT 1 FROM auctions
  WHERE auctions.landlet_id = owned.landlet_id AND auctions.status = 'active'
    AND (auctions.starting_bid_cents = 0 OR EXISTS (
      SELECT 1 FROM auction_bids WHERE auction_bids.auction_id = auctions.auction_id
    ))
)`;

// See the land-cap comment block in worker/index.js's own recomputeLandCap
// area -- a builder comparing two numbers the UI itself only ever shows
// rounded to the nearest whole m² shouldn't get a different answer than
// what those rounded numbers themselves imply.
export const LAND_CAP_DISPLAY_ROUNDING_BUFFER_M2 = 1;
