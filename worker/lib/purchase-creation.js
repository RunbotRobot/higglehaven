// #2614 (leaf of #2540, itself sub-issue of #2502/#2500's worker/index.js
// module split): the instance-purchase creation/checkout path -- the
// simulated (dev-mode/no Stripe account) and real-money (Stripe
// PaymentIntent) ways a shopper "buys" a product placed on a landlet, plus
// every helper exclusively used by them. Extracted verbatim, zero behavior
// change.
//
// Deliberately NOT included here (stays with the sibling "purchase
// lifecycle actions" leaf, #2615, since none of it is reachable from this
// leaf's own functions): DISPUTE_AUTO_RESOLVE_THRESHOLD_CENTS/
// DISPUTE_RATE_LIMIT_MAX/CONFIRM_DELIVERY_RATE_LIMIT_MAX/REFUND_PAYOUT_RATE,
// handlePurchases (the /api/purchases dispatcher), handleMarkShipped,
// handlePurchaseConfirmDelivery, handlePurchaseRefund, handlePurchaseDispute,
// clawBackPurchaseCommission, finalizeRefundReversal, refundIdempotencyKey.
//
// Also NOT included (stays with the sibling "sold-out markers & self-
// dealing flag review" leaf, #2613, for the same reason): soldOutMarkerFromRow,
// SOLD_OUT_MARKER_DISMISS_RATE_LIMIT_MAX, handleSoldOutMarkers,
// SELF_DEALING_FLAG_REVIEW_RATE_LIMIT_MAX, handleSelfDealingFlags --
// physically interleaved with flagSelfDealingIfMatched/
// sweepSoldOutTemplateInstances in worker/index.js, but neither admin-facing
// review endpoint is called from (or needed by) anything that moved here.
//
// requireOwnedLandlet (worker/index.js, landlet-core domain, #2533) was
// audited for this move too, per #2614's own "needs back-imported" list --
// it turns out nothing in this file actually calls it (only
// handleSoldOutMarkers does, which stayed behind per the paragraph above),
// so it's left untouched rather than exported speculatively.
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue, labelValue, positiveInteger } from './validation.js';
import { requireVerifiedSession, sha256Hex } from './auth.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';
import { fireNotification } from './notifications.js';
import { isUserSuspended } from './account-moderation.js';
import {
  counterpartyKeyFor, commissionCapPlanFor, commissionCreditClaimStatement, commissionHoldInsertStatement,
  COMMISSION_HOLD_DURATION_DAYS,
} from './commission-caps.js';
import {
  stripeConfigured, stripeRequest, appBaseUrl, generateToken, sendEmail, escapeHtml, formatCents,
} from '../index.js';

// #1978: workerd requires every named export of the main Worker entry
// module (worker/index.js) to be a function/class binding, not a plain
// const -- confirmed the hard way, per worker/lib/builder-profile.js's own
// comment on its identical D1_MAX_BOUND_PARAMETERS duplication. Duplicated
// here rather than imported since it's an immutable platform limit, not
// application state.
const D1_MAX_BOUND_PARAMETERS = 100;

// Simulated purchases (docs/SPEC.md §5's "Universal commission formula,"
// migrations/0051) — see that migration's own comment for why this exists
// and why it is explicitly NOT real commerce (no real payment is ever
// processed; a shopper is charged nothing). This is the actual mechanism
// that credits a builder's higgles balance and land-cap-feeding earnings
// ledger when a shopper "buys" a product placed on their lándlet — the one
// concrete higgles-earning path docs/SPEC.md §5 treats as PRIMARY (auction
// sale proceeds, migrations/0045, are the only other one this backend
// implements).
const PURCHASE_COMMISSION_RATE = 0.02; // "2% standard for seller-listed products"
const PURCHASE_BUILDER_SPLIT = 0.5; // "Universal 50/50 split"
const PURCHASE_BUILDER_FLOOR_RATE = 0.005; // "0.5% floor protecting builders"
// quantity had no upper bound at all until this was added — a single
// call with an absurd quantity could mint an arbitrary amount of a
// builder's higgles_balance_cents and higgles_earnings_events credit in
// one request (this predates N44's session requirement on the purchase
// endpoint, and the cap is still worth keeping regardless of who's calling),
// directly undermining "growth is earned through demonstrated performance,
// never purchased" (docs/SPEC.md §0) since earnings feed the land cap
// formula. 1000 stays generous for a legitimate bulk "buy a crate of
// these" simulation while ruling out that abuse.
const PURCHASE_MAX_QUANTITY = 1000;
// worker/index.js's own MAX_MONEY_CENTS is genuinely shared well beyond
// purchases (catalog price validation, auction bids, model uploads
// elsewhere in that file), so it stays there as the source of truth and is
// duplicated here rather than exported/imported -- same #1978
// function/class-binding-only constraint as D1_MAX_BOUND_PARAMETERS above.
// Same "growth is earned, never purchased" reasoning as
// PURCHASE_MAX_QUANTITY just above, applied to priceCents/startingBidCents/
// a bid's amountCents (nonnegativeInteger/optionalInteger below): with no
// upper bound, a seller could set an astronomical priceCents on their own
// catalog template and self-purchase it once to mint an arbitrary
// higgles_balance_cents/higgles_earnings_events credit, and the same hole
// exists on auction bids. $1,000,000 (in cents) stays generous for this
// dev-mode play economy while ruling out that abuse and, just as
// importantly, keeping every stored value within Number.isSafeInteger
// range so it can never silently lose precision once persisted.
const MAX_MONEY_CENTS = 100_000_000;
// Rate-limited the same way signup/password-reset/model-upload are
// (checkRateLimit) — a real account behind this gate now (see
// requireVerifiedSession below) is still capable of looping this endpoint.
const PURCHASE_RATE_LIMIT_MAX = 30;
// #839: handlePurchaseFinalize is unauthenticated by design (no buyer
// account exists in this app), so this is keyed by client IP the same way
// every other unauthenticated repeatable write in this file is, rather than
// by builder_id like PURCHASE_RATE_LIMIT_MAX above.
const PURCHASE_FINALIZE_RATE_LIMIT_MAX = 20;

// Exported: worker/index.js's own top-level dispatcher routes
// POST /api/instances/:id/purchase here.
export async function handleInstancePurchase(request, env, instanceId) {
  const db = env.DB;
  // N44 (owner, 2026-09-12): shopping/purchasing — real-money or simulated —
  // now requires the same age-attestation + credit-card-or-ID gate Build/Sell
  // already enforce ("restrict minors from using any part of the
  // application"), so this is no longer the unauthenticated endpoint the
  // comments elsewhere in this file describe; keyed by the resolved
  // account, not client IP, once a session is required, same as every
  // other session-gated rate limit in this file.
  const user = await requireVerifiedSession(request, db);
  await checkRateLimit(db, `purchase:${user.user_id}`, PURCHASE_RATE_LIMIT_MAX);
  // #680: needed to credit avatar-category purchases to the actual buyer
  // (see owned_avatars' own migration comment on why `purchases` itself
  // has nothing to derive that from) — every account already has one
  // (getOrCreateBuilderForUser, "every user is automatically a builder"),
  // so this never fails for a session that already passed requireVerifiedSession.
  const buyerBuilder = await getOrCreateBuilderForUser(db, user);
  const instance = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
  if (!instance) return json({ error: 'Instance not found' }, 404);
  const template = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(instance.template_id).first();
  if (!template) return json({ error: 'Catalog template not found' }, 404);
  if (template.price_cents == null) {
    throw new HttpError('This product has no price set and cannot be purchased', 400);
  }
  // #1946: a test/demo model -- never a real listing the owner intends to
  // sell -- is still placeable (Build mode's own picker keeps showing it
  // to an admin session) but must never actually be bought, real money or
  // simulated alike.
  if (template.is_test_model) {
    throw new HttpError('This is a test/demo product and cannot be purchased', 400);
  }
  // #2017: a listing with enough distinct counterfeit flags (or an admin
  // escalation) is blocked from new purchases while under review, without
  // touching GET /api/catalog's own list/detail endpoints -- see this
  // column's own migration comment for why hiding it there isn't safe.
  if (template.flagged_hidden_at) {
    throw new HttpError('This product is temporarily unavailable pending review', 400);
  }
  // #1948: a quick, non-atomic pre-check so an obviously sold-out item gets a
  // clear rejection before a buyer goes through checkout (real-money) or the
  // simulated write below -- the actual race-safe enforcement (the last unit
  // bought by two near-simultaneous buyers) happens atomically in
  // writePurchaseRow's own guarded decrement, not here.
  if (template.stock_quantity === 0) {
    throw new HttpError('This product is sold out', 400);
  }
  const landlet = await db.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?').bind(instance.landlet_id).first();
  if (!landlet?.owner_builder_id) {
    throw new HttpError('This instance is not on a claimed landlet, so there is no builder to credit', 400);
  }

  // quantity/buyerLabel are both genuinely optional, and this endpoint has
  // no other required fields, so a missing or empty body is just "buy one"
  // rather than an error — read it directly instead of through the shared
  // readJson (which rejects a missing content-type/body).
  let input = {};
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const text = await request.text();
    if (text) {
      try {
        input = JSON.parse(text);
      } catch {
        throw new HttpError('Request body is not valid JSON', 400);
      }
    }
  }

  // #453: a product whose seller has fully completed Stripe Connect
  // onboarding (#452) checks out with real money instead of this
  // endpoint's original dev-mode simulation (migrations/0051). The
  // stripeConfigured check here is deliberately a silent fallback to the
  // simulation, not a 503 — a deployment that never sets
  // STRIPE_SECRET_KEY at all (local dev, this test suite, or simply a
  // fresh install before the platform owner adds it) should still have a
  // working storefront, exactly as before this feature existed.
  const seller = template.seller_id
    ? await db.prepare('SELECT user_id, stripe_account_id, stripe_onboarding_status FROM sellers WHERE seller_id = ?').bind(template.seller_id).first()
    : null;
  // #2985 (1/5 of #2305): a suspended seller's existing listings must be
  // fully blocked from new purchases, not just left purchasable the way
  // this app's suspension gate otherwise only touches the SUSPENDED
  // account's own session (requireCurrentUser) -- this is the one purchase
  // entry point, so it's checked here regardless of which branch below
  // (real-money checkout vs. the simulated/dev path) ends up handling the
  // rest of the request. Checked by the seller's own linked user_id, never
  // the buyer's -- isUserSuspended already treats a null user_id (no
  // linked account, e.g. a system seller, or one who self-deleted) as not
  // suspended.
  if (await isUserSuspended(db, seller?.user_id)) {
    throw new HttpError('This product is currently unavailable because its seller is suspended.', 400);
  }
  if (seller?.stripe_account_id && seller.stripe_onboarding_status === 'complete' && stripeConfigured(env)) {
    return createPurchaseCheckout(env, instance, template, landlet, seller, input, buyerBuilder.builder_id, buyerBuilder.label);
  }
  // #653 (owner, 2026-09-11): "real-world shoppers should not be able to
  // purchase from dev sellers" — any seller who hasn't (yet) fully
  // completed Stripe Connect onboarding is, for this purpose, a dev
  // seller, and the simulated/free path below is the dev/test pathway
  // the owner wants kept available in parallel with real-money checkout
  // ("the whole point of simulating is to test the real-world code"),
  // not opened up to real shoppers. Closing this off to non-admins is
  // what lets REDEMPTION_PAUSED_PENDING_PROVENANCE's stopgap (below) lift
  // for good: the zero-capital higgles-mint that pause existed for
  // required an unauthenticated real shopper reaching this exact path,
  // which is no longer possible.
  if (!user.is_admin) {
    throw new HttpError('This product is not yet available for purchase — its seller has not finished setting up real payments.', 403);
  }
  // #1231: e2e/*.test.mjs only ever talks HTTP to a running dev server (no
  // direct D1 access the way worker/commerce.test.js's own mark-shipped/
  // confirm-delivery tests use), so it had no way to produce a purchase
  // with a real paymentIntentId at all -- the ship button and the
  // ?confirmDelivery= link (src/main.js) both only apply to one. Driving an
  // actual Stripe checkout isn't an option either (STRIPE_SECRET_KEY is
  // never configured in this suite). This seam mints a synthetic
  // paymentIntentId so e2e can reach writePurchaseRow's real-money branch
  // through the ordinary, already-authenticated purchase endpoint, with no
  // Stripe call involved anywhere. Double-gated so it can never fire against
  // a real deployment or be mistaken for an actual charge: E2E_SIMULATE_PAID_PURCHASES
  // is never a real secret (only ever set in a throwaway .dev.vars/CI
  // config, see that var's own comment there), AND stripeConfigured(env)
  // must be false -- once the owner sets STRIPE_SECRET_KEY, a connected
  // seller's purchases already route through createPurchaseCheckout above
  // instead, making this branch permanently unreachable regardless of the
  // env var's value.
  const simulatedPaymentIntentId = (env.E2E_SIMULATE_PAID_PURCHASES === 'true' && !stripeConfigured(env) && input.simulatePaidPurchaseForTests === true)
    ? `test-pi-${crypto.randomUUID()}`
    : null;
  return writePurchaseRow(
    env, instance, template, landlet, computePurchaseAmounts(template, input, buyerBuilder.label),
    // #888: unlike the real-money checkout->finalize path, there's no time
    // gap here between reading template and writing the purchase — template
    // is already fresh in this same request, so deriving isAvatarCategory
    // from it directly (rather than a locked-in snapshot) is correct here.
    simulatedPaymentIntentId, false, buyerBuilder.builder_id, template.category === 'avatar',
    // #877: the client already mints and sends this (see purchaseInstance
    // in src/api.js) for the real-money path's own idempotency needs —
    // was silently never threaded through to this simulated path's write.
    purchaseIdempotencyKey(instance.instance_id, buyerBuilder.builder_id, input.idempotencyKey),
    // #1163: same "derive directly, no time gap" reasoning as
    // isAvatarCategory just above, for isAnimationCategory.
    template.category === 'animation',
  );
}

// Shared by the simulated path (handleInstancePurchase's own direct write)
// and the real-money path (createPurchaseCheckout) so both apply the
// exact same commission math —
// the only difference between them is WHERE this gets called from and
// what happens with the resulting numbers, never how they're computed.
// #761: fallbackBuyerLabel is the resolved session buyerBuilder's own
// label — the shipped in-world buy flow (handleShopProductBuyClick, src/main.js) never
// sends an explicit buyerLabel in the request body at all, so without this
// fallback every real purchase lands with buyer_label NULL, and the
// review-eligibility check (requires an exact buyer_label match) then
// rejects every real reviewer unconditionally. input.buyerLabel still wins
// when a caller does supply one (e.g. a test exercising a specific label).
function computePurchaseAmounts(template, input, fallbackBuyerLabel) {
  const quantity = input.quantity === undefined ? 1 : positiveInteger(input.quantity, 'quantity');
  // Capped as a sanity bound against a malformed/abusive request producing
  // an absurd totalCents (and the higgles-balance/land-cap credit that
  // flows from it) — not itself a spec requirement, same reasoning as
  // durationHours' cap above. The simulated path still charges no real
  // money (see docs/API.md's "Simulated purchases"), so quantity remains
  // the main thing standing between one request and an unbounded credit
  // even now that a verified session is required (N44) to reach this
  // endpoint at all; checkRateLimit closes the other half of that gap
  // (repeated smaller requests instead of one large one).
  if (quantity > PURCHASE_MAX_QUANTITY) throw new HttpError(`quantity must be ${PURCHASE_MAX_QUANTITY} or fewer`, 400);
  const buyerLabel = input.buyerLabel ? labelValue(input.buyerLabel, 'buyerLabel') : (fallbackBuyerLabel || null);

  const unitPriceCents = template.price_cents;
  const totalCents = unitPriceCents * quantity;
  // #521: priceCents and quantity are each capped individually (above, and
  // at template-creation time), but neither cap bounds their product — a
  // request combining both at their ceilings reintroduces exactly the
  // unbounded-credit risk those caps exist to prevent, just at compound
  // scale. Bounding totalCents itself closes that gap for both this
  // (simulated) path and the real-money path below, which shares this
  // function.
  if (totalCents > MAX_MONEY_CENTS) throw new HttpError(`total price must be ${MAX_MONEY_CENTS} cents or fewer`, 400);
  const commissionCents = Math.round(totalCents * PURCHASE_COMMISSION_RATE);
  const builderShareCents = Math.max(
    Math.round(commissionCents * PURCHASE_BUILDER_SPLIT),
    Math.round(totalCents * PURCHASE_BUILDER_FLOOR_RATE),
  );
  // The floor exists to protect the BUILDER, not to guarantee higglehaven's
  // own take — if it pushes the builder's share above the commission
  // itself (only possible on an unusually low commission rate), the
  // platform's own share is 0, never negative.
  const platformShareCents = Math.max(commissionCents - builderShareCents, 0);
  return { quantity, buyerLabel, unitPriceCents, totalCents, commissionCents, builderShareCents, platformShareCents };
}

// #453: creates a real Stripe PaymentIntent instead of immediately
// crediting higgles — the actual purchases row (and builder higgles
// credit) is only written once the buyer has genuinely paid, via
// handlePurchaseFinalize below, once Stripe confirms the PaymentIntent
// succeeded. Reuses the exact same commission math as the simulated path
// so the two stay consistent; the only difference is where the money
// goes: the ENTIRE commissionCents (not just platformShareCents) is taken
// as Stripe's application_fee_amount, since the builder's own share of it
// is still paid out as higgles — never real money, per the owner's own
// #331 answer — only the remaining ~98% (totalCents - commissionCents)
// transfers to the seller's connected account via transfer_data.
// #473: the buyer's own client mints and persists idempotencyKey (see
// purchaseInstance in src/api.js) across a retry of what THEY consider
// the same attempt — most importantly, one where the initial request's
// response never made it back (a network drop after Stripe already
// created the PaymentIntent), which otherwise looks, client-side,
// identical to the request never having reached us at all and invites an
// innocent second "Buy" click. Namespaced with the instance id so a
// buyer's own key can never collide across two different products, and
// validated (fixed charset/length) before it ever reaches Stripe's own
// header, since it arrives as arbitrary client input. A missing or
// malformed key degrades to no idempotency protection for this one
// request rather than failing the purchase outright — defense in depth,
// not a hard requirement for a real purchase to go through.
// #974: also namespaced with the calling buyerBuilderId, not just the
// instance id -- placed_instances are re-sellable listings (arbitrary
// quantity, nothing marks one "sold"), so many different buyers legitimately
// purchase the same instanceId over time. The client's own rawKey lives in
// localStorage keyed only by instanceId (never the logged-in account) and
// survives a cancelled/abandoned checkout for up to 30 minutes, so a second,
// unrelated buyer on the same browser within that window used to submit the
// exact same key -- writePurchaseRow's dedup lookup would then hand the
// first buyer's later retry the second buyer's own purchase details.
// Folding buyerBuilderId in here makes that collision structurally
// impossible regardless of what the client does with its own key.
function purchaseIdempotencyKey(instanceId, buyerBuilderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `purchase:${instanceId}:${buyerBuilderId}:${rawKey}`;
}

async function createPurchaseCheckout(env, instance, template, landlet, seller, input, buyerBuilderId, buyerBuilderLabel) {
  const amounts = computePurchaseAmounts(template, input, buyerBuilderLabel);
  // #454: locked in at checkout time, same reasoning as every other amount
  // here — a digital good pays out instantly with no hold, so
  // handlePurchaseFinalize (and the orphaned-purchase fallback, which has
  // no live template row to re-check this against) both need this snapshot
  // rather than re-deriving it from a template that might change or vanish.
  const isDigitalGood = !!JSON.parse(template.metadata_json || '{}').digitalGoodDisclaimer;
  // #680: same "snapshot now, no live template lookup later" reasoning as
  // isDigitalGood just above — whether this purchase grants an equippable
  // avatar is decided by category AS OF CHECKOUT, not re-derived from a
  // template row that might change/vanish by the time finalize runs.
  const isAvatarCategory = template.category === 'avatar';
  // #1163: same "snapshot now" reasoning as isAvatarCategory just above,
  // for a standalone-animation purchase instead.
  const isAnimationCategory = template.category === 'animation';

  // Everything handlePurchaseFinalize needs to actually write the purchase
  // travels here, in Stripe's own metadata — set once, server-side, at
  // creation time (using the price/commission split AS OF RIGHT NOW), so
  // finalize can trust it completely and credit exactly what was actually
  // charged, even if the template's own price changes in the meantime,
  // rather than re-deriving amounts from a live template row that might
  // no longer match what Stripe billed the buyer.
  const paymentIntent = await stripeRequest(env, 'POST', 'payment_intents', {
    amount: amounts.totalCents,
    currency: 'usd',
    application_fee_amount: amounts.commissionCents,
    transfer_data: { destination: seller.stripe_account_id },
    metadata: {
      instanceId: instance.instance_id,
      templateId: template.template_id,
      builderId: landlet.owner_builder_id,
      sellerId: template.seller_id || '',
      quantity: String(amounts.quantity),
      buyerLabel: amounts.buyerLabel || '',
      unitPriceCents: String(amounts.unitPriceCents),
      totalCents: String(amounts.totalCents),
      commissionCents: String(amounts.commissionCents),
      builderShareCents: String(amounts.builderShareCents),
      platformShareCents: String(amounts.platformShareCents),
      isDigitalGood: String(isDigitalGood),
      buyerBuilderId: buyerBuilderId || '',
      isAvatarCategory: String(isAvatarCategory),
      isAnimationCategory: String(isAnimationCategory),
    },
  }, purchaseIdempotencyKey(instance.instance_id, buyerBuilderId, input.idempotencyKey));

  // publishableKey is safe to hand to the browser by design (it's how
  // Stripe.js identifies which Stripe account to talk to) — the frontend
  // needs it to mount a card Element and confirm this PaymentIntent
  // itself; nothing about it can authorize a charge on its own.
  return json({
    requiresPayment: true,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  });
}

// #1084: the seller to credit is whoever was locked into this PaymentIntent's
// own metadata at checkout time (createPurchaseCheckout), never re-derived
// from a live landlet lookup -- if an auction on the same landlet resolves
// in the gap between checkout and finalize, a live lookup would credit the
// auction's new winner instead of the seller who actually made the sale.
// Same "does it still resolve to a live builder" existence check
// writeOrphanedPurchaseRow already does for this exact snapshot, since the
// locked-in seller may have self-deleted in the meantime. Exported so a
// direct test can verify this resolution without going through the real
// checkout->finalize flow, which only ever reaches here via a live Stripe
// call this test suite deliberately never configures.
export async function resolveFinalizeBuilderId(db, meta) {
  const checkoutBuilderId = meta.builderId || null;
  if (!checkoutBuilderId) return null;
  const stillExists = await db.prepare('SELECT 1 FROM builders WHERE builder_id = ?').bind(checkoutBuilderId).first();
  return stillExists ? checkoutBuilderId : null;
}

// #453: called once the buyer's card has been confirmed client-side via
// Stripe Elements (stripe.confirmCardPayment) — never trusts that client
// signal on its own. Instead it re-fetches the PaymentIntent from Stripe
// directly (using our own secret key, which the client never has) and
// only writes the purchases row/credits higgles once Stripe itself
// reports the payment actually succeeded, using the amounts locked into
// this PaymentIntent's own metadata at creation time (createPurchaseCheckout
// above) — never recomputed from the live template — so what gets
// credited always matches what Stripe actually charged and transferred,
// even if the product's price has since changed.
// Exported: worker/index.js's own handlePurchases dispatcher (the sibling
// "purchase lifecycle actions" leaf, #2615, not yet moved) calls this for
// POST /api/purchases/finalize.
export async function handlePurchaseFinalize(request, env) {
  const db = env.DB;
  // Validation runs before the Stripe-configured check (same ordering as
  // handleSellerStripeAccount's own POST, #452) so a malformed payload
  // always gets a real 400 instead of being masked by a 503.
  const input = await readJson(request);
  const paymentIntentId = stringValue(input.paymentIntentId, 'paymentIntentId');

  // Idempotent: a retry (network blip, double-tap) after the purchase was
  // already written finds it here instead of crediting the builder twice
  // — the payment_intent_id column's own UNIQUE index (migrations/0069)
  // is the last line of defense if two such calls ever raced each other.
  // Pure DB lookup, so it runs before the Stripe-configured check below
  // rather than after — cheaper, and it means a repeat finalize call for
  // an already-completed purchase keeps working even if Stripe access
  // were ever revoked in between.
  const existing = await db.prepare('SELECT * FROM purchases WHERE payment_intent_id = ?').bind(paymentIntentId).first();
  if (existing) return json({ purchase: purchaseFromRow(existing) });

  // #839: every other unauthenticated repeatable write in this file is
  // rate-limited, but this one — which makes a real outbound Stripe API
  // call using the platform's own secret key on every request — wasn't.
  // Placed after the idempotency lookup above (a legitimate retry for an
  // already-completed purchase never gets throttled) but before the Stripe
  // call below (so an anonymous flood of garbage paymentIntentIds can't
  // burn Worker time or exhaust the shared Stripe API key's own limit).
  await checkRateLimit(db, `purchase-finalize:${clientIp(request)}`, PURCHASE_FINALIZE_RATE_LIMIT_MAX);

  if (!stripeConfigured(env)) {
    throw new HttpError('Stripe payments are not configured on this server yet.', 503);
  }
  const paymentIntent = await stripeRequest(env, 'GET', `payment_intents/${encodeURIComponent(paymentIntentId)}`);
  if (paymentIntent.status !== 'succeeded') {
    throw new HttpError(`Payment has not completed yet (status: ${paymentIntent.status}).`, 400);
  }
  const meta = paymentIntent.metadata || {};
  const instance = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(meta.instanceId).first();
  const template = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(meta.templateId).first();

  const amounts = {
    quantity: Number(meta.quantity) || 1,
    buyerLabel: meta.buyerLabel || null,
    unitPriceCents: Number(meta.unitPriceCents),
    totalCents: Number(meta.totalCents),
    commissionCents: Number(meta.commissionCents),
    builderShareCents: Number(meta.builderShareCents),
    platformShareCents: Number(meta.platformShareCents),
  };
  const isDigitalGood = meta.isDigitalGood === 'true';
  const buyerBuilderId = meta.buyerBuilderId || null;
  // #888: same checkout-time-snapshot reasoning as isDigitalGood above —
  // whether this purchase grants an equippable avatar was already decided
  // and locked into the PaymentIntent's own metadata at checkout (see
  // createPurchaseCheckout's own comment), so it must be read from meta
  // here rather than left for writePurchaseRow to re-derive from a live
  // template.category that may have changed underneath this purchase by
  // the time finalize runs.
  const isAvatarCategory = meta.isAvatarCategory === 'true';
  // #1163: same checkout-time-locked reasoning as isAvatarCategory above,
  // for isAnimationCategory.
  const isAnimationCategory = meta.isAnimationCategory === 'true';
  const checkoutBuilderId = instance && template ? await resolveFinalizeBuilderId(db, meta) : null;

  if (instance && template && checkoutBuilderId) {
    // #1948: allowOversell=true -- real money has already moved by this
    // point (Stripe already confirmed `succeeded` above), and the arbitrary
    // wall-clock gap since checkout means other buyers may have exhausted
    // the remaining stock in the meantime. Rejecting here would strand a
    // real charge with no purchase record at all, the same risk #472's own
    // writeOrphanedPurchaseRow fallback (just below) already exists to
    // avoid -- so this floors remaining stock at zero and still completes
    // the purchase, rather than the simulated path's reject-outright
    // behavior.
    //
    // #2985 (1/5 of #2305): deliberately does NOT re-check the seller's
    // suspension state here, even though handleInstancePurchase above does
    // at checkout-creation time. By the time Stripe reports this
    // PaymentIntent `succeeded` (checked above, before this branch is ever
    // reached), the buyer has already been charged AND
    // transfer_data.destination has already paid the seller's connected
    // account — both happen automatically as part of the PaymentIntent
    // confirming, driven by the buyer's browser talking to Stripe directly
    // (stripe.confirmCardPayment), with no request of ours in that path to
    // gate. Suspending an account doesn't pause its Stripe Connect transfer
    // capability either (confirmed: handleSuspendAccount touches nothing
    // Stripe-related) — so even detecting "the seller is suspended NOW"
    // here can't undo a transfer that already landed, and rejecting the
    // write would strand that real charge with zero record of it, exactly
    // the #472/#1948 problem just above. The only point that can actually
    // prevent a suspended seller's sale is before checkout creates the
    // PaymentIntent at all (handleInstancePurchase) — closing the
    // remaining narrow race (suspension landing in the brief window
    // between checkout-creation and the buyer's own Stripe confirmation)
    // would need either pausing the seller's Stripe transfer capability at
    // the moment of suspension, or a refund/reconciliation flow — both
    // bigger, separate design decisions, not a mechanical finalize-time
    // check.
    return writePurchaseRow(env, instance, template, { owner_builder_id: checkoutBuilderId }, amounts, paymentIntentId, isDigitalGood, buyerBuilderId, isAvatarCategory, undefined, isAnimationCategory, true);
  }

  // #472: the buyer has already been charged and the seller's connected
  // account has already received its transfer via Stripe's own
  // transfer_data — independent of anything in this app's DB — by the
  // time this call runs. A concurrent delete of the instance/template, or
  // the landlet's claim being wiped by an auction resolving mid-payment,
  // used to throw a 409 here with the purchases row never written at
  // all: real money moved with zero record of it, and no way to even
  // find it again (the payment_intent_id idempotency check above has
  // nothing to match against). This always writes a row instead, using
  // only what's locked into the PaymentIntent's own metadata (no live
  // lookups needed for what's already a permanent historical receipt —
  // see purchases' own "not a live reference" design). Deliberately does
  // NOT decide what happens next for an orphaned sale like this
  // (auto-refund, manual review, ...) — that's a reconciliation-policy
  // call left for separate design/owner input; this only guarantees the
  // money is never unaccounted for.
  return writeOrphanedPurchaseRow(env, meta, amounts, paymentIntentId, isDigitalGood);
}

// #454: a real-money physical purchase gets an unguessable token (only its
// hash ever stored, same discipline as password_reset_tokens) so whoever
// holds the link — the buyer, handed it once in their own checkout's
// finalize response — can confirm delivery. There's no buyer account
// anywhere in this app to authenticate a "my orders" view against instead
// (see "Simulated purchases"). Digital goods and simulated (higgles)
// purchases skip this entirely: nothing physical to deliver, and a
// simulated purchase has no real Stripe balance to ever hold against.
async function buildDeliveryConfirmFields(env, paymentIntentId, isDigitalGood) {
  if (!paymentIntentId || isDigitalGood) return { tokenHash: null, deliveryConfirmUrl: null };
  const rawToken = generateToken();
  const tokenHash = await sha256Hex(rawToken);
  return { tokenHash, deliveryConfirmUrl: `${appBaseUrl(env)}/?confirmDelivery=${rawToken}` };
}

// #680: grants equippable avatar ownership at the same point a purchase
// itself is written, in the same db.batch — so ownership can never be
// recorded without the purchase behind it, or vice versa. INSERT OR
// IGNORE since re-buying (a second unit, or the same buyer purchasing
// again) grants nothing extra; ownership is boolean, not quantity-based —
// on that IGNORE path purchase_id deliberately stays whatever the first
// grant recorded, not this later purchase's id.
// #754: purchaseId (migrations/0085) is what lets handlePurchaseRefund
// find and revoke this exact grant later, without needing purchases to
// carry its own buyer-account column (see that migration's own comment on
// why this link lives here instead).
function ownedAvatarStatements(db, buyerBuilderId, templateId, purchaseId) {
  return [
    db.prepare(
      'INSERT OR IGNORE INTO owned_avatars (builder_id, template_id, purchase_id) VALUES (?, ?, ?)',
    ).bind(buyerBuilderId, templateId, purchaseId),
    // #1033: owned_avatars' own purchase_id column only ever records the
    // FIRST purchase of a given template (the INSERT OR IGNORE above is a
    // no-op for a second, independent purchase of the same template), so
    // handlePurchaseRefund's revocation lookup couldn't tell whether
    // another unrefunded purchase still backs the same ownership before
    // deleting it. This dedicated side table records every granting
    // purchase, not just the first, without retrofitting a buyer-identity
    // column onto the shared purchases table itself (deliberately avoided
    // twice already — see 0083_avatar_ownership.sql's own comment).
    db.prepare(
      'INSERT OR IGNORE INTO owned_avatar_purchases (purchase_id, builder_id, template_id) VALUES (?, ?, ?)',
    ).bind(purchaseId, buyerBuilderId, templateId),
  ];
}

// #1163 (sub-issue of #1161): same grant shape as ownedAvatarStatements
// just above, for a standalone "animation"-category purchase instead —
// owned_animations mirrors owned_avatars (migration 0106 includes the
// purchase_id link and the per-purchase owned_animation_purchases side
// table from the start, the same two owned_avatars only grew into after
// #754/#1033 found the gaps the hard way).
function ownedAnimationStatements(db, buyerBuilderId, templateId, purchaseId) {
  return [
    db.prepare(
      'INSERT OR IGNORE INTO owned_animations (builder_id, template_id, purchase_id) VALUES (?, ?, ?)',
    ).bind(buyerBuilderId, templateId, purchaseId),
    db.prepare(
      'INSERT OR IGNORE INTO owned_animation_purchases (purchase_id, builder_id, template_id) VALUES (?, ?, ?)',
    ).bind(purchaseId, buyerBuilderId, templateId),
  ];
}

// Exported so #2267's own regression test can call this directly, the same
// way writePurchaseRow and resolveFinalizeBuilderId already are -- the real
// checkout -> finalize flow only ever reaches this fallback via a live
// Stripe PaymentIntent lookup, which this test suite deliberately never
// configures.
export async function writeOrphanedPurchaseRow(env, meta, amounts, paymentIntentId, isDigitalGood) {
  const db = env.DB;
  const { quantity, buyerLabel, unitPriceCents, totalCents, commissionCents, builderShareCents, platformShareCents } = amounts;
  const purchaseId = `purchase-${crypto.randomUUID()}`;
  // builder_id is a real foreign key (unlike instance_id/template_id) —
  // the builder locked into this PaymentIntent's metadata at checkout
  // time may have since self-deleted, so it's only usable here if it
  // still resolves to a live row. NULL otherwise, the same state an
  // ordinary purchase already reaches when its builder self-deletes
  // *after* a normal purchase (migrations/0062) — nothing to credit.
  const builderStillExists = meta.builderId
    ? await db.prepare('SELECT 1 FROM builders WHERE builder_id = ?').bind(meta.builderId).first()
    : null;
  const builderId = builderStillExists ? meta.builderId : null;
  const sellerId = meta.sellerId || null;
  const { tokenHash, deliveryConfirmUrl } = await buildDeliveryConfirmFields(env, paymentIntentId, isDigitalGood);

  // #680/#1112: same existence check as the seller's builderId just above —
  // the buyer locked into this PaymentIntent's metadata may have since
  // self-deleted too, and owned_avatars.builder_id/purchases.buyer_builder_id
  // are both real foreign keys that would otherwise fail this whole batch
  // (losing the purchase record itself) rather than just silently skipping
  // the grant. Originally gated on isAvatarCategory alone (it only fed
  // ownedAvatarStatements below); #1112 also stores buyer_builder_id on
  // every purchase now, so this runs whenever meta.buyerBuilderId is
  // present at all.
  const isAvatarCategory = meta.isAvatarCategory === 'true';
  // #1163: same checkout-time-locked snapshot as isAvatarCategory above,
  // for a standalone-animation purchase instead.
  const isAnimationCategory = meta.isAnimationCategory === 'true';
  const buyerBuilderStillExists = meta.buyerBuilderId
    ? await db.prepare('SELECT 1 FROM builders WHERE builder_id = ?').bind(meta.buyerBuilderId).first()
    : null;

  // #1109: how much of this sale's commission the velocity cap lets
  // through right now. The established-builder cap (a flat per-sale
  // limit) is still just a pre-batch read -- no concurrency problem of
  // its own, see commissionCapPlanFor's own comment. The new-builder
  // cumulative cap's actual credit decision, by contrast, can no longer
  // be made here: #2879 found that doing so (a plain pre-read, used to
  // compute a number applied later in the batch below) was a TOCTOU race
  // letting concurrent sales from the same counterparty jointly exceed
  // NEW_BUILDER_FLAT_CAP_CENTS. commissionCreditClaimStatement makes and
  // applies that decision atomically instead, pushed into the batch
  // itself right after this sale's own purchase-row INSERT -- see that
  // function's own comment for why it has to run there rather than here.
  let creditNowCents = builderShareCents;
  let escrowCents = 0;
  let counterpartyKey = null;
  let newBuilderClaim = false;
  if (builderId && builderShareCents > 0) {
    counterpartyKey = counterpartyKeyFor(buyerBuilderStillExists ? meta.buyerBuilderId : null, buyerLabel);
    const capPlan = await commissionCapPlanFor(db, { builderId });
    if (capPlan.established) {
      creditNowCents = Math.min(builderShareCents, capPlan.capCents);
      escrowCents = builderShareCents - creditNowCents;
    } else {
      newBuilderClaim = true;
    }
  }

  const statements = [
    db.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, buyer_builder_id,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents,
         payment_intent_id, is_digital_good, delivery_confirm_token_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(purchaseId, meta.instanceId, meta.templateId, builderId, sellerId, buyerLabel,
      buyerBuilderStillExists ? meta.buyerBuilderId : null,
      unitPriceCents, quantity, totalCents, commissionCents, builderShareCents, platformShareCents, paymentIntentId,
      isDigitalGood ? 1 : 0, tokenHash),
  ];
  // #2879: must come right after the purchase-row INSERT above, and in
  // the same batch -- commissionCreditClaimStatement's own live subquery
  // relies on this sale's own row already existing (so it can exclude
  // it) by the time this statement runs.
  let claimIndex = -1;
  if (newBuilderClaim) {
    claimIndex = statements.length;
    statements.push(commissionCreditClaimStatement(db, { purchaseId, builderId, counterpartyKey, builderShareCents }));
  } else if (builderId && creditNowCents > 0) {
    // #2439: a free listing (price_cents 0, reachable since
    // computePurchaseAmounts only rejects a null price, not a zero one)
    // produces builderShareCents === 0 — crediting that is a no-op, but
    // higgles_earnings_events.amount_cents has its own CHECK (amount_cents
    // > 0) (migration 0093), so unconditionally inserting a zero-amount row
    // turned what should be a clean $0 sale into an uncaught "CHECK
    // constraint failed", surfacing as a generic 400 via databaseHttpError.
    // #1109: creditNowCents (not builderShareCents) is what's actually
    // credited immediately -- the cap computed above may have deferred
    // part of it into escrowCents, pushed as a commission_holds row below
    // instead.
    statements.push(
      db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?')
        .bind(creditNowCents, builderId),
      db.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
        .bind(`earnings-${crypto.randomUUID()}`, builderId, creditNowCents),
    );
  }
  if (!newBuilderClaim && builderId && escrowCents > 0) {
    statements.push(commissionHoldInsertStatement(db, { purchaseId, builderId, amountCents: escrowCents }));
  }
  if (isAvatarCategory && buyerBuilderStillExists) {
    statements.push(...ownedAvatarStatements(db, meta.buyerBuilderId, meta.templateId, purchaseId));
  }
  if (isAnimationCategory && buyerBuilderStillExists) {
    statements.push(...ownedAnimationStatements(db, meta.buyerBuilderId, meta.templateId, purchaseId));
  }
  const batchResults = await db.batch(statements);
  if (claimIndex >= 0) {
    // #2879: 0 rows back means the builder self-deleted in the window
    // between builderStillExists above and this statement actually
    // running -- the same already-accepted race #1122's own notification
    // comment describes for this exact function, just reached here
    // instead. Nothing to credit or escrow for a builder who's gone.
    const claimedRow = batchResults[claimIndex].results[0];
    creditNowCents = claimedRow ? claimedRow.credited_cents : 0;
    escrowCents = claimedRow ? builderShareCents - creditNowCents : 0;
    const followUp = [];
    if (creditNowCents > 0) {
      followUp.push(
        db.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
          .bind(`earnings-${crypto.randomUUID()}`, builderId, creditNowCents),
      );
    }
    if (escrowCents > 0) {
      followUp.push(commissionHoldInsertStatement(db, { purchaseId, builderId, amountCents: escrowCents }));
    }
    if (followUp.length > 0) {
      await db.batch(followUp);
    }
  }
  // #2267: writePurchaseRow's own self-dealing check (below) never ran on
  // this fallback path, even though every value it needs is already in
  // scope here -- same "after commit, not inside the batch" placement as
  // the notification just below, since this is a soft signal to record,
  // not something that should roll back the purchase row itself.
  await flagSelfDealingIfMatched(db, purchaseId, buyerBuilderStillExists ? meta.buyerBuilderId : null, sellerId);
  // #1122: fired after the batch above commits, not inside it — builderId's
  // existence was already checked earlier in this function, but a self-
  // delete in the window between that check and this point would otherwise
  // roll back the purchase row itself (a real-money receipt) along with it,
  // just to avoid a notification that was never more than best-effort.
  if (builderId) {
    // #1109: a builder should see when part of a sale's commission is
    // sitting in escrow rather than quietly crediting less than the
    // notification claims -- same wording addition as writePurchaseRow's
    // own identical notification below.
    const escrowNote = escrowCents > 0 ? ` (${formatCents(escrowCents)} held for ${COMMISSION_HOLD_DURATION_DAYS} days per standard review policy)` : '';
    await fireNotification(db, builderId,
      `A sale finalized after its listing changed underneath it (${formatCents(totalCents)} total) — you earned ${formatCents(builderShareCents)} in commission higgles.${escrowNote}`);
  }

  const row = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ purchase: purchaseFromRow(row), ...(deliveryConfirmUrl ? { deliveryConfirmUrl } : {}) }, 201);
}

// Exported so #888's regression test can call this directly with an
// explicit isAvatarCategory, the same way other real-Stripe-path-only
// logic in this file (claimOrResumeBuilderRedemption, sellerPayoutIdempotencyKey)
// is exported for direct unit testing — the real createPurchaseCheckout ->
// handlePurchaseFinalize flow this function's isAvatarCategory parameter
// actually guards against is only reachable through a live Stripe call,
// which this test suite deliberately never configures (see
// worker/commerce.test.js's "Stripe is never configured in this test
// suite" comment).
//
// isAnimationCategory (#1163) is appended as a new trailing parameter,
// after idempotencyKey, rather than inserted alongside isAvatarCategory —
// this function's only two in-source callers that pass that far
// positionally (handleInstancePurchase, handlePurchaseFinalize) both
// needed updating regardless (see their own call sites), and appending
// at the end leaves every shorter positional call (every direct test in
// worker/avatar-ownership.test.js included) completely unaffected.
// #1903: compares an existing row (raw DB shape) against this request's own
// derived amounts and template, mirroring #1873's bundleContentMatches.
// instanceId/buyerBuilderId are deliberately excluded: they're already
// baked into the idempotency key's own namespace (see
// purchaseIdempotencyKey), so two rows reaching this comparison under the
// same key already share them.
function purchaseContentMatches(existingRow, templateId, amounts) {
  return existingRow.template_id === templateId
    && existingRow.quantity === amounts.quantity
    && existingRow.buyer_label === amounts.buyerLabel
    && existingRow.total_cents === amounts.totalCents;
}

export async function writePurchaseRow(env, instance, template, landlet, amounts, paymentIntentId = null, isDigitalGood = false, buyerBuilderId = null, isAvatarCategory = template.category === 'avatar', idempotencyKey = null, isAnimationCategory = template.category === 'animation', allowOversell = false) {
  const db = env.DB;
  const { quantity, buyerLabel, unitPriceCents, totalCents, commissionCents, builderShareCents, platformShareCents } = amounts;
  // #877: a retry (network blip, double-tap) after this exact write already
  // landed once finds it here instead of crediting the builder twice —
  // mirrors handlePurchaseFinalize's own idempotency check, just keyed off
  // purchase_id itself (reused as the dedup key, with its own PRIMARY KEY
  // as the backstop against a genuinely concurrent double-submit) rather
  // than a separate payment_intent_id UNIQUE index, since this simulated
  // path has no Stripe-issued id to dedupe against. idempotencyKey is only
  // ever undefined/null here for a malformed or missing client key
  // (purchaseIdempotencyKey's own "degrades to no protection" behavior).
  //
  // #1903: unlike handlePurchaseFinalize's own dedup (keyed off Stripe's
  // payment_intent_id, which is minted once per checkout session and can
  // never legitimately disagree with itself on a retry), this simulated
  // path's key is client-minted and cached in localStorage for up to 30
  // minutes (see PURCHASE_IDEMPOTENCY_TTL_MS) -- a resubmit of the same key
  // after a lost response can carry a genuinely different quantity. Only
  // honor the dedup hit when the content actually matches; on a mismatch
  // this is a new attempt, so mint a fresh id rather than reusing the
  // idempotency-derived one, which the stale row already occupies.
  let purchaseId = idempotencyKey || `purchase-${crypto.randomUUID()}`;
  if (idempotencyKey) {
    const existing = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(idempotencyKey).first();
    if (existing) {
      if (purchaseContentMatches(existing, template.template_id, amounts)) return json({ purchase: purchaseFromRow(existing) });
      purchaseId = `purchase-${crypto.randomUUID()}`;
    }
  }
  // #1948: a plain, un-guarded UPDATE here would race two near-simultaneous
  // buyers of the last unit -- folding the guard into the UPDATE's own WHERE
  // clause (the same claim-before-act idiom this file already uses for
  // higgles-balance debits elsewhere) makes the check-then-decrement atomic
  // instead. Placed after the idempotency dedup-hit return above, not
  // before: a retry that finds its own already-written row returns before
  // ever reaching here, so a retry of the same purchase can never
  // double-decrement.
  let justSoldOut = false;
  if (template.stock_quantity != null) {
    const decremented = await db.prepare(`
      UPDATE catalog_templates SET stock_quantity = stock_quantity - ?
      WHERE template_id = ? AND stock_quantity >= ?
    `).bind(quantity, template.template_id, quantity).run();
    if (decremented.meta.changes === 0) {
      if (!allowOversell) {
        throw new HttpError('This product is sold out', 400);
      }
      // #1948: real money has already moved by the time
      // handlePurchaseFinalize calls this with allowOversell=true (an
      // arbitrary wall-clock gap sits between checkout and finalize, during
      // which other buyers can exhaust the remaining stock) -- same
      // "the purchase must still be recorded" reasoning as
      // writeOrphanedPurchaseRow's own fallback. Floor remaining stock at
      // zero (never negative) rather than reject outright, and still let
      // the sold-out sweep below fire.
      await db.prepare('UPDATE catalog_templates SET stock_quantity = 0 WHERE template_id = ? AND stock_quantity > 0')
        .bind(template.template_id).run();
    }
    const after = await db.prepare('SELECT stock_quantity FROM catalog_templates WHERE template_id = ?').bind(template.template_id).first();
    justSoldOut = after.stock_quantity === 0;
  }
  // #1717: landlet.owner_builder_id was read by the caller before several
  // more awaited round-trips ran (the seller/Stripe lookup, this function's
  // own idempotency check) — the same staleness risk buyerBuilderId already
  // guards against just below, but this id never got the same re-check.
  // purchases.builder_id is a real FK (ON DELETE SET NULL only governs a
  // *later* delete of a row that existed at insert time, not an insert
  // against an id that was already gone), so an owner self-delete in this
  // window used to fail the INSERT's own FK and roll back the whole batch —
  // losing the purchase record itself, not just the credit. Same
  // builderStillExists-gated shape as writeOrphanedPurchaseRow's own.
  const builderStillExists = landlet.owner_builder_id
    ? await db.prepare('SELECT 1 FROM builders WHERE builder_id = ?').bind(landlet.owner_builder_id).first()
    : null;
  const builderId = builderStillExists ? landlet.owner_builder_id : null;
  const { tokenHash, deliveryConfirmUrl } = await buildDeliveryConfirmFields(env, paymentIntentId, isDigitalGood);
  // #680/#1112: same defensive existence check as writeOrphanedPurchaseRow's
  // own (buyerBuilderId can arrive here from Stripe metadata set at checkout
  // time, same staleness risk as that path — the simulated caller's own
  // buyerBuilderId is always fresh, but this guards both the same way).
  // Originally gated on isAvatarCategory alone (it only fed
  // ownedAvatarStatements below); #1112 also stores buyer_builder_id on
  // every purchase now, so this runs whenever buyerBuilderId is present at
  // all, not just for avatar-category purchases — a stale id must never
  // reach the INSERT below, since purchases.buyer_builder_id is a real FK
  // (ON DELETE SET NULL only governs a *later* delete of a row that existed
  // at insert time, not an insert against an id that was already gone).
  const buyerBuilderStillExists = buyerBuilderId
    ? await db.prepare('SELECT 1 FROM builders WHERE builder_id = ?').bind(buyerBuilderId).first()
    : null;

  // #1109: same cap lookup as writeOrphanedPurchaseRow's own identical
  // block -- see that one's comment for the full reasoning, and #2879's
  // comment there for why the new-builder cumulative path's actual credit
  // decision moved into commissionCreditClaimStatement (pushed into the
  // batch below) instead of being read here.
  let creditNowCents = builderShareCents;
  let escrowCents = 0;
  let counterpartyKey = null;
  let newBuilderClaim = false;
  if (builderId && builderShareCents > 0) {
    counterpartyKey = counterpartyKeyFor(buyerBuilderStillExists ? buyerBuilderId : null, buyerLabel);
    const capPlan = await commissionCapPlanFor(db, { builderId });
    if (capPlan.established) {
      creditNowCents = Math.min(builderShareCents, capPlan.capCents);
      escrowCents = builderShareCents - creditNowCents;
    } else {
      newBuilderClaim = true;
    }
  }

  const statements = [
    db.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, buyer_builder_id,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents,
         payment_intent_id, is_digital_good, delivery_confirm_token_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(purchaseId, instance.instance_id, template.template_id, builderId, template.seller_id, buyerLabel,
      buyerBuilderStillExists ? buyerBuilderId : null,
      unitPriceCents, quantity, totalCents, commissionCents, builderShareCents, platformShareCents, paymentIntentId,
      isDigitalGood ? 1 : 0, tokenHash),
  ];
  // #2879: must come right after the purchase-row INSERT above, and in
  // the same batch -- see writeOrphanedPurchaseRow's own identical block
  // for why.
  let claimIndex = -1;
  if (newBuilderClaim) {
    claimIndex = statements.length;
    statements.push(commissionCreditClaimStatement(db, { purchaseId, builderId, counterpartyKey, builderShareCents }));
  } else if (builderId && creditNowCents > 0) {
    // #2439: same zero-commission guard as handlePurchaseFinalize's own
    // identical block above — a free listing (price_cents 0) makes
    // builderShareCents 0, and crediting that is a no-op, but
    // higgles_earnings_events.amount_cents' own CHECK (amount_cents > 0)
    // (migration 0093) turned an unconditional insert of that zero-amount
    // row into an uncaught "CHECK constraint failed" on an otherwise-clean
    // $0 purchase.
    // #1109: creditNowCents, not builderShareCents, is what's actually
    // credited immediately -- see writeOrphanedPurchaseRow's own identical
    // block for why.
    statements.push(
      db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?')
        .bind(creditNowCents, builderId),
      db.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
        .bind(`earnings-${crypto.randomUUID()}`, builderId, creditNowCents),
    );
  }
  if (!newBuilderClaim && builderId && escrowCents > 0) {
    statements.push(commissionHoldInsertStatement(db, { purchaseId, builderId, amountCents: escrowCents }));
  }
  if (isAvatarCategory && buyerBuilderStillExists) {
    statements.push(...ownedAvatarStatements(db, buyerBuilderId, template.template_id, purchaseId));
  }
  if (isAnimationCategory && buyerBuilderStillExists) {
    statements.push(...ownedAnimationStatements(db, buyerBuilderId, template.template_id, purchaseId));
  }
  const batchResults = await db.batch(statements);
  if (claimIndex >= 0) {
    // #2879: same self-delete-in-the-gap handling as writeOrphanedPurchaseRow's
    // own identical block -- see that one's comment for why.
    const claimedRow = batchResults[claimIndex].results[0];
    creditNowCents = claimedRow ? claimedRow.credited_cents : 0;
    escrowCents = claimedRow ? builderShareCents - creditNowCents : 0;
    const followUp = [];
    if (creditNowCents > 0) {
      followUp.push(
        db.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
          .bind(`earnings-${crypto.randomUUID()}`, builderId, creditNowCents),
      );
    }
    if (escrowCents > 0) {
      followUp.push(commissionHoldInsertStatement(db, { purchaseId, builderId, amountCents: escrowCents }));
    }
    if (followUp.length > 0) {
      await db.batch(followUp);
    }
  }
  // #1122: fired after the batch above commits, not inside it — a landlet
  // owner who self-deletes between this function reading builderId and the
  // INSERT running would otherwise fail the notification's own FK and roll
  // back the purchase row (a real-money receipt) along with it.
  if (builderId) {
    // #1109: same escrow note as writeOrphanedPurchaseRow's own identical
    // notification above.
    const escrowNote = escrowCents > 0 ? ` (${formatCents(escrowCents)} held for ${COMMISSION_HOLD_DURATION_DAYS} days per standard review policy)` : '';
    await fireNotification(db, builderId,
      `"${template.name}" sold (${quantity}x, ${formatCents(totalCents)} total) — you earned ${formatCents(builderShareCents)} in commission higgles.${escrowNote}`);
  }
  // #2019: soft self-dealing signal, never blocks or affects this purchase
  // itself -- a side effect after the real write already committed, same
  // "fired after the batch, not inside it" placement as the notification
  // just above, for the same reason (never risk rolling back a real
  // purchase record over a best-effort flag).
  await flagSelfDealingIfMatched(db, purchaseId, buyerBuilderId, template.seller_id);
  // #1948: after the purchase itself is safely committed and notified, not
  // before -- a self-delete race between the stock decrement above and this
  // sweep must never roll back or block the purchase record itself, the
  // same "fire outside the batch" reasoning as the seller-commission
  // notification just above.
  if (justSoldOut) {
    await sweepSoldOutTemplateInstances(env, db, template);
  }

  const row = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ purchase: purchaseFromRow(row), ...(deliveryConfirmUrl ? { deliveryConfirmUrl } : {}) }, 201);
}

// #2019 (sub-issue of #1212, owner-settled shape 2026-10-13): the one
// signal from this sub-issue's original three-signal scope that this
// codebase can actually compare -- see migrations/0132's own comment for
// why shipping-address and Stripe-customer-ID matching aren't implemented
// here. Fails open (never flags, never throws) whenever either side's
// email can't be resolved at all -- a builder with no linked user_id
// (pre-login/dev-mode) or a seller never linked to a real account is not
// "cleared," it's simply "nothing to compare," same posture the rest of
// this file already takes toward a dangling/unlinked id.
async function flagSelfDealingIfMatched(db, purchaseId, buyerBuilderId, sellerId) {
  if (!buyerBuilderId || !sellerId) return;
  const buyer = await db.prepare(`
    SELECT users.email AS email FROM builders JOIN users ON users.user_id = builders.user_id
    WHERE builders.builder_id = ?
  `).bind(buyerBuilderId).first();
  const seller = await db.prepare(`
    SELECT users.email AS email FROM sellers JOIN users ON users.user_id = sellers.user_id
    WHERE sellers.seller_id = ?
  `).bind(sellerId).first();
  if (!buyer?.email || !seller?.email || buyer.email !== seller.email) return;
  await db.prepare(`
    INSERT INTO self_dealing_flags (flag_id, purchase_id, matched_signals) VALUES (?, ?, ?)
  `).bind(`self-dealing-flag-${crypto.randomUUID()}`, purchaseId, JSON.stringify(['email'])).run();
}


async function sweepSoldOutTemplateInstances(env, db, template) {
  const { results: affectedInstances } = await db.prepare(`
    SELECT pi.instance_id AS instanceId, pi.landlet_id AS landletId, pi.x_m AS xM, pi.y_m AS yM, pi.z_m AS zM,
           l.owner_builder_id AS builderId
    FROM placed_instances pi
    JOIN landlets l ON l.landlet_id = pi.landlet_id
    WHERE pi.template_id = ?
  `).bind(template.template_id).all();

  // #2170: one batched IN(...) lookup for every affected instance's backup
  // chain, instead of a separate query per instance inside the loop below --
  // this function blocks handlePurchaseFinalize's own request (awaited from
  // its purchase-commit path), so an O(n) sequential-round-trip sweep over a
  // popular/free template placed across many landlets risked real checkout
  // latency. Same batch-then-look-up-in-memory idiom this file already uses
  // elsewhere (e.g. getInstancesById, the builder-notification-preference
  // lookup a few lines below this function's own loop).
  const chainsByInstance = new Map();
  // #2283: chunked at D1_MAX_BOUND_PARAMETERS -- a popular/free template can
  // rack up well over 100 affected instances before selling out, and #2170's
  // own batched IN(...) lookup never accounted for D1's bound-parameter cap,
  // same bug class as #2038/#2204/#2216/#2233.
  for (let i = 0; i < affectedInstances.length; i += D1_MAX_BOUND_PARAMETERS) {
    const chunk = affectedInstances.slice(i, i + D1_MAX_BOUND_PARAMETERS);
    const instanceIds = chunk.map((instance) => instance.instanceId);
    const { results: chainEntries } = await db.prepare(`
      SELECT pib.instance_id AS instanceId, pib.backup_id AS backupId, pib.template_id AS templateId, ct.stock_quantity AS stockQuantity
      FROM placed_instance_backups pib
      JOIN catalog_templates ct ON ct.template_id = pib.template_id
      WHERE pib.instance_id IN (${instanceIds.map(() => '?').join(', ')})
      ORDER BY pib.instance_id, pib.position
    `).bind(...instanceIds).all();
    for (const entry of chainEntries) {
      if (!chainsByInstance.has(entry.instanceId)) chainsByInstance.set(entry.instanceId, []);
      chainsByInstance.get(entry.instanceId).push(entry);
    }
  }

  const deletedCountByBuilder = new Map();
  for (const { instanceId, landletId, xM, yM, zM, builderId } of affectedInstances) {
    const chain = chainsByInstance.get(instanceId) || [];
    const consumedBackupIds = [];
    const viable = chain.find((entry) => {
      consumedBackupIds.push(entry.backupId);
      return entry.stockQuantity !== 0;
    });
    if (viable) {
      await db.batch([
        db.prepare(
          "UPDATE placed_instances SET template_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE instance_id = ?",
        ).bind(viable.templateId, instanceId),
        db.prepare(
          `DELETE FROM placed_instance_backups WHERE instance_id = ? AND backup_id IN (${consumedBackupIds.map(() => '?').join(', ')})`,
        ).bind(instanceId, ...consumedBackupIds),
        // consumedBackupIds is always the chain's own leading prefix (every
        // entry up to and including the activated one), so whatever's left
        // sits at position >= consumedBackupIds.length -- shift it down by
        // that same count to close the gap. Without this, the surviving
        // tail would keep its old, now-non-contiguous positions, and the
        // POST handler's own COUNT(*)-based "append at the tail" logic
        // would collide with one of them on the next add.
        db.prepare(
          'UPDATE placed_instance_backups SET position = position - ? WHERE instance_id = ? AND position >= ?',
        ).bind(consumedBackupIds.length, instanceId, consumedBackupIds.length),
      ]);
      continue;
    }
    // #2068: snapshot this instance's own landlet/position (already fetched
    // above) before deleting it -- lets Build mode later show "something
    // used to be here" via a grayed-out marker, instead of the location
    // simply vanishing with no trace. Only reached once the backup chain
    // above is confirmed exhausted -- an instance reactivated onto a
    // backup template in the branch above is not "sold out and gone," so
    // it gets no marker.
    await db.prepare(`
      INSERT INTO sold_out_markers (marker_id, landlet_id, x_m, y_m, z_m, template_id, template_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(`sold-out-marker-${crypto.randomUUID()}`, landletId, xM, yM, zM, template.template_id, template.name).run();
    // Chain exhausted (or empty) with nothing viable -- cascades away this
    // instance's own now-moot placed_instance_backups rows automatically
    // (migrations/0137's ON DELETE CASCADE), unlike the activation branch
    // above, which must remove only the consumed prefix by hand since the
    // instance itself survives.
    await db.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind(instanceId).run();
    if (builderId) {
      deletedCountByBuilder.set(builderId, (deletedCountByBuilder.get(builderId) || 0) + 1);
    }
  }
  if (deletedCountByBuilder.size === 0) return;
  const builderIds = [...deletedCountByBuilder.keys()];
  // #2283: same D1_MAX_BOUND_PARAMETERS chunking as the chain lookup above --
  // a single sweep can remove instances belonging to well over 100 distinct
  // builders.
  const preferenceByBuilder = new Map();
  for (let i = 0; i < builderIds.length; i += D1_MAX_BOUND_PARAMETERS) {
    const chunk = builderIds.slice(i, i + D1_MAX_BOUND_PARAMETERS);
    const { results: preferences } = await db.prepare(`
      SELECT b.builder_id AS builderId, b.notify_sold_out_email AS notifySoldOutEmail, u.email AS builderEmail
      FROM builders b
      LEFT JOIN users u ON u.user_id = b.user_id
      WHERE b.builder_id IN (${chunk.map(() => '?').join(', ')})
    `).bind(...chunk).all();
    for (const p of preferences) preferenceByBuilder.set(p.builderId, p);
  }
  for (const [builderId, count] of deletedCountByBuilder) {
    const plural = count === 1 ? 'instance has' : 'instances have';
    await fireNotification(db, builderId,
      `"${template.name}" just sold out — ${count} placed ${plural} been removed from your land.`);
    const preference = preferenceByBuilder.get(builderId);
    if (preference?.notifySoldOutEmail && preference.builderEmail) {
      // #2212: template.name is free-text/seller-supplied -- escape it
      // before it lands in the html body (the plain-text body and the
      // subject line, neither of which render as markup, are unaffected).
      const safeName = escapeHtml(template.name);
      await sendEmail(env, {
        to: preference.builderEmail,
        subject: `"${template.name}" just sold out`,
        html: `<p>"${safeName}" just sold out — ${count} placed ${plural} been removed from your land.</p>`,
        text: `"${template.name}" just sold out — ${count} placed ${plural} been removed from your land.`,
      });
    }
  }
}

// Exported: worker/index.js still needs this for handlePurchases (the
// /api/purchases dispatcher), handleMarkShipped/handlePurchaseConfirmDelivery/
// handlePurchaseRefund/handlePurchaseDispute (the sibling "purchase
// lifecycle actions" leaf, #2615, not yet moved), and handleExportData's
// own GDPR export -- imported back from here rather than duplicated.
export function purchaseFromRow(row) {
  return {
    purchaseId: row.purchase_id,
    instanceId: row.instance_id,
    templateId: row.template_id,
    builderId: row.builder_id,
    sellerId: row.seller_id,
    buyerLabel: row.buyer_label,
    // #1112: the buyer's own builder_id, captured at purchase time now that
    // every real purchase requires a verified session (N44) — unlike
    // builder_id above (the host who earns commission), this identifies who
    // bought it. Null for a pre-#1112 purchase or one whose buyer has since
    // self-deleted (ON DELETE SET NULL).
    buyerBuilderId: row.buyer_builder_id,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    totalCents: row.total_cents,
    commissionCents: row.commission_cents,
    builderShareCents: row.builder_share_cents,
    platformShareCents: row.platform_share_cents,
    createdAt: row.created_at,
    refundedAt: row.refunded_at,
    // #2247: the one place this app's own data now shows a partial refund
    // ever happened on this purchase at all -- see migrations/0166's own
    // comment for why this is the durable record the owner's decision
    // asked for, closing finding 3 ("zero audit trail") of that issue.
    refundedAmountCents: row.refunded_amount_cents,
    paymentIntentId: row.payment_intent_id,
    // #454: never expose delivery_confirm_token_hash itself — same
    // discipline as password_reset_tokens never exposing its hash either.
    isDigitalGood: !!row.is_digital_good,
    shippedAt: row.shipped_at,
    deliveryConfirmedAt: row.delivery_confirmed_at,
    paidOutAt: row.paid_out_at,
  };
}
