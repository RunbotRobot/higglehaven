// #2619 (leaf of #2536, sub-issue of #2502/#2500): seller payout
// claim/resume, builder higgles-redemption, W-9/W-8BEN tax-ID collection,
// and 1099 tax-reporting/e-filing handlers. Extracted verbatim from
// worker/index.js, zero behavior change, same discipline as
// #2501/#2528/#2535/#2534/#2613/#2618.
//
// Deliberately NOT included here: encryptTaxIdPayload/decryptTaxIdPayload
// (already exported, stay in worker/index.js -- genuinely shared crypto
// primitives, not payout/tax-form specific), stripeAccountStatusJson/
// getOrCreateSellerForUser/nonnegativeInteger/formatCents/stripeConfigured/
// stripeRequest (each genuinely shared well beyond this leaf -- Stripe
// Connect onboarding, purchase checkout/refund, account responses
// generally) -- each stays in worker/index.js and is imported back below,
// same one-directional-except-for-genuinely-shared-state shape
// worker/lib/stripe.js's own header comment documents. STRIPE_RATE_LIMIT_MAX
// is duplicated rather than imported, matching worker/lib/stripe.js's own
// precedent (workerd requires every named export of the main Worker entry
// module to be a function/class binding, not a plain const).
import { json, HttpError } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue, labelValue } from './validation.js';
import { requireCurrentUser, sha256Hex } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';
import { countryNameToCode, usStateNameToCode } from './country-codes.js';
import {
  encryptTaxIdPayload, decryptTaxIdPayload, stripeAccountStatusJson,
  getOrCreateSellerForUser, nonnegativeInteger, formatCents, stripeConfigured, stripeRequest,
} from '../index.js';

// Same reasoning as worker/lib/stripe.js's own duplicate -- see this
// module's own header comment above.
const STRIPE_RATE_LIMIT_MAX = 20;

function taxIdEncryptionConfigured(env) {
  return !!env.TAX_ID_ENCRYPTION_KEY;
}

// #895: every field here used to go through the bare stringValue() (no
// upper bound at all) — the same gap #337 already found and fixed for
// authorLabel/buyerLabel elsewhere in this file via labelValue(). Reusing
// labelValue()'s 100-char cap for the shorter fields; legalName/
// addressLine1 get their own, longer cap (same idea as password's own
// separate 200-char limit above) since a full legal name or street
// address can legitimately run past 100 characters.
const MAX_TAX_FORM_TEXT_LENGTH = 200;
function taxFormTextValue(value, field) {
  const text = stringValue(value, field);
  if (text.length > MAX_TAX_FORM_TEXT_LENGTH) {
    throw new HttpError(`${field} must be ${MAX_TAX_FORM_TEXT_LENGTH} characters or fewer`, 400);
  }
  return text;
}

// W-9 (US persons) needs a US taxpayer ID (SSN or EIN) and a US address;
// W-8BEN (non-US persons) needs a country of citizenship, a foreign tax
// ID, and a permanent residence address instead — genuinely different
// required fields, not just a relabeled copy of the same form.
function validateTaxIdForm(input) {
  const formType = input.formType;
  if (formType !== 'w9' && formType !== 'w8ben') throw new HttpError('formType must be "w9" or "w8ben"', 400);
  const legalName = taxFormTextValue(input.legalName, 'legalName');
  const addressLine1 = taxFormTextValue(input.addressLine1, 'addressLine1');
  const city = labelValue(input.city, 'city');
  if (formType === 'w9') {
    const taxIdNumber = labelValue(input.taxIdNumber, 'taxIdNumber');
    // #1972: a US SSN/EIN is always 9 digits, optionally dash-formatted
    // (NNN-NN-NNNN for an SSN, NN-NNNNNNN for an EIN) -- stripping dashes
    // and requiring exactly 9 digits covers both without needing to tell
    // which one this is, same shape as individual.ssnLast4's own regex
    // check elsewhere in this file.
    if (!/^\d{9}$/.test(taxIdNumber.replace(/-/g, ''))) {
      throw new HttpError('taxIdNumber must be 9 digits (an SSN or EIN), optionally dash-formatted', 400);
    }
    return {
      formType, legalName, addressLine1, city,
      state: labelValue(input.state, 'state'),
      postalCode: labelValue(input.postalCode, 'postalCode'),
      taxIdNumber,
    };
  }
  return {
    formType, legalName, addressLine1, city,
    country: labelValue(input.country, 'country'),
    countryOfCitizenship: labelValue(input.countryOfCitizenship, 'countryOfCitizenship'),
    foreignTaxId: labelValue(input.foreignTaxId, 'foreignTaxId'),
  };
}

// Same authenticated-per-user shape as FRIEND_REQUEST_RATE_LIMIT_MAX/
// BUNDLE_MUTATE_RATE_LIMIT_MAX above (#895) — this endpoint had no
// checkRateLimit call at all before, unlike every comparable authenticated
// mutation in this file.
const TAX_ID_FORM_RATE_LIMIT_MAX = 20;

// A builder/seller can resubmit (e.g. a corrected SSN, or upgrading from
// an already-filed W-8BEN to a W-9 after becoming a US person) — this
// isn't gated on anything yet (#615 is the later sub-issue that actually
// restricts access based on whether this is on file), so overwriting a
// prior submission outright is the right default rather than rejecting a
// resubmission as a conflict.
async function handleTaxIdForm(request, env, db, user) {
  if (!taxIdEncryptionConfigured(env)) {
    throw new HttpError('Tax-ID collection is not configured on this server yet.', 503);
  }
  await checkRateLimit(db, `tax-id-form:${user.user_id}`, TAX_ID_FORM_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const form = validateTaxIdForm(input);
  const encrypted = await encryptTaxIdPayload(env, form);
  const completedAt = new Date().toISOString();
  await db.prepare(`
    UPDATE users SET tax_form_type = ?, tax_form_completed_at = ?, tax_id_encrypted = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ?
  `).bind(form.formType, completedAt, encrypted, user.user_id).run();
  return json({ taxFormType: form.formType, taxFormCompletedAt: completedAt });
}

// #2843 (sub-issue of #2841): the first real caller of decryptTaxIdPayload
// (its own comment above notes nothing called it for real before this) --
// resolves a SINGLE user's own already-on-file W-9/W-8BEN into the
// country/state #2842's tax_education_content table is keyed on, so
// GET /api/tax-education/mine (worker/lib/tax-education.js) can surface
// jurisdiction-relevant content without a new location-collection step.
// Deliberately scoped to one user's own row at a time (never a bulk scan
// across users.tax_id_encrypted) -- #2842's own migration comment explains
// why this field stays off-limits as a bulk join key; decrypting a user's
// own form to answer their own request is a different, narrower thing.
// A w9 filer's country is always 'US' (the form itself has no country
// field -- w9 implies it); a w8ben filer's own country field is the
// signal. Returns null when there's nothing on file yet (the overwhelmingly
// common case for any account that hasn't crossed the earnings threshold
// #615 requires paperwork for).
export async function getUserTaxJurisdiction(env, user) {
  if (!user.tax_id_encrypted) return null;
  const form = await decryptTaxIdPayload(env, user.tax_id_encrypted);
  if (form.formType === 'w9') return { country: 'US', state: usStateNameToCode(form.state) };
  // form.country is free text (see country-codes.js's own comment) --
  // countryNameToCode returns null for anything it doesn't recognize,
  // same "no jurisdiction match" outcome as having no form on file.
  const country = countryNameToCode(form.country);
  return country ? { country, state: null } : null;
}

// #625 (sub-issue of #349/#324): a builder's higgles balance was, until
// #624, purely an internal number with no exit to real cash at all — see
// #349's own Control Room answer (2026-09-09 06:53 UTC) confirming
// redemption should be free below the reporting threshold rather than
// scoped to "only what's owed in tax" (the issue's own original, narrower
// framing this supersedes).
//
// Reuses #615's exact threshold-gating pieces (annualGrossIncome,
// TAX_REPORTING_THRESHOLD_CENTS, user.tax_form_completed_at), but not its
// partial-cap math: #615 drains a granular pool of individual purchases
// it can partially include, while higgles_balance_cents is one lifetime
// running total with no per-earning-event pool left to partially redeem
// from (see migrations/0050's own daller_earnings_events/
// higgles_earnings_events — a ledger of how the balance grew, not
// something a redemption can attribute itself against precisely). This
// only supports a flat block once this year's combined gross income has
// already crossed the line with no paperwork on file, not a partial
// redemption cap the way #615 computes — simpler, and honest about not
// pretending to apportion which "layer" of a lifetime balance corresponds
// to this year's earnings specifically.
//
// #653 (fixed): higgles_balance_cents is one fungible pool with no
// provenance tracking back to real money, so the simulated/free purchase
// path (handleInstancePurchase's dev-mode fallback) crediting builder
// commission exactly like a real Stripe sale used to let an
// unauthenticated real shopper mint real-redeemable commission with zero
// capital — same root cause #629 already found on the auction side, but
// reachable here with no capital and no exploit skill at all. Paused via
// REDEMPTION_PAUSED_PENDING_PROVENANCE (same stopgap-first-ask-later
// precedent as #629/#630) until the owner's actual fix shipped: that
// simulated path is now admin-only (see handleInstancePurchase's own
// #653 comment), so a real shopper can no longer reach it at all, closing
// this off by construction rather than by a provenance-tracked ledger.
//
// #869: finds this builder's own last still-incomplete redemption
// (claimed, but not yet confirmed by a payout) and resumes it instead of
// claiming a fresh one — the actual fix for the duplicate-payout race
// #866/#868 tried and failed to close (their Idempotency-Key included a
// fresh crypto.randomUUID() every call, so it could never match a retry's
// own key). Exported so this — the part of the fix that doesn't require a
// real Stripe call — can be unit-tested directly; POST /api/builders/me/
// redeem itself always 503s before reaching this in the test suite
// (Stripe is never configured there), the same limitation
// claimPurchasesForPayout's own tests above already accept for the
// seller side.
export async function claimOrResumeBuilderRedemption(db, builderId, amountCents) {
  const pending = await db.prepare(`
    SELECT * FROM higgles_redemptions WHERE builder_id = ? AND stripe_payout_id IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).bind(builderId).first();
  if (pending) {
    return { redemption: pending, resumed: true };
  }

  // Atomically claims the balance before ever calling Stripe, guarded on
  // the balance still covering this amount at commit time — the same
  // "claim first, guard on the current value" idiom claimPurchasesForPayout
  // above uses for sellers, closing the same double-redemption race two
  // concurrent requests would otherwise hit.
  const claim = await db.prepare(`
    UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE builder_id = ? AND higgles_balance_cents >= ?
  `).bind(amountCents, builderId, amountCents).run();
  if (claim.meta.changes === 0) {
    return { redemption: null, resumed: false };
  }

  // #852: inserted before either Stripe call, not after both succeed —
  // this is what lets DELETE /api/builders/:id's own guard (see its
  // comment) detect a redemption that's mid-flight (claimed, but not yet
  // confirmed by a payout) the same way the seller-side
  // claimPurchasesForPayout/paid_out_at claim already does. Without a
  // persisted row this early, a builder deleted in the window between the
  // balance claim above and the Stripe calls below used to let real money
  // move with the INSERT then failing outright on the now-missing
  // builder_id's FK, and the catch block's own refund below silently
  // no-op (0 rows) against a builder that no longer exists.
  const redemptionId = `redemption-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO higgles_redemptions (redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id)
    VALUES (?, ?, ?, NULL, NULL)
  `).bind(redemptionId, builderId, amountCents).run();
  const redemption = await db.prepare('SELECT * FROM higgles_redemptions WHERE redemption_id = ?')
    .bind(redemptionId).first();
  return { redemption, resumed: false };
}

export async function handleBuilderRedeem(request, env, db) {
  const user = await requireCurrentUser(request, db);
  const sessionBuilder = await getOrCreateBuilderForUser(db, user);
  // #1029: net out higgles held by the caller's own active auction bids —
  // same heldElsewhere shape handleAuctionBids already computes for the
  // identical concept (#629: a bid holds what it needs until outbid or the
  // auction closes). Without this, availableCents (and the frontend's
  // "Available to redeem" display built on it) included higgles already
  // committed to a leading bid, which resolveAuction's own atomic debit
  // would then silently fail to honor if redeemed away.
  const heldByActiveBids = await db.prepare(`
    SELECT COALESCE(SUM(ab.amount_cents), 0) AS higglesCents
    FROM auction_bids ab
    JOIN auctions a ON a.auction_id = ab.auction_id
    WHERE ab.bidder_builder_id = ? AND a.status = 'active'
      AND ab.amount_cents = (SELECT MAX(amount_cents) FROM auction_bids WHERE auction_id = ab.auction_id)
  `).bind(sessionBuilder.builder_id).first();
  const availableCents = Math.max(sessionBuilder.higgles_balance_cents - heldByActiveBids.higglesCents, 0);

  if (request.method === 'GET') {
    return json({ ...stripeAccountStatusJson(env, sessionBuilder), availableCents });
  }

  if (request.method === 'POST') {
    // #1050: same "real outbound Stripe API call on the shared key" gap
    // #839/#948 already closed for the stripe-account handlers — this POST
    // branch's Stripe transfers/payouts calls further down (unreachable in
    // this test suite since Stripe is never configured there, but not in a
    // real deployment) need the identical guard, same placement precedent
    // as #948.
    await checkRateLimit(db, `builder-redeem:${sessionBuilder.builder_id}`, STRIPE_RATE_LIMIT_MAX);
    if (availableCents <= 0) {
      throw new HttpError('Nothing is available to redeem yet.', 400);
    }
    // An empty {} body means "redeem everything available" — amountCents
    // only needs specifying to redeem a smaller amount.
    const input = await readJson(request);
    const amountCents = input.amountCents === undefined ? availableCents : nonnegativeInteger(input.amountCents, 'amountCents');
    if (amountCents <= 0) throw new HttpError('amountCents must be greater than 0', 400);
    if (amountCents > availableCents) {
      throw new HttpError(`Only ${formatCents(availableCents)} is available to redeem.`, 400);
    }

    const sessionSeller = await db.prepare('SELECT * FROM sellers WHERE user_id = ?').bind(user.user_id).first();
    const grossIncome = await annualGrossIncome(
      db, { builderId: sessionBuilder.builder_id, sellerId: sessionSeller?.seller_id ?? null }, new Date().getUTCFullYear(),
    );
    const hasTaxPaperworkOnFile = !!user.tax_form_completed_at;
    if (!hasTaxPaperworkOnFile && grossIncome.totalCents > TAX_REPORTING_THRESHOLD_CENTS) {
      throw taxThresholdPayoutBlockedError();
    }

    if (!stripeConfigured(env)) {
      throw new HttpError('Stripe payouts are not configured on this server yet.', 503);
    }
    if (!sessionBuilder.stripe_account_id || sessionBuilder.stripe_onboarding_status !== 'complete') {
      throw new HttpError('Complete Stripe onboarding before redeeming higgles for cash.', 400);
    }

    // #869: a genuine retry (the client resending this same redeem request
    // after losing the response to a network drop between Stripe
    // processing it and this Worker reading the result) used to mint a
    // brand new redemption row and a fresh idempotency key every time, so
    // Stripe could never recognize it as the same request — a real
    // duplicate payout. claimOrResumeBuilderRedemption resumes whatever
    // this builder's own last incomplete redemption left behind instead,
    // so the same redemption_id (and the same Idempotency-Key header)
    // reaches Stripe on both the original attempt and the retry.
    const { redemption, resumed } = await claimOrResumeBuilderRedemption(db, sessionBuilder.builder_id, amountCents);
    if (!redemption) {
      throw new HttpError('Your higgles balance changed — try again.', 409);
    }
    if (resumed) {
      return resumeBuilderRedemption(env, db, sessionBuilder, redemption);
    }
    const redemptionId = redemption.redemption_id;

    let payout;
    try {
      // Two real Stripe calls, unlike a seller's own payout: higgles were
      // never sitting in any per-builder Stripe balance to begin with (a
      // seller's sale proceeds land in their own connected account
      // automatically via transfer_data at checkout — see #454's own
      // comment), so a Transfer has to move platform-held funds into the
      // builder's connected account first, before a Payout can send that
      // balance out to their bank the same way handleSellerPayouts already
      // does.
      const transfer = await stripeRequest(
        env, 'POST', 'transfers',
        { amount: amountCents, currency: 'usd', destination: sessionBuilder.stripe_account_id },
        `builder-redeem-transfer:${redemptionId}`,
      );
      await db.prepare('UPDATE higgles_redemptions SET stripe_transfer_id = ? WHERE redemption_id = ?')
        .bind(transfer.id, redemptionId).run();
      payout = await stripeRequest(
        env, 'POST', 'payouts', { amount: amountCents, currency: 'usd' },
        `builder-redeem-payout:${redemptionId}`, sessionBuilder.stripe_account_id,
      );
      await db.prepare('UPDATE higgles_redemptions SET stripe_payout_id = ? WHERE redemption_id = ?')
        .bind(payout.id, redemptionId).run();
    } catch (err) {
      // The claim above already debited the balance — release it so a
      // failed Stripe call never strands real higgles the builder still
      // has, the same undo-on-failure pattern releasePurchaseClaim uses.
      await db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?')
        .bind(amountCents, sessionBuilder.builder_id).run();
      // Only delete the claim row if the transfer itself never went
      // through — nothing happened, so there's nothing to keep a record
      // of. If the transfer succeeded but the payout failed, real money
      // already moved into the builder's connected account; leave the row
      // (transfer id set, payout id still NULL) as the one trace of that
      // rather than erasing it, and it keeps blocking builder deletion via
      // the same guard until someone follows up.
      await db.prepare('DELETE FROM higgles_redemptions WHERE redemption_id = ? AND stripe_transfer_id IS NULL')
        .bind(redemptionId).run();
      throw err;
    }

    return json({ redeemedCents: amountCents, stripePayoutId: payout.id });
  }

  return json({ error: 'Not found' }, 404);
}

// #869: completes a redemption a prior request already claimed and
// (partially or fully) attempted with Stripe, rather than starting a
// second one — see handleBuilderRedeem's own call site comment. Reusing
// `pending.redemption_id` as the Idempotency-Key's stable component on
// both Stripe calls is what makes this actually idempotent: an
// immediate second retry lands here again and sends the exact same key,
// so Stripe recognizes it as the same request instead of processing a
// second real payout.
async function resumeBuilderRedemption(env, db, sessionBuilder, pending) {
  let payout;
  try {
    let transferId = pending.stripe_transfer_id;
    if (!transferId) {
      const transfer = await stripeRequest(
        env, 'POST', 'transfers',
        { amount: pending.amount_cents, currency: 'usd', destination: sessionBuilder.stripe_account_id },
        `builder-redeem-transfer:${pending.redemption_id}`,
      );
      transferId = transfer.id;
      await db.prepare('UPDATE higgles_redemptions SET stripe_transfer_id = ? WHERE redemption_id = ?')
        .bind(transferId, pending.redemption_id).run();
    }
    payout = await stripeRequest(
      env, 'POST', 'payouts', { amount: pending.amount_cents, currency: 'usd' },
      `builder-redeem-payout:${pending.redemption_id}`, sessionBuilder.stripe_account_id,
    );
    await db.prepare('UPDATE higgles_redemptions SET stripe_payout_id = ? WHERE redemption_id = ?')
      .bind(payout.id, pending.redemption_id).run();
  } catch (err) {
    // Deliberately does not refund the balance or delete the row the way
    // a fresh attempt's own catch block does — we don't know whether
    // *this* resume's Stripe call genuinely failed or just lost its
    // response, so leaving the claim and row in place keeps the
    // redemption resumable (and keeps blocking builder deletion) instead
    // of risking yet another stranded duplicate on the next retry.
    throw err;
  }
  return json({ redeemedCents: pending.amount_cents, stripePayoutId: payout.id });
}

// #454: real-money sale proceeds already sit in the seller's own Stripe
// Custom-account balance the instant a sale is charged (#453's own
// transfer_data) — this is purely a policy-driven gate on when
// higglehaven lets the seller actually request payout of it. Owner-
// confirmed policy (Control Room msg-q-issue-454-trust-tiers): a digital
// good pays out instantly (delivered the moment it's bought — no
// chargeback window where non-delivery is plausible); a physical good
// holds until whichever comes first: the buyer confirms delivery (see
// handlePurchaseConfirmDelivery), or this many days after the seller
// marks it shipped (see handleMarkShipped) — a fallback for exactly the
// case where confirmation never happens.
const PHYSICAL_GOOD_HOLD_DAYS = 7;

function purchaseSellerShareCents(purchase) {
  return purchase.total_cents - purchase.commission_cents;
}

function isPurchaseEligibleForPayout(purchase) {
  if (!purchase.payment_intent_id) return false; // simulated — no real Stripe balance to release
  if (purchase.is_digital_good) return true;
  if (purchase.delivery_confirmed_at) return true;
  if (!purchase.shipped_at) return false; // still not shipped — always held
  return Date.now() >= new Date(purchase.shipped_at).getTime() + PHYSICAL_GOOD_HOLD_DAYS * 24 * 60 * 60 * 1000;
}

// Purchases still owed to this seller (a real-money sale, not yet
// refunded or paid out) — capped generously rather than paginated, since
// a seller's own backlog of unpaid sales should stay small in practice
// (payouts drain it), the same "good enough for now" scale as this file's
// other uncapped-in-practice lists.
async function unpaidSellerPurchases(db, sellerId) {
  const { results } = await db.prepare(`
    SELECT * FROM purchases
    WHERE seller_id = ? AND payment_intent_id IS NOT NULL AND paid_out_at IS NULL AND refunded_at IS NULL
    ORDER BY created_at ASC
    LIMIT 500
  `).bind(sellerId).all();
  return results;
}

async function sellerPayoutSummaryJson(env, db, sessionSeller) {
  const purchases = await unpaidSellerPurchases(db, sessionSeller.seller_id);
  let availableCents = 0;
  let heldCents = 0;
  let nextEligibleAt = null;
  for (const purchase of purchases) {
    const share = purchaseSellerShareCents(purchase);
    if (isPurchaseEligibleForPayout(purchase)) {
      availableCents += share;
      continue;
    }
    heldCents += share;
    if (purchase.shipped_at) {
      const eligibleAt = new Date(purchase.shipped_at).getTime() + PHYSICAL_GOOD_HOLD_DAYS * 24 * 60 * 60 * 1000;
      if (nextEligibleAt === null || eligibleAt < nextEligibleAt) nextEligibleAt = eligibleAt;
    }
  }
  return {
    ...stripeAccountStatusJson(env, sessionSeller),
    availableCents,
    heldCents,
    nextEligibleAt: nextEligibleAt === null ? null : new Date(nextEligibleAt).toISOString(),
  };
}

// Atomically claims a batch of purchases for payout by stamping
// paid_out_at, guarded so a purchase a concurrent request already claimed
// (or already fully paid out) is silently skipped rather than claimed a
// second time — the same guarded-write idiom this file already uses for
// auction bids/instance moves (PR #415/#462), applied here to close a
// double-payout race: two concurrent POST /sellers/me/payouts calls used
// to both read the same unpaid purchases, both trigger a real Stripe
// payout for them, and only afterward both write paid_out_at with no
// guard at all — a genuine double Stripe transfer, not just a DB
// inconsistency. Returns only the purchases this call actually won the
// claim on, so the caller can size its Stripe payout request off the
// post-claim set rather than the pre-claim one.
//
// #1061: also guards on refunded_at IS NULL — callers filter refunded_at
// at read time (unpaidSellerPurchases), but handleSellerPayouts does real
// work (DB awaits, an outbound Stripe balance call) between that read and
// this claim, a long enough window for a concurrent handlePurchaseRefund
// to refund one of the same purchases in between. Without this, the
// purchase still gets claimed and paid out for real even though it's
// simultaneously being refunded back to the buyer.
export async function claimPurchasesForPayout(db, purchases, nowIso) {
  if (purchases.length === 0) return [];
  const results = await db.batch(purchases.map((purchase) =>
    db.prepare('UPDATE purchases SET paid_out_at = ? WHERE purchase_id = ? AND paid_out_at IS NULL AND refunded_at IS NULL')
      .bind(nowIso, purchase.purchase_id)));
  return purchases.filter((_, i) => results[i].meta.changes === 1);
}

// Decides which of this payout's otherwise-eligible purchases actually fit
// inside both this request's own limits: Stripe's currently-available
// balance (payoutCapCents) and this tax year's remaining reporting-
// threshold headroom (taxBudgetCents). Exported and pulled out of
// handleSellerPayouts for the same reason claimPurchasesForPayout above is
// its own function: this suite never configures STRIPE_SECRET_KEY, so
// nothing past handleSellerPayouts' own stripeConfigured check (everything
// this function decides) is reachable through the real endpoint at all.
//
// #1335: taxBudgetCents is a current-tax-year-only budget (mirroring
// eligibleGrossCents' own [yearStart, yearEnd) scoping two steps up in
// handleSellerPayouts, fixed by #1087) -- a stale prior-year purchase in
// `eligible` (unpaidSellerPurchases has no year filter of its own, and
// orders by created_at ASC, so a stale one is seen first) must never spend
// that budget, or it can eat the whole headroom and wrongly skip a
// genuinely current-year purchase for tax reasons it has nothing to do
// with.
export function selectPurchasesForPayout(eligible, { payoutCapCents, taxBudgetCents, yearStart, yearEnd }) {
  let payoutCents = 0;
  let grossIncludedCents = 0;
  let skippedForTax = false;
  const included = [];
  for (const purchase of eligible) {
    const share = purchaseSellerShareCents(purchase);
    if (payoutCents + share > payoutCapCents) continue;
    const countsTowardTaxYear = purchase.created_at >= yearStart && purchase.created_at < yearEnd;
    if (countsTowardTaxYear && grossIncludedCents + purchase.total_cents > taxBudgetCents) {
      skippedForTax = true;
      continue;
    }
    payoutCents += share;
    if (countsTowardTaxYear) grossIncludedCents += purchase.total_cents;
    included.push(purchase);
  }
  return { included, payoutCents, skippedForTax };
}

// Undoes a claim made by claimPurchasesForPayout, for when the Stripe call
// that was supposed to follow it never succeeds — otherwise a failed
// attempt would strand these purchases as permanently "already paid out"
// with no stripe_payout_id and no way to retry. Guarded on paid_out_at
// still matching this exact claim's own timestamp so it only ever releases
// a claim this call made, never a different, later one.
async function releasePurchaseClaim(db, purchases, nowIso) {
  if (purchases.length === 0) return;
  await db.batch(purchases.map((purchase) =>
    db.prepare('UPDATE purchases SET paid_out_at = NULL WHERE purchase_id = ? AND paid_out_at = ?')
      .bind(purchase.purchase_id, nowIso)));
}

// #869: derives the seller-payout Idempotency-Key from the exact claimed
// purchase-id set, replacing the fresh crypto.randomUUID() #866/#868 used
// (which could never match a retry's own key, so it never actually
// protected against a duplicate payout the way that fix intended). Sorted
// first so the same claimed set always hashes to the same key regardless
// of iteration order. Exported for direct testing, same reasoning as
// claimPurchasesForPayout's own export just above.
export async function sellerPayoutIdempotencyKey(sellerId, purchaseIds) {
  const hash = await sha256Hex([...purchaseIds].sort().join(','));
  return `seller-payout:${sellerId}:${hash}`;
}

// #969: mirrors claimOrResumeBuilderRedemption's own "resume before
// claiming fresh" shape (#869) — a genuine retry after this seller's own
// Stripe payout call succeeded but the trailing DB write recording
// stripe_payout_id never landed (a D1 blip, a Worker eviction) used to
// leave these purchases claimed (paid_out_at set) forever: unpaidSellerPurchases
// only ever looks at paid_out_at IS NULL, so no future payout attempt could
// ever pick them back up, and the seller-delete guard (paid_out_at IS NULL
// OR stripe_payout_id IS NULL) then permanently blocks the account from
// being deleted. Unlike redemption, no new claim table is needed here —
// sellerPayoutIdempotencyKey above is a pure function of sellerId + the
// claimed purchase-id set, so re-deriving it from these exact stuck rows
// reaches the SAME Stripe payout Stripe already recorded, rather than
// creating a duplicate. Exported for direct testing, same reasoning as
// claimPurchasesForPayout/sellerPayoutIdempotencyKey above.
export async function claimOrResumeSellerPayout(db, sellerId) {
  const { results: claimed } = await db.prepare(`
    SELECT * FROM purchases
    WHERE seller_id = ? AND payment_intent_id IS NOT NULL
      AND paid_out_at IS NOT NULL AND stripe_payout_id IS NULL AND refunded_at IS NULL
    ORDER BY purchase_id
  `).bind(sellerId).all();
  return { claimed, resumed: claimed.length > 0 };
}

// Companion to claimOrResumeSellerPayout — completes a previously-claimed-
// but-unconfirmed seller payout by re-deriving the same idempotency key and
// re-calling Stripe (which returns the already-issued payout instead of
// creating a new one), then finishing the DB write that didn't land the
// first time. No claim/release here: these purchases were already claimed
// by an earlier request, not this one, so there's nothing to undo on
// failure — the stuck rows simply stay stuck for the next retry, same as
// today.
async function resumeSellerPayout(env, db, sessionSeller, claimed) {
  if (!stripeConfigured(env)) {
    throw new HttpError('Stripe payouts are not configured on this server yet.', 503);
  }
  const claimedCents = claimed.reduce((sum, p) => sum + purchaseSellerShareCents(p), 0);
  const idempotencyKey = await sellerPayoutIdempotencyKey(sessionSeller.seller_id, claimed.map((p) => p.purchase_id));
  const payout = await stripeRequest(
    env, 'POST', 'payouts', { amount: claimedCents, currency: 'usd' }, idempotencyKey, sessionSeller.stripe_account_id,
  );
  await db.batch(claimed.map((purchase) =>
    db.prepare('UPDATE purchases SET stripe_payout_id = ? WHERE purchase_id = ?')
      .bind(payout.id, purchase.purchase_id)));
  return json({ payoutCents: claimedCents, purchaseCount: claimed.length, stripePayoutId: payout.id });
}

// GET returns the seller's current held/available-for-cash-out balance
// (folded into the same shape stripeAccountStatusJson already gives the
// onboarding panel, so one call covers both); POST actually triggers a
// Stripe payout for whatever's currently available. Stripe stays entirely
// invisible to the seller (#452's own Custom-account mandate) — this is
// the seller-facing surface for a concept ("my money, when can I get it")
// that otherwise only exists as raw Stripe API state.
export async function handleSellerPayouts(request, env, db) {
  const user = await requireCurrentUser(request, db);
  const sessionSeller = await getOrCreateSellerForUser(db, user);

  if (request.method === 'GET') {
    return json(await sellerPayoutSummaryJson(env, db, sessionSeller));
  }

  if (request.method === 'POST') {
    // #1050: same "real outbound Stripe API call on the shared key" gap
    // #839/#948 already closed for the stripe-account handlers above —
    // this POST branch (both the stuck-claim resume path below and the
    // ordinary payout path further down) makes real Stripe balance/payouts
    // calls, so it needs the identical guard. Ahead of everything else in
    // this branch, same placement precedent as #948.
    await checkRateLimit(db, `seller-payout:${sessionSeller.seller_id}`, STRIPE_RATE_LIMIT_MAX);
    // #969: a stuck claimed-but-unconfirmed purchase (paid_out_at set,
    // stripe_payout_id still NULL) is invisible to unpaidSellerPurchases
    // just below (it filters paid_out_at IS NULL) -- this has to run before
    // that call and the availableCents check, not just before the Stripe
    // config/onboarding checks further down, or a seller whose entire
    // unpaid balance is stuck would see a misleading "nothing available"
    // error instead of ever being resumed.
    const { claimed: stuckClaimed, resumed } = await claimOrResumeSellerPayout(db, sessionSeller.seller_id);
    if (resumed) {
      return resumeSellerPayout(env, db, sessionSeller, stuckClaimed);
    }

    const purchases = await unpaidSellerPurchases(db, sessionSeller.seller_id);
    const eligible = purchases.filter(isPurchaseEligibleForPayout);
    const availableCents = eligible.reduce((sum, p) => sum + purchaseSellerShareCents(p), 0);
    if (availableCents <= 0) {
      throw new HttpError('Nothing is available to cash out yet.', 400);
    }

    // #615 (sub-issue of #350): once this account's combined higgles +
    // real-money gross income for the year crosses the #613 reporting
    // threshold with no W-9/W-8BEN on file (#614), block access to the
    // *excess* above the line — not the whole balance, per the owner's own
    // Control Room framing. This is a real-money-only gate for now —
    // higgles spend/withdrawal isn't gated here, even though both actions
    // exist elsewhere in this codebase: an auction win *does* atomically
    // debit the winning bidder's own balance (#629, see resolveAuction),
    // and #349's higgle-to-cash redemption *is* built (#625,
    // handleBuilderRedeem) and, as of #653, no longer paused.
    // #615's own scoping left extending this tax gate to cover either of
    // those as an explicit open question, not yet resolved. Computed
    // before the Stripe-configuration/onboarding checks below so a caller
    // who's already fully over the line without paperwork gets this
    // specific error rather than an unrelated 503/400 masking it.
    const builder = await getOrCreateBuilderForUser(db, user);
    const taxYear = new Date().getUTCFullYear();
    const grossIncome = await annualGrossIncome(
      db, { builderId: builder.builder_id, sellerId: sessionSeller.seller_id }, taxYear,
    );
    const hasTaxPaperworkOnFile = !!user.tax_form_completed_at;
    // annualGrossIncome's own sellerPayoutCents sums total_cents for every
    // real-money purchase this year regardless of paid_out_at, so it
    // already includes this exact `eligible` pool's own gross — subtract
    // that back out to isolate everything this payout would be stacked on
    // top of (higgles, held/ineligible purchases, and anything already
    // paid out this year). `eligible` itself has no year filter (drawn
    // from unpaidSellerPurchases, so a prior-year purchase that only just
    // became eligible can be in it) — restrict the subtraction to this
    // same [yearStart, yearEnd) window annualGrossIncome used, or a
    // cross-year purchase's total gets subtracted from a total that never
    // included it, understating otherEarnedCents and letting real
    // current-year income slip past the #615 reporting-threshold gate.
    const yearStart = `${taxYear}-01-01T00:00:00.000Z`;
    const yearEnd = `${taxYear + 1}-01-01T00:00:00.000Z`;
    const eligibleGrossCents = eligible
      .filter((p) => p.created_at >= yearStart && p.created_at < yearEnd)
      .reduce((sum, p) => sum + p.total_cents, 0);
    const otherEarnedCents = grossIncome.totalCents - eligibleGrossCents;
    const taxBudgetCents = hasTaxPaperworkOnFile
      ? Infinity
      : Math.max(0, TAX_REPORTING_THRESHOLD_CENTS - otherEarnedCents);
    if (taxBudgetCents <= 0) {
      throw taxThresholdPayoutBlockedError();
    }

    if (!stripeConfigured(env)) {
      throw new HttpError('Stripe payouts are not configured on this server yet.', 503);
    }
    if (!sessionSeller.stripe_account_id || sessionSeller.stripe_onboarding_status !== 'complete') {
      throw new HttpError('Complete Stripe onboarding before requesting a payout.', 400);
    }

    // Our own hold is a policy gate layered on top of Stripe's own
    // funds-availability delay (a transfer typically takes a couple of
    // days before it even shows up as "available" on the connected
    // account's own balance) — capping at Stripe's own reported available
    // balance avoids requesting a payout Stripe would reject outright
    // because the money technically hasn't cleared on their side yet,
    // even though our own hold already lifted.
    const balance = await stripeRequest(env, 'GET', 'balance', undefined, undefined, sessionSeller.stripe_account_id);
    const stripeAvailableCents = (balance.available || []).find((b) => b.currency === 'usd')?.amount ?? 0;
    const payoutCapCents = Math.min(availableCents, stripeAvailableCents);

    // Payouts are per-whole-purchase, not fractional — only mark a
    // purchase paid out if its own share genuinely fit inside what Stripe
    // will actually let us withdraw right now, and its own gross still
    // fits inside the tax-threshold headroom computed above; anything left
    // over just stays "available" for a later cash-out request (once more
    // Stripe balance clears, or once paperwork is filed). Extracted to its
    // own function (rather than inlined here) for the same reason
    // claimPurchasesForPayout is its own function -- this suite never
    // configures STRIPE_SECRET_KEY, so nothing past the stripeConfigured
    // check above (including this selection logic) is reachable through
    // the real endpoint; testing the primitive directly is the only way to
    // cover it at all, same precedent as that function's own comment.
    const { included, payoutCents, skippedForTax } = selectPurchasesForPayout(
      eligible, { payoutCapCents, taxBudgetCents, yearStart, yearEnd },
    );
    if (included.length === 0) {
      if (skippedForTax) throw taxThresholdPayoutBlockedError();
      throw new HttpError('Funds are still clearing with Stripe — try again soon.', 400);
    }

    // Claimed BEFORE calling Stripe, not after — the actual money-moving
    // call only ever fires for purchases this request itself won the claim
    // on, so a concurrent request racing the same purchases can never
    // trigger a second real Stripe payout for them (see
    // claimPurchasesForPayout's own comment).
    const nowIso = new Date().toISOString();
    const claimed = await claimPurchasesForPayout(db, included, nowIso);
    if (claimed.length === 0) {
      throw new HttpError('Funds are still clearing with Stripe — try again soon.', 400);
    }
    const claimedCents = claimed.reduce((sum, p) => sum + purchaseSellerShareCents(p), 0);

    let payout;
    try {
      const idempotencyKey = await sellerPayoutIdempotencyKey(sessionSeller.seller_id, claimed.map((p) => p.purchase_id));
      payout = await stripeRequest(
        env, 'POST', 'payouts', { amount: claimedCents, currency: 'usd' }, idempotencyKey, sessionSeller.stripe_account_id,
      );
    } catch (err) {
      // The claim above already stamped paid_out_at — undo it so a failed
      // attempt doesn't strand these purchases as permanently unclaimable
      // with no actual payout behind them.
      await releasePurchaseClaim(db, claimed, nowIso);
      throw err;
    }
    await db.batch(claimed.map((purchase) =>
      db.prepare('UPDATE purchases SET stripe_payout_id = ? WHERE purchase_id = ?')
        .bind(payout.id, purchase.purchase_id)));

    return json({ payoutCents: claimedCents, purchaseCount: claimed.length, stripePayoutId: payout.id });
  }

  return json({ error: 'Not found' }, 404);
}

// #612 (sub-issue of #350): foundational annual gross-income aggregation
// for the eventual 1099-K/1099-NEC tax-reporting pipeline (docs/SPEC.md
// §7) — reads two ledgers that already exist rather than introducing new
// storage: the higgles commission a builder earns (higgles_earnings_events,
// migrations/0050) and the real-money side of `purchases`
// (migrations/0051/0072). No PII lives here at all — W-9/W-8BEN collection
// (#614), the earnings gate (#615), and actual form generation (#616) are
// later sub-issues that build on this.
//
// sellerPayoutCents sums total_cents (the full buyer-paid amount), not the
// seller's own net share after commission — Form 1099-K's own "gross
// amount" instructions define gross as the full transaction amount
// "without regard to any adjustments... for fees" (see #350's own
// scoping comment), so the commission this platform keeps is not netted
// out here even though it never reaches the seller's own balance.
// Refunded purchases are excluded (never a completed transaction to
// report); simulated (non-Stripe) purchases are excluded via the
// payment_intent_id check, same as unpaidSellerPurchases above.

// #613: the federal 1099-K reporting threshold, post-OBBBA-rollback
// ($20,000; the $600 ARPA threshold was reversed) — see #350's own
// research comment. Applied here to the *combined* higgles+real-money
// total per the owner's own Control Room direction ("if builders' higgles
// and sellers' earned dollars get lumped into the same taxation category,
// it makes sense for them to share a reporting pipeline"), even though the
// real 1099-K threshold technically has a second leg (200 transactions)
// that only applies to the card-settled seller side, and the correct
// threshold/form for the higgles side specifically still needs a tax
// professional's confirmation (also per #350's comment). This is
// deliberately just a soft, non-blocking notice signal (see #615 for
// actual gating) — not itself a legal determination of when paperwork is
// required, so approximating with one combined dollar figure is an
// acceptable simplification here even though it wouldn't be for #616's
// actual form generation.
const TAX_REPORTING_THRESHOLD_CENTS = 20_000_00;

// #645 (sub-issue of #616): 1099-NEC's own standard nonemployee-
// compensation threshold ($600/payee/year) -- a much lower, and
// different, bar than TAX_REPORTING_THRESHOLD_CENTS just above, which is
// specifically the 1099-K (card/TPSO-settled) dollar threshold. #613's
// own combined-income notice deliberately approximates with one shared
// threshold (see that constant's own comment on why that's fine for a
// soft heads-up) -- but #645 actually generates form records, so it uses
// the correct, distinct threshold per form type instead of reusing the
// approximation.
const TAX_1099_NEC_THRESHOLD_CENTS = 600_00;

// #615's own payout-blocked error, shared by both places handleSellerPayouts
// can hit it (fully over the line before ever building a payout, or the
// tax-budget cap leaving nothing includable once Stripe's own cap is also
// applied) — see that function's own comment.
function taxThresholdPayoutBlockedError() {
  return new HttpError(
    `Your combined earnings this year have reached the ${formatCents(TAX_REPORTING_THRESHOLD_CENTS)} tax-reporting `
    + 'threshold. Submit your W-9/W-8BEN tax paperwork (POST /api/tax/id-form) before withdrawing further earnings.',
    403,
  );
}

// Three progressive, non-blocking breakpoints (#613's own "50%/80%/100%"
// scope) — 'crossed' doesn't gate anything by itself (see #615), it's
// just the highest notice level.
function taxNoticeLevel(totalCents, thresholdCents) {
  if (thresholdCents <= 0) return 'none';
  const ratio = totalCents / thresholdCents;
  if (ratio >= 1) return 'crossed';
  if (ratio >= 0.8) return 'approaching';
  if (ratio >= 0.5) return 'early';
  return 'none';
}

async function annualGrossIncome(db, { builderId, sellerId }, year) {
  const yearStart = `${year}-01-01T00:00:00.000Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00.000Z`;
  const [higglesRow, payoutRow] = await Promise.all([
    db.prepare(`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM higgles_earnings_events
      WHERE builder_id = ? AND created_at >= ? AND created_at < ?
    `).bind(builderId, yearStart, yearEnd).first(),
    sellerId
      ? db.prepare(`
          SELECT COALESCE(SUM(total_cents), 0) AS total FROM purchases
          WHERE seller_id = ? AND payment_intent_id IS NOT NULL AND refunded_at IS NULL
            AND created_at >= ? AND created_at < ?
        `).bind(sellerId, yearStart, yearEnd).first()
      : Promise.resolve({ total: 0 }),
  ]);
  const totalCents = higglesRow.total + payoutRow.total;
  return {
    year,
    builderHigglesCents: higglesRow.total,
    sellerPayoutCents: payoutRow.total,
    totalCents,
    thresholdCents: TAX_REPORTING_THRESHOLD_CENTS,
    noticeLevel: taxNoticeLevel(totalCents, TAX_REPORTING_THRESHOLD_CENTS),
  };
}

function queryTaxYear(value) {
  if (value === null) return new Date().getUTCFullYear();
  if (!/^\d{4}$/.test(value)) throw new HttpError('year must be a 4-digit year', 400);
  const year = Number(value);
  if (year < 2000 || year > 2100) throw new HttpError('year must be a 4-digit year', 400);
  return year;
}

// #645 (sub-issue of #616): creates or refreshes one draft 1099 form
// record. The `WHERE tax_1099_forms.status = 'draft'` on the DO UPDATE
// branch is deliberate, not decorative -- once an admin has approved (or
// a form has been filed/voided), this must never silently overwrite its
// locked-in gross_income_cents snapshot just because more income posted
// later in the year; a conflicting upsert on a non-draft row is a no-op.
async function upsertTax1099Draft(db, { userId, taxYear, formType, grossIncomeCents, generatedAt }) {
  await db.prepare(`
    INSERT INTO tax_1099_forms (form_id, user_id, tax_year, form_type, status, gross_income_cents, generated_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
    ON CONFLICT (user_id, tax_year, form_type) DO UPDATE SET
      gross_income_cents = excluded.gross_income_cents,
      updated_at = excluded.updated_at
    WHERE tax_1099_forms.status = 'draft'
  `).bind(`tax1099-${crypto.randomUUID()}`, userId, taxYear, formType, grossIncomeCents, generatedAt, generatedAt).run();
}

// #645: finds every account whose income for `year` crosses the relevant
// per-form threshold and creates/refreshes a draft record for it. Only
// considers builders/sellers actually linked to a real login (`user_id
// IS NOT NULL`, migrations/0054) -- an orphaned pre-real-accounts profile
// has nobody to send a tax form to.
//
// Deliberately two separate queries/thresholds rather than reusing
// annualGrossIncome's combined total: a 1099-K only concerns the
// TPSO-settled seller side (compared against the real $20,000 federal
// dollar leg -- the 200-transaction leg and any lower state thresholds
// are NOT modeled here, a known gap flagged in #645's own GitHub issue
// rather than silently guessed at), and a 1099-NEC only concerns the
// higgle-commission side, compared against its own, much lower, standard
// nonemployee-compensation threshold.
async function generateTax1099Drafts(db, year) {
  const yearStart = `${year}-01-01T00:00:00.000Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00.000Z`;
  const generatedAt = new Date().toISOString();

  const [necRows, kRows] = await Promise.all([
    db.prepare(`
      SELECT b.user_id AS user_id, SUM(e.amount_cents) AS total
      FROM higgles_earnings_events e JOIN builders b ON b.builder_id = e.builder_id
      WHERE b.user_id IS NOT NULL AND e.created_at >= ? AND e.created_at < ?
      GROUP BY b.user_id HAVING total >= ?
    `).bind(yearStart, yearEnd, TAX_1099_NEC_THRESHOLD_CENTS).all(),
    db.prepare(`
      SELECT s.user_id AS user_id, SUM(p.total_cents) AS total
      FROM purchases p JOIN sellers s ON s.seller_id = p.seller_id
      WHERE s.user_id IS NOT NULL AND p.payment_intent_id IS NOT NULL AND p.refunded_at IS NULL
        AND p.created_at >= ? AND p.created_at < ?
      GROUP BY s.user_id HAVING total >= ?
    `).bind(yearStart, yearEnd, TAX_REPORTING_THRESHOLD_CENTS).all(),
  ]);

  await Promise.all([
    ...necRows.results.map((row) => upsertTax1099Draft(db, {
      userId: row.user_id, taxYear: year, formType: '1099-nec', grossIncomeCents: row.total, generatedAt,
    })),
    ...kRows.results.map((row) => upsertTax1099Draft(db, {
      userId: row.user_id, taxYear: year, formType: '1099-k', grossIncomeCents: row.total, generatedAt,
    })),
  ]);

  await pruneStaleTax1099Drafts(db, year, yearStart, yearEnd);
}

// #2214: a draft's gross_income_cents is only ever set by the upsert above,
// which only runs for payees the two threshold queries above still return.
// If enough of a payee's non-refunded income gets refunded after their
// draft was created to drop their live total back under the threshold,
// they stop appearing in those queries entirely -- the draft they already
// have just sits there forever with its original, now-overstated total,
// since nothing was ever written to shrink or remove it. No 1099 is
// actually required once income falls back under the reporting threshold,
// so any remaining 'draft' row (never 'approved'/'filed'/'voided' --
// upsertTax1099Draft's own WHERE guard already protects those) whose live,
// refund-aware total no longer meets its own form type's threshold gets
// deleted outright, the same as if it had never qualified in the first
// place.
async function pruneStaleTax1099Drafts(db, year, yearStart, yearEnd) {
  const [staleNec, staleK] = await Promise.all([
    db.prepare(`
      SELECT f.form_id FROM tax_1099_forms f
      LEFT JOIN (
        SELECT b.user_id AS user_id, SUM(e.amount_cents) AS total
        FROM higgles_earnings_events e JOIN builders b ON b.builder_id = e.builder_id
        WHERE b.user_id IS NOT NULL AND e.created_at >= ? AND e.created_at < ?
        GROUP BY b.user_id
      ) live ON live.user_id = f.user_id
      WHERE f.tax_year = ? AND f.form_type = '1099-nec' AND f.status = 'draft'
        AND COALESCE(live.total, 0) < ?
    `).bind(yearStart, yearEnd, year, TAX_1099_NEC_THRESHOLD_CENTS).all(),
    db.prepare(`
      SELECT f.form_id FROM tax_1099_forms f
      LEFT JOIN (
        SELECT s.user_id AS user_id, SUM(p.total_cents) AS total
        FROM purchases p JOIN sellers s ON s.seller_id = p.seller_id
        WHERE s.user_id IS NOT NULL AND p.payment_intent_id IS NOT NULL AND p.refunded_at IS NULL
          AND p.created_at >= ? AND p.created_at < ?
        GROUP BY s.user_id
      ) live ON live.user_id = f.user_id
      WHERE f.tax_year = ? AND f.form_type = '1099-k' AND f.status = 'draft'
        AND COALESCE(live.total, 0) < ?
    `).bind(yearStart, yearEnd, year, TAX_REPORTING_THRESHOLD_CENTS).all(),
  ]);

  const staleFormIds = [...staleNec.results, ...staleK.results].map((row) => row.form_id);
  if (staleFormIds.length === 0) return;
  await db.batch(staleFormIds.map((formId) => db.prepare(
    `DELETE FROM tax_1099_forms WHERE form_id = ? AND status = 'draft'`,
  ).bind(formId)));
}

// ---- 1099 e-filing transmission (#646, sub-issue of #616/#350) —
// TaxBandits is the reference vendor (per #646's own body and this
// board's Track1099/TaxBandits sandbox research), same guarded-secret
// shape as STRIPE_SECRET_KEY/DIDIT_API_KEY above: no session can create
// the vendor account itself (that needs the owner's own business/EIN
// details, same as every other vendor here), so with any of these unset
// (never configured in local dev or the automated test suite),
// tax1099EfilingConfigured(env) is false and the filing route below
// returns a real 503 rather than a half-working live call. Bundles the
// vendor credentials AND the platform's own payer identity into one
// guard, since filing needs both and neither exists without direct owner
// action.
//
// Corrected against TaxBandits' own published docs (developer.taxbandits.com
// /docs/sandbox/overview, /docs/oauth2.0authentication) once the owner
// actually had a Sandbox developer account to check against — the original
// pass had three bugs, now fixed below: TAX_1099_EFILING_API_BASE pointed at
// the Sandbox *console* host (sandbox.taxbandits.com, a web UI) instead of
// the actual Sandbox *API* host (testapi.taxbandits.com); the OAuth JWS's
// `aud` claim needs the account's own User Token value, not the literal
// string "UserToken" (there was no secret for it at all); and the JWS must
// be sent in a header literally named `authentication`, not `authorization`.
//
// STILL UNVERIFIED against a live call: no session has real credentials to
// exercise this against TaxBandits' actual Sandbox API, so treat this as
// doc-verified but not call-verified — confirm the first real Sandbox filing
// end-to-end once TAX_1099_EFILING_* secrets are set, before ever pointing
// it at the Live hosts (see the two consts below).
// Split out from tax1099EfilingConfigured below so the connection-test route
// can check just the vendor credentials (enough to exercise the previously-
// unverified OAuth handshake) without also requiring TAX_1099_PAYER_NAME/
// _EIN -- the owner's own platform payer identity, which needs a real EIN/
// business name that may not exist yet even once vendor credentials do.
function tax1099EfilingCredentialsConfigured(env) {
  return !!(env.TAX_1099_EFILING_CLIENT_ID && env.TAX_1099_EFILING_CLIENT_SECRET && env.TAX_1099_EFILING_USER_TOKEN);
}

function tax1099EfilingConfigured(env) {
  return !!(tax1099EfilingCredentialsConfigured(env) && env.TAX_1099_PAYER_NAME && env.TAX_1099_PAYER_EIN);
}

// Sandbox hosts (a free, separate developer account signed up for at
// sandbox.taxbandits.com — distinct from the regular taxbandits.com filing
// account used to actually e-file). Once the owner is certified for Live
// (which also requires TaxBandits to whitelist this Worker's outbound IPs —
// confirm with TaxBandits support how that works for a Cloudflare Workers
// deployment, since it has no single static egress IP), swap these two for
// the Live hosts: 'https://oauth.expressauth.net/v2/tbsauth' and
// 'https://api.taxbandits.com/v1.7.3'.
const TAX_1099_EFILING_TOKEN_URL = 'https://testoauth.expressauth.net/v2/tbsauth';
const TAX_1099_EFILING_API_BASE = 'https://testapi.taxbandits.com/v1.7.3';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// TaxBandits' OAuth2 flow signs a JWS (HS256) with the client secret and
// GETs it to a dedicated token endpoint, rather than a standard
// client-credentials POST — see developer.taxbandits.com/docs/
// apireference/OAuth2.0Authentication. Built fresh per call (tokens
// expire in ~1h per their docs; admin-only filing calls are expected to
// be sparse enough that this codebase doesn't cache one across requests).
// `aud` is the account's own User Token (Sandbox/Live console → Settings →
// API Credentials), not a placeholder string — TaxBandits rejects the
// handshake otherwise. The JWS itself goes in a header literally named
// `authentication` (not `authorization`); TaxBandits' token endpoint reads
// that header specifically per their published docs.
async function fetchTax1099EfilingToken(env) {
  const encoder = new TextEncoder();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    iss: env.TAX_1099_EFILING_CLIENT_ID,
    sub: env.TAX_1099_EFILING_CLIENT_ID,
    aud: env.TAX_1099_EFILING_USER_TOKEN,
    iat: Math.floor(Date.now() / 1000),
  })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.TAX_1099_EFILING_CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned));
  const jws = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
  const response = await fetch(TAX_1099_EFILING_TOKEN_URL, { headers: { authentication: jws } });
  // #2486: .catch(() => null), same as tripoRequest/tripoUploadFile -- an
  // upstream gateway error page makes response.json() itself throw before
  // the !response.ok check below ever runs, otherwise surfacing as an
  // uncaught 500 instead of this function's own intended 502.
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.AccessToken) {
    throw new HttpError(data?.StatusMessage || '1099 e-filing authentication failed', 502);
  }
  return data.AccessToken;
}

// Assembles and transmits one form, returning the vendor's own submission
// reference to store as filing_reference. payeeTaxId is the decrypted
// W-9/W-8BEN payload from decryptTaxIdPayload — never logged or returned,
// only forwarded to the vendor over HTTPS.
async function transmitTax1099Form(env, { form, payeeEmail, payeeTaxId }) {
  const accessToken = await fetchTax1099EfilingToken(env);
  const endpoint = form.form_type === '1099-nec' ? 'Form1099NEC' : 'Form1099K';
  const body = {
    SubmissionManifest: { TaxYear: String(form.tax_year), IsFederalFiling: true },
    ReturnHeader: {
      Business: {
        BusinessNm: env.TAX_1099_PAYER_NAME,
        EIN: env.TAX_1099_PAYER_EIN,
      },
    },
    ReturnData: [{
      Payee: {
        TINType: payeeTaxId.formType === 'w9' ? 'SSN' : 'FOREIGNTIN',
        TIN: payeeTaxId.taxIdNumber || payeeTaxId.foreignTaxId,
        PayeeName: payeeTaxId.legalName,
        Email: payeeEmail,
        Address: {
          Line1: payeeTaxId.addressLine1,
          City: payeeTaxId.city,
          State: payeeTaxId.state,
          ZipCd: payeeTaxId.postalCode,
          CountryCd: payeeTaxId.country || 'US',
        },
      },
      NonEmployeeCompensation: form.form_type === '1099-nec' ? (form.gross_income_cents / 100) : undefined,
      GrossAmountOfPayments: form.form_type === '1099-k' ? (form.gross_income_cents / 100) : undefined,
    }],
  };
  const response = await fetch(`${TAX_1099_EFILING_API_BASE}/${endpoint}/Create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // #2486: .catch(() => null), same as tripoRequest/tripoUploadFile -- an
  // upstream gateway error page makes response.json() itself throw before
  // the !response.ok check below ever runs, otherwise surfacing as an
  // uncaught 500 instead of this function's own intended 502. Orthogonal to
  // #1475's own ambiguous-post-transmission-failure question (whether the
  // vendor actually received this submission before failing) -- this only
  // changes an unparseable response from a raw 500 into the same clean 502
  // every other failure here already gets, not what a 502 then implies.
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.SubmissionId) {
    throw new HttpError(data?.StatusMessage || '1099 e-filing transmission failed', 502);
  }
  return data.SubmissionId;
}

// GET returns the current user's combined gross-income summary (higgles
// commissions from their builder profile, real-money payouts from their
// seller profile if they have one) for a given calendar year, defaulting
// to the current one — the account-level "two sources, shown separately
// with a total" view #350's own Control Room direction asked for. A user
// with no seller profile yet just gets sellerPayoutCents: 0, the same as
// any other builder who's never sold anything.
// #2082: the admin-forms approve/file/void trio fires real outbound
// 1099-e-filing-vendor calls (/file, via transmitTax1099Form) on the shared
// TAX_1099_EFILING credentials, the same "real outbound vendor call on a
// shared key" shape STRIPE_RATE_LIMIT_MAX's own callers (handlePurchaseRefund
// etc.) already guard — being requireAdmin-gated doesn't exempt it, same as
// mark-shipped/self-dealing-flag-review/account-suspension are all
// admin-gated and still rate-limited. NOT this file's usual 20 (the issue's
// own text explicitly warns against reusing an existing constant "scoped to
// a different caller shape" verbatim): unlike a single seller's own refund/
// dispute actions, reviewing 1099s is a real, legitimate *batch* admin
// workflow -- worker/seller-payouts-and-tax.test.js's own pre-existing
// "1099 e-filing transmission" suite alone fires 22 real approve/void/file
// calls from one shared admin well within any 15-minute window, and a human
// admin clearing a tax-season backlog is realistically doing the same. 20
// would make that workflow itself trip the guard it's meant to bound abuse
// of, not the admin's own ordinary use of the feature. 100 still fully
// closes the original gap (unbounded -> bounded) while leaving headroom for
// a real bulk-review session.
const TAX_1099_ADMIN_RATE_LIMIT_MAX = 100;

export async function handleTax(request, env, db, route, url) {
  const user = await requireCurrentUser(request, db);
  if (request.method === 'GET' && route.length === 2 && route[1] === 'summary') {
    const builder = await getOrCreateBuilderForUser(db, user);
    const seller = await db.prepare('SELECT * FROM sellers WHERE user_id = ?').bind(user.user_id).first();
    const year = queryTaxYear(url.searchParams.get('year'));
    const summary = await annualGrossIncome(
      db, { builderId: builder.builder_id, sellerId: seller?.seller_id ?? null }, year,
    );
    return json(summary);
  }
  if (request.method === 'POST' && route.length === 2 && route[1] === 'id-form') {
    return handleTaxIdForm(request, env, db, user);
  }
  // #646 follow-up: lets an admin confirm the vendor OAuth handshake works
  // against real (Sandbox) credentials the moment they're set as Worker
  // secrets, without needing TAX_1099_PAYER_NAME/_EIN or an approved form on
  // file first -- those gate actually transmitting a filing, not the token
  // exchange itself. Exists specifically because the original integration's
  // JWS/OAuth request shape was doc-verified but never call-verified (see
  // fetchTax1099EfilingToken's own comment); this is that verification,
  // safe to call repeatedly since it performs no filing and touches no user
  // data, only a stateless handshake against TaxBandits' own token endpoint.
  if (request.method === 'GET' && route.length === 2 && route[1] === 'efiling-connection-test') {
    if (!user.is_admin) throw new HttpError('Admin access required', 403);
    if (!tax1099EfilingCredentialsConfigured(env)) {
      throw new HttpError('1099 e-filing vendor credentials are not configured on this server yet.', 503);
    }
    await fetchTax1099EfilingToken(env);
    return json({ connected: true });
  }
  // #645: admin-only review list -- (re-)generates draft 1099 records for
  // the requested year, then returns every form on file for it, so an
  // admin viewing this always sees a fresh snapshot rather than a stale
  // one from whenever generation last ran. See generateTax1099Drafts'
  // own comment on why a conflicting draft never overwrites an
  // already-approved/filed/voided row.
  if (request.method === 'GET' && route.length === 2 && route[1] === 'admin-forms') {
    if (!user.is_admin) throw new HttpError('Admin access required', 403);
    // #2130: generateTax1099Drafts below runs two full-table aggregate
    // GROUP BY scans plus a real upsert write per qualifying builder/
    // seller on every call -- the same "real DB cost" shape #2082 already
    // rate-limited for this handler's three mutation siblings (approve/
    // file/void), just unconditional here on every GET instead of behind
    // an admin action. Not the efiling-connection-test branch just above,
    // whose own comment explicitly says it's safe to call repeatedly.
    await checkRateLimit(db, `tax-1099-admin:${user.user_id}`, TAX_1099_ADMIN_RATE_LIMIT_MAX);
    const year = queryTaxYear(url.searchParams.get('year'));
    await generateTax1099Drafts(db, year);
    // #1147: LEFT JOIN, not JOIN -- user_id can now be NULL (the payee's
    // account was deleted; see migrations/0103), and an approved/filed
    // form must keep showing up here regardless, via its own snapshot
    // columns. COALESCE prefers the form's own snapshot (set once at
    // /approve) over the live users row, since the snapshot is what was
    // actually true at approval time; a still-'draft' form has no
    // snapshot yet, so it falls back to the live row.
    const rows = await db.prepare(`
      SELECT f.*, COALESCE(f.payee_email, u.email) AS email,
        COALESCE(f.payee_tax_form_type, u.tax_form_type) AS tax_form_type
      FROM tax_1099_forms f LEFT JOIN users u ON u.user_id = f.user_id
      WHERE f.tax_year = ? ORDER BY email, f.form_type
    `).bind(year).all();
    return json({
      year,
      forms: rows.results.map((row) => ({
        formId: row.form_id,
        userId: row.user_id,
        email: row.email,
        formType: row.form_type,
        status: row.status,
        grossIncomeCents: row.gross_income_cents,
        taxPaperworkOnFile: Boolean(row.tax_form_type),
        taxFormType: row.tax_form_type,
        generatedAt: row.generated_at,
        approvedAt: row.approved_at,
        filedAt: row.filed_at,
        filingReference: row.filing_reference,
        updatedAt: row.updated_at,
      })),
    });
  }
  // #645: the review half of "review UI" -- signs off on a draft so it's
  // ready for #646's e-filing transmission to pick up. Requires the
  // payee's own W-9/W-8BEN paperwork (#614) to actually be on file first
  // — approving a form for someone who hasn't submitted tax ID yet would
  // create a filable-looking record with nothing behind it to transmit.
  // The status='draft' guard on the UPDATE itself (not just the earlier
  // read) is the same atomic check-then-act idiom this codebase already
  // uses for auction bids/purchase claims — a second concurrent approval
  // of the same form is a no-op, not a double-approval.
  if (request.method === 'POST' && route.length === 4 && route[1] === 'admin-forms' && route[3] === 'approve') {
    if (!user.is_admin) throw new HttpError('Admin access required', 403);
    await checkRateLimit(db, `tax-1099-admin:${user.user_id}`, TAX_1099_ADMIN_RATE_LIMIT_MAX);
    const formId = route[2];
    const form = await db.prepare('SELECT * FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    if (!form) throw new HttpError('Tax form not found', 404);
    if (form.status !== 'draft') throw new HttpError(`Cannot approve a form in status "${form.status}"`, 409);
    const payee = await db.prepare('SELECT email, tax_form_completed_at, tax_id_encrypted, tax_form_type FROM users WHERE user_id = ?').bind(form.user_id).first();
    if (!payee?.tax_form_completed_at) {
      throw new HttpError("Cannot approve: this payee has no W-9/W-8BEN tax paperwork on file yet", 409);
    }
    const approvedAt = new Date().toISOString();
    // #1147: snapshot the payee's email/tax ID/form type onto the form
    // itself, the one point this flow already confirms real paperwork is
    // on file. This is what keeps the form reviewable and filable after
    // user_id goes NULL (migrations/0103, ON DELETE SET NULL) -- /file
    // below reads these snapshot columns instead of looking the payee up
    // live, so an account deletion after approval can't strand an
    // already-approved form with nothing left to transmit.
    // #897: this UPDATE's own status='draft' guard means it can legitimately
    // affect 0 rows (a concurrent approval already won), unlike grant-admin's
    // unconditional write -- batching the log INSERT with it would commit a
    // log row for an approval that never happened, since db.batch() commits
    // every statement as long as none errors (0 rows changed isn't an
    // error). Same "logged only after confirmed" idiom delete_land_candidate
    // already uses for the identical reason.
    const result = await db.prepare(`
      UPDATE tax_1099_forms SET status = 'approved', approved_at = ?, updated_at = ?,
        payee_email = ?, payee_tax_id_encrypted = ?, payee_tax_form_type = ?
      WHERE form_id = ? AND status = 'draft'
    `).bind(approvedAt, approvedAt, payee.email, payee.tax_id_encrypted, payee.tax_form_type, formId).run();
    if (result.meta.changes === 0) throw new HttpError('Tax form was no longer a draft', 409);
    await adminActionLogStatement(db, user.user_id, 'approve_1099_form', 'tax_1099_form', formId, {
      formType: form.form_type, taxYear: form.tax_year, payeeUserId: form.user_id,
    }).run();
    return json({ formId, status: 'approved', approvedAt });
  }
  // #646: the actual e-filing transmission #645's review flow was built to
  // feed into. Requires the form to already be 'approved' (the admin
  // reviewer already confirmed the payee's paperwork is on file at that
  // step) and both taxIdEncryptionConfigured (to decrypt it) and
  // tax1099EfilingConfigured (to have somewhere to send it) — same
  // guarded-secret 503 as every other unconfigured vendor integration
  // here, not a silent no-op.
  // #1410: transmitTax1099Form is a real, irreversible outbound call to
  // the e-filing vendor -- a status='approved' guard on the UPDATE
  // *after* that call only serializes the database row, not the external
  // side effect, so two concurrent /file requests could both pass the
  // pre-check above and both transmit the same form (two distinct federal
  // filings). Claiming the row (status -> 'filing') *before* the
  // transmission closes that window the same way claimOrResumeSellerPayout/
  // claimPurchasesForPayout claim a payout's purchases before the real
  // Stripe call; releasing the claim back to 'approved' on failure keeps
  // the form retryable rather than stranding it.
  if (request.method === 'POST' && route.length === 4 && route[1] === 'admin-forms' && route[3] === 'file') {
    if (!user.is_admin) throw new HttpError('Admin access required', 403);
    await checkRateLimit(db, `tax-1099-admin:${user.user_id}`, TAX_1099_ADMIN_RATE_LIMIT_MAX);
    const formId = route[2];
    const form = await db.prepare('SELECT * FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    if (!form) throw new HttpError('Tax form not found', 404);
    if (form.status !== 'approved') throw new HttpError(`Cannot file a form in status "${form.status}"`, 409);
    // #1147: read the payee's tax ID from the form's own snapshot
    // (captured at /approve, see above), not a live lookup against
    // `users` -- an approved form must stay filable even once user_id has
    // gone NULL (migrations/0103, e.g. the payee's account was since
    // deleted).
    if (!form.payee_tax_id_encrypted) throw new HttpError('Cannot file: this payee has no W-9/W-8BEN tax paperwork on file', 409);
    // Configured checks sit here, after every local validation above, so a
    // typo'd form id or a form that isn't actually ready still gets a real
    // 404/409 rather than always masking it behind a 503 — same idea as
    // the Stripe seller-account route validating its payload before ever
    // reaching stripeConfigured.
    if (!taxIdEncryptionConfigured(env)) {
      throw new HttpError('Tax-ID collection is not configured on this server yet.', 503);
    }
    if (!tax1099EfilingConfigured(env)) {
      throw new HttpError('1099 e-filing is not configured on this server yet.', 503);
    }
    const claimedAt = new Date().toISOString();
    const claim = await db.prepare(`
      UPDATE tax_1099_forms SET status = 'filing', updated_at = ?
      WHERE form_id = ? AND status = 'approved'
    `).bind(claimedAt, formId).run();
    if (claim.meta.changes === 0) throw new HttpError('Tax form was no longer approved', 409);
    let filingReference;
    try {
      const payeeTaxId = await decryptTaxIdPayload(env, form.payee_tax_id_encrypted);
      filingReference = await transmitTax1099Form(env, { form, payeeEmail: form.payee_email, payeeTaxId });
    } catch (err) {
      await db.prepare(`
        UPDATE tax_1099_forms SET status = 'approved', updated_at = ?
        WHERE form_id = ? AND status = 'filing'
      `).bind(new Date().toISOString(), formId).run();
      throw err;
    }
    const filedAt = new Date().toISOString();
    // #897: same reasoning as approve_1099_form above -- the log INSERT
    // must not be batched with the UPDATE, since a batch commits a
    // 0-rows-changed statement same as any other. Unlike before #1410's
    // fix, changes === 0 here would mean something else moved this form
    // out of 'filing' entirely (no other code path does), not a benign
    // "someone else already filed it" race -- the transmission above only
    // ever runs once per claim.
    const result = await db.prepare(`
      UPDATE tax_1099_forms SET status = 'filed', filed_at = ?, filing_reference = ?, updated_at = ?
      WHERE form_id = ? AND status = 'filing'
    `).bind(filedAt, filingReference, filedAt, formId).run();
    if (result.meta.changes === 0) throw new HttpError('Tax form claim was lost before it could be recorded as filed', 409);
    await adminActionLogStatement(db, user.user_id, 'file_1099_form', 'tax_1099_form', formId, {
      formType: form.form_type, taxYear: form.tax_year, payeeUserId: form.user_id, filingReference,
    }).run();
    return json({ formId, status: 'filed', filedAt, filingReference });
  }
  // #763: the schema (migrations/0081) has anticipated a 'voided' terminal
  // state from the start, but nothing ever set it -- an admin who approves
  // a form in error (or a draft that turns out to be wrong, e.g. a bad
  // income snapshot or a since-discovered duplicate/fraud account) had no
  // way to correct it, only /file to push it further forward. Deliberately
  // NOT reachable from 'filed': once actually transmitted to the IRS,
  // "voiding" it here would be misleading -- a real correction there needs
  // an actual corrected-1099 filing process, out of scope for this record.
  if (request.method === 'POST' && route.length === 4 && route[1] === 'admin-forms' && route[3] === 'void') {
    if (!user.is_admin) throw new HttpError('Admin access required', 403);
    await checkRateLimit(db, `tax-1099-admin:${user.user_id}`, TAX_1099_ADMIN_RATE_LIMIT_MAX);
    const formId = route[2];
    const form = await db.prepare('SELECT * FROM tax_1099_forms WHERE form_id = ?').bind(formId).first();
    if (!form) throw new HttpError('Tax form not found', 404);
    if (form.status !== 'draft' && form.status !== 'approved') {
      throw new HttpError(`Cannot void a form in status "${form.status}"`, 409);
    }
    const updatedAt = new Date().toISOString();
    // #897: same reasoning as approve_1099_form above -- this UPDATE's own
    // status IN ('draft','approved') guard can legitimately affect 0 rows,
    // so the log INSERT must not be batched with it.
    const result = await db.prepare(`
      UPDATE tax_1099_forms SET status = 'voided', updated_at = ?
      WHERE form_id = ? AND status IN ('draft', 'approved')
    `).bind(updatedAt, formId).run();
    if (result.meta.changes === 0) throw new HttpError('Tax form was no longer draft or approved', 409);
    await adminActionLogStatement(db, user.user_id, 'void_1099_form', 'tax_1099_form', formId, {
      formType: form.form_type, taxYear: form.tax_year, payeeUserId: form.user_id, previousStatus: form.status,
    }).run();
    return json({ formId, status: 'voided', updatedAt });
  }
  return json({ error: 'Not found' }, 404);
}
