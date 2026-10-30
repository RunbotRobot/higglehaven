// #2541 (sub-issue of #2502, itself sub-issue of #2500's worker/index.js
// module split): the Stripe-specific route handlers -- the webhook that
// reacts to Stripe-initiated events (account updates, chargebacks/
// refunds) and the credit-card-tier setup/confirm pair (#556) -- plus
// handlePurchaseReversalWebhookEvent, the webhook's own clawback logic.
// Extracted verbatim, zero behavior change.
//
// Deliberately NOT included here: stripeConfigured/stripeRequest/
// flattenStripeParams/STRIPE_RATE_LIMIT_MAX/deriveStripeOnboardingStatus/
// userFromRow -- each is genuinely shared well beyond this file (Stripe
// Connect onboarding, payouts, purchase checkout/refund, account/signup
// responses generally), not Stripe-webhook/card-setup specific, so they
// stay in worker/index.js and are imported back below -- same one-
// directional-except-for-genuinely-shared-state shape
// worker/lib/builder-profile.js's own comment documents for its own
// templateFromRow/recomputeLandCap imports (#2535).
import { json, HttpError } from './http.js';
import { timingSafeEqual, bytesToHex } from './crypto.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser } from './auth.js';
import { readJson, stringValue } from './validation.js';
// #2615 moved clawBackPurchaseCommission out of worker/index.js into
// worker/lib/purchase-lifecycle.js -- this webhook's own chargeback path
// still needs it, just from its new home.
import { clawBackPurchaseCommission } from './purchase-lifecycle.js';
import { fireNotification } from './notifications.js';
import {
  stripeConfigured, stripeRequest, deriveStripeOnboardingStatus, userFromRow, formatCents,
} from '../index.js';

// #1978: workerd requires every named export of the main Worker entry
// module (worker/index.js) to be a function/class binding, not a plain
// const -- confirmed the hard way, per worker/lib/builder-profile.js's own
// comment on its identical D1_MAX_BOUND_PARAMETERS duplication. Duplicated
// here rather than exported-and-imported for that reason; STRIPE_RATE_LIMIT_MAX
// in worker/index.js stays the source of truth for every handler that
// didn't move here (Stripe Connect onboarding, payouts, purchase refunds).
const STRIPE_RATE_LIMIT_MAX = 20;

// #872: Stripe's own webhook-verification guidance requires rejecting a
// signature whose timestamp is more than a few minutes old, in addition to
// the HMAC check itself -- otherwise a captured, still-cryptographically-
// valid payload (a proxy log, an exposed devtools session, a compromised
// intermediary) could be replayed against this endpoint indefinitely.
const STRIPE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// #1086: a charge can be reversed by Stripe's own initiative -- a bank
// chargeback or a dashboard-initiated refund (charge.refunded) -- entirely
// outside this app's own POST /purchases/:id/refund. Each of these event
// types' own object (a Charge or a Dispute) carries a top-level
// `payment_intent` field, the same join key handlePurchaseReversalWebhookEvent
// below looks purchases up by.
//
// #2419 (owner decision 2026-10-25): originally this list used
// charge.dispute.created/charge.dispute.closed -- but per Stripe's own
// "How disputes work" docs, charge.dispute.created also fires for a
// pre-dispute INQUIRY (a "retrieval"/"request for information", status
// `warning_*`), which never actually withdraws any funds -- only a
// escalation to a real, formal dispute does. Clawing back the full
// commission and revoking ownership grants on a mere inquiry that later
// resolves informally (no money ever moved) was wrong, with nothing that
// ever reversed it. charge.dispute.funds_withdrawn/.funds_reinstated are
// Stripe's own dedicated real-money-movement signals for a dispute --
// switching to them means this list now only ever reacts to events where
// funds actually changed hands, for a refund exactly as much as for a
// dispute.
const STRIPE_PURCHASE_REVERSAL_EVENT_TYPES = ['charge.refunded', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated'];

// #766: stripe_onboarding_status/stripe_requirements_due are only ever
// written by a seller/builder actively resubmitting the onboarding form
// (handleSellerStripeAccount/handleBuilderStripeAccount, worker/index.js)
// -- nothing ever re-checks Stripe on its own, so a previously-complete
// account that Stripe later disables (re-KYC, a compliance hold, fraud
// review) reads as "fully set up" here indefinitely, including at the
// real-money checkout-eligibility gate (handleInstancePurchase). This
// mirrors the Didit webhook (worker/lib/didit.js): Stripe signs each
// delivery as `Stripe-Signature: t=<timestamp>,v1=<hex-hmac>`
// (https://docs.stripe.com/webhooks#verify-manually), the HMAC-SHA256 is
// computed over `${timestamp}.${rawBody}` keyed by a webhook-specific
// secret, and verified via the same constant-time timingSafeEqual, never a
// plain ===. `account.updated` is handled by looking up the account id
// against both sellers and builders (a Custom account belongs to exactly
// one, never both) since the event alone doesn't say which role created
// it; #1086 added the three purchase-reversal event types below.
export async function handleStripeWebhook(request, env, db) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError('Stripe webhook is not configured on this server yet.', 503);
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('stripe-signature') || '';
  const signatureEntries = signatureHeader.split(',').map((part) => part.split('=').map((piece) => piece.trim()));
  const timestamp = signatureEntries.find(([entryKey]) => entryKey === 't')?.[1];
  // #2418: during a secret rotation Stripe keeps the old secret active for
  // up to 24h and signs each event with BOTH secrets, sending every
  // resulting v1 signature in the same header (Stripe's own "Verify
  // manually" docs) -- collapsing to a single v1 value (this used to go
  // through Object.fromEntries, which keeps only the last of any repeated
  // key) silently discarded whichever signature wasn't the header's last
  // v1 entry, rejecting a real event whenever that happened to be the one
  // actually matching this server's current secret.
  const v1Signatures = signatureEntries.filter(([entryKey]) => entryKey === 'v1').map(([, value]) => value);
  if (!timestamp || v1Signatures.length === 0) throw new HttpError('Invalid webhook signature', 401);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))));
  if (!v1Signatures.some((signature) => timingSafeEqual(signature, expectedSignature))) {
    throw new HttpError('Invalid webhook signature', 401);
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > STRIPE_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new HttpError('Invalid webhook signature', 401);
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new HttpError('Webhook body is not valid JSON', 400);
  }
  if (event.type === 'account.updated') {
    const account = event.data?.object;
    if (!account?.id) return json({ received: true });
    const status = deriveStripeOnboardingStatus(account);
    const requirementsDue = account.requirements?.currently_due || [];
    const nowIso = new Date().toISOString();
    await db.batch([
      db.prepare(`
        UPDATE sellers SET stripe_onboarding_status = ?, stripe_requirements_due = ?, stripe_updated_at = ?, updated_at = ?
        WHERE stripe_account_id = ?
      `).bind(status, JSON.stringify(requirementsDue), nowIso, nowIso, account.id),
      db.prepare(`
        UPDATE builders SET stripe_onboarding_status = ?, stripe_requirements_due = ?, stripe_updated_at = ?, updated_at = ?
        WHERE stripe_account_id = ?
      `).bind(status, JSON.stringify(requirementsDue), nowIso, nowIso, account.id),
    ]);
    return json({ received: true });
  }
  if (STRIPE_PURCHASE_REVERSAL_EVENT_TYPES.includes(event.type)) {
    await handlePurchaseReversalWebhookEvent(db, event);
  }
  return json({ received: true });
}

// Owner (Control Room, 2026-10-01, on #1086): claw back the full
// builder_share_cents the same way an ordinary refund already does,
// balance allowed to go negative -- same precedent as the 2026-09-10
// decision on #651 that handlePurchaseRefund's own comments reference.
// Whichever of a purchase's possibly-several reversal events (a retried
// webhook delivery, say) lands first wins the clawback via the same
// refunded_at-guarded update handlePurchaseRefund itself uses
// (worker/index.js); every later one for the same purchase affects 0 rows
// and is a deliberate no-op, not an error. Unlike handlePurchaseRefund,
// this never checks paid_out_at: that guard exists there to let the
// endpoint *refuse* a refund it would otherwise have to initiate itself,
// but a webhook is reporting money Stripe has already moved on its own --
// there's nothing left here to refuse by rejecting this write, only a
// payout-bookkeeping mismatch to leave for manual reconciliation
// separately (same "leave the policy call to a human" shape as
// writeOrphanedPurchaseRow's own comment elsewhere in worker/index.js).
// Known residual gap, accepted rather than solved here (owner, same
// thread): a chargeback can't be capped at REFUND_PAYOUT_RATE the way a
// self-service refund is -- the card network controls the reversed
// amount, not us -- so the fraud triangle #651 closed for ordinary
// refunds is still open for a real chargeback; tracked separately at
// #1109, not a blocker for this fix.
async function handlePurchaseReversalWebhookEvent(db, event) {
  const paymentIntentId = event.data?.object?.payment_intent;
  if (!paymentIntentId) return;
  const purchase = await db.prepare('SELECT * FROM purchases WHERE payment_intent_id = ?').bind(paymentIntentId).first();
  if (!purchase) return;

  // #2419 (owner decision 2026-10-25): charge.dispute.funds_reinstated is
  // the real-money counterpart to funds_withdrawn below -- the card
  // network returned the previously-withheld funds because the dispute
  // resolved in the merchant's favor. Handled entirely separately from
  // the clawback path below -- see handleDisputeFundsReinstatedWebhookEvent's
  // own comment for what it does and, just as importantly, what it
  // deliberately does not attempt.
  if (event.type === 'charge.dispute.funds_reinstated') {
    await handleDisputeFundsReinstatedWebhookEvent(db, purchase);
    return;
  }

  // #2232: charge.refunded fires for ANY refund on a charge, partial or
  // full -- the Charge object's own `refunded` boolean is the only
  // authoritative signal for "fully refunded" (it's true only once
  // amount_refunded reaches the full charge amount). Without this check, a
  // $1 goodwill partial refund on a $100 purchase clawed back the builder's
  // entire commission and revoked all ownership that purchase granted, the
  // same way a genuine full refund does -- even though the buyer kept 99%
  // of their payment and the product. charge.dispute.funds_withdrawn
  // carries no `refunded` field at all, so this only applies to
  // charge.refunded itself; a real withdrawal still claws back in full
  // immediately, per #1086's own deliberate design.
  //
  // #2247 (owner decision 2026-10-25): a partial refund used to just
  // `return` here, entirely invisible to this app -- see
  // handlePartialRefundWebhookEvent's own comment for what it does instead.
  if (event.type === 'charge.refunded' && event.data?.object?.refunded !== true) {
    await handlePartialRefundWebhookEvent(db, purchase, event.data.object);
    return;
  }

  // #2901: only a dispute withdrawal can later be reinstated (an ordinary
  // full charge.refunded has no reinstatement event at all), so only that
  // branch needs to preserve the pre-dispute refunded_amount_cents for
  // handleDisputeFundsReinstatedWebhookEvent to read back later -- see that
  // function's own comment and migrations/0169 for why. A plain full refund
  // leaves this NULL (its existing value, if any, from a since-resolved
  // earlier dispute cycle on this same purchase).
  const isDisputeWithdrawal = event.type === 'charge.dispute.funds_withdrawn';
  const guard = await db.prepare(
    `UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), refunded_amount_cents = ?, pre_dispute_refunded_amount_cents = ?
     WHERE purchase_id = ? AND refunded_at IS NULL`,
  ).bind(purchase.total_cents, isDisputeWithdrawal ? purchase.refunded_amount_cents : null, purchase.purchase_id).run();
  if (guard.meta.changes === 0) return;

  const template = await db.prepare('SELECT name FROM catalog_templates WHERE template_id = ?')
    .bind(purchase.template_id).first();
  await clawBackPurchaseCommission(db, purchase, template?.name || 'A product');
}

// #2419 (owner decision 2026-10-25): reverses the money side of an
// earlier charge.dispute.funds_withdrawn clawback once the card network
// actually returns the funds (the dispute resolved in the merchant's
// favor) -- credits back the same amount clawBackPurchaseCommission
// debited (same credited-vs-held math, mirrored), and un-marks the
// purchase as reversed so it's once again a normal, valid sale for
// payout/1099 purposes.
//
// Per the owner's own comment on #2419 ("likely resolves part of #2235's
// gap... as a side effect"), this is deliberately only a PARTIAL fix for
// #2235: it never attempts to restore the owned_avatar_purchases/
// owned_animation_purchases ownership grants clawBackPurchaseCommission
// already destructively DELETEd (the underlying catalog_templates row
// may not even exist anymore by now), or to un-revoke a commission_holds
// row. Both remain the known, accepted residual gap #2235's own body
// describes in detail -- reinstating money is safe and mechanical;
// reinstating ownership isn't, and still needs that issue's own design
// call.
//
// #2901: a partial refund that happened BEFORE this dispute is a separate,
// already-settled event -- the buyer keeps it permanently regardless of how
// this dispute resolves. pre_dispute_refunded_amount_cents (migrations/0169,
// written by the funds_withdrawn branch above) is that pre-dispute
// cumulative total; restoring refunded_amount_cents to it (not to 0) keeps
// worker/lib/seller-payouts-tax.js's income/payout math correctly reflecting
// that still-standing partial refund, and crediting back only creditedCents
// minus the proportional share that pre-dispute total already represents
// (the exact mirror of clawBackPurchaseCommission's own alreadyClawedBackCents)
// avoids crediting back money this dispute's own withdrawal never actually
// took in the first place.
async function handleDisputeFundsReinstatedWebhookEvent(db, purchase) {
  const preDisputeRefundedCents = purchase.pre_dispute_refunded_amount_cents || 0;
  const guard = await db.prepare(
    'UPDATE purchases SET refunded_at = NULL, refunded_amount_cents = ?, pre_dispute_refunded_amount_cents = NULL WHERE purchase_id = ? AND refunded_at IS NOT NULL',
  ).bind(preDisputeRefundedCents, purchase.purchase_id).run();
  if (guard.meta.changes === 0) return;

  if (!purchase.builder_id) return;
  // Same credited-amount math clawBackPurchaseCommission used when it
  // originally debited this -- a hold this purchase's own clawback
  // revoked (revoked_at set, the row otherwise left as-is) is the one
  // amount that was never actually credited to the builder in the first
  // place, so it's excluded from what gets credited back here too.
  const revokedHold = await db.prepare(
    'SELECT amount_cents FROM commission_holds WHERE purchase_id = ? AND revoked_at IS NOT NULL',
  ).bind(purchase.purchase_id).first();
  const creditedCents = revokedHold ? purchase.builder_share_cents - revokedHold.amount_cents : purchase.builder_share_cents;
  const alreadyClawedBackCents = purchase.total_cents > 0
    ? Math.min(creditedCents, Math.round((creditedCents * preDisputeRefundedCents) / purchase.total_cents))
    : 0;
  const creditBackCents = creditedCents - alreadyClawedBackCents;
  if (creditBackCents <= 0) return;

  await db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents + ? WHERE builder_id = ?')
    .bind(creditBackCents, purchase.builder_id).run();
  const template = await db.prepare('SELECT name FROM catalog_templates WHERE template_id = ?')
    .bind(purchase.template_id).first();
  await fireNotification(db, purchase.builder_id,
    `"${template?.name || 'A product'}" dispute resolved in your favor -- ${formatCents(creditBackCents)} commission reinstated.`);
}

// #2247 (owner decision 2026-10-25, on the issue's own open question about
// whether builder_share_cents/the builder's higgles balance should see a
// proportional clawback too, and on 1099-K gross income): "yes -- a partial
// refund should proportionally reduce the builder's payout share and
// 1099-K gross income by the refunded fraction, with a durable record of
// the adjustment (consistent with #836's refund-reversal decision for
// earnings events)." purchases.refunded_amount_cents (migrations/0166) is
// that durable record; worker/lib/seller-payouts-tax.js's
// purchaseSellerShareCents/annualGrossIncome/generateTax1099Drafts read it
// back to proportionally shrink the seller's own payout share and 1099-K
// gross income -- this function only handles the builder's commission
// side and the record itself, since those are the only two things a
// webhook event can act on directly (the seller-side numbers are derived
// lazily, not stored).
//
// charge.amount_refunded is always the charge's cumulative total refunded
// so far, not a per-event delta (a charge can be partially refunded more
// than once) -- requiring it to have grown both gives idempotency against
// a retried webhook delivery (Stripe retries any non-2xx response;
// re-delivering the same amount_refunded would otherwise double-claw-back
// the builder) and rejects a same-or-shrinking value outright, which
// should never happen for a real Stripe charge.
async function handlePartialRefundWebhookEvent(db, purchase, charge) {
  const newRefundedCents = charge.amount_refunded;
  if (typeof newRefundedCents !== 'number' || newRefundedCents <= purchase.refunded_amount_cents) return;

  // Same optimistic-concurrency shape as every other guarded purchases
  // write in this file (refunded_at above, paid_out_at elsewhere) -- if a
  // concurrent delivery of an even-newer amount_refunded already landed
  // between this function's own read and this write, this one loses and
  // no-ops; the newer delivery's own read already saw this one's value
  // (or will, on Stripe's automatic retry), so nothing is lost.
  const guard = await db.prepare(
    'UPDATE purchases SET refunded_amount_cents = ? WHERE purchase_id = ? AND refunded_at IS NULL AND refunded_amount_cents = ?',
  ).bind(newRefundedCents, purchase.purchase_id, purchase.refunded_amount_cents).run();
  if (guard.meta.changes === 0) return;

  // builder_id can be null (migrations/0062 -- SET NULL on the host
  // builder's self-delete), same guard clawBackPurchaseCommission's own
  // comment explains for the full-refund path.
  if (!purchase.builder_id || purchase.total_cents <= 0) return;

  // #1109's own commission_holds interaction (part of a sale's commission
  // may be escrowed, not yet actually credited to higgles_balance_cents)
  // applies here too -- only claw back what was actually credited, same as
  // clawBackPurchaseCommission. Unlike that function, this does NOT also
  // shrink an active hold's own amount_cents proportionally -- doing so
  // safely would need to guard against commission_holds' own
  // CHECK (amount_cents > 0) once enough cumulative partial refunds ate
  // through it, which is real but separate scope; left as a known,
  // accepted residual gap for now (same shape as #1109's own "known
  // residual gap, accepted rather than solved here").
  const activeHold = await db.prepare(
    'SELECT amount_cents FROM commission_holds WHERE purchase_id = ? AND released_at IS NULL AND revoked_at IS NULL',
  ).bind(purchase.purchase_id).first();
  const creditedCents = activeHold ? purchase.builder_share_cents - activeHold.amount_cents : purchase.builder_share_cents;
  if (creditedCents <= 0) return;
  // Clawed back as the DIFFERENCE between two cumulative proportions
  // (rounded against the full refunded total each time), not a per-event
  // delta rounded on its own -- the same cumulative-then-diff shape
  // clawBackPurchaseCommission's own #2247 comment uses for the inverse
  // direction. This keeps repeated partial refunds on the same purchase
  // exactly consistent with each other and with any later full reversal:
  // summing several independently-rounded deltas can drift a cent or two
  // off the "true" proportional total, while re-deriving each cumulative
  // total from scratch and diffing never can.
  const clawbackSoFarCents = Math.min(creditedCents, Math.round((creditedCents * purchase.refunded_amount_cents) / purchase.total_cents));
  const clawbackTotalCents = Math.min(creditedCents, Math.round((creditedCents * newRefundedCents) / purchase.total_cents));
  const clawbackCents = clawbackTotalCents - clawbackSoFarCents;
  if (clawbackCents <= 0) return;

  await db.prepare('UPDATE builders SET higgles_balance_cents = higgles_balance_cents - ? WHERE builder_id = ?')
    .bind(clawbackCents, purchase.builder_id).run();
  const template = await db.prepare('SELECT name FROM catalog_templates WHERE template_id = ?')
    .bind(purchase.template_id).first();
  await fireNotification(db, purchase.builder_id,
    `"${template?.name || 'A product'}" partially refunded -- ${formatCents(clawbackCents)} commission clawed back.`);
}

// #556 (docs/SPEC.md §6): credit-card-type detection at signup, the
// zero-new-vendor half of the registration gate (the other half, real
// government-ID verification via Didit, is #589, worker/lib/didit.js). A
// SetupIntent collects and confirms a card without charging it — Stripe
// doesn't bill for creating one, only for an actual payment_intent charge
// — so this tier costs nothing beyond the Stripe account this app already
// has for seller Connect payouts and checkout.
//
// Now that assertVerified (worker/index.js) actually gates real activity
// on this tier (owner: "force everyone through the new gates, no
// grandfathering in"), a deployment that never sets STRIPE_SECRET_KEY
// (local dev, this test suite, or a fresh install before the platform
// owner adds real keys) would otherwise lock every builder/seller action
// out entirely with no way to clear the gate. Same silent simulated-
// fallback convention this file already uses for real-money purchases and
// seller-payout onboarding when Stripe isn't configured (see
// handleInstancePurchase's own comment, worker/index.js) — `simulated:
// true` tells the frontend to skip loading Stripe.js/collecting a card at
// all and go straight to confirm-card.
export async function handleCardSetupIntent(request, env, db) {
  const user = await requireCurrentUser(request, db);
  // #948: same placement as #839's own precedent (checkRateLimit ahead of
  // the stripeConfigured check) — this is what makes the limiter itself
  // exercisable in a test suite that never configures Stripe at all, and it
  // matches every other authenticated mutation in this file, which all cap
  // near the top regardless of what happens further down.
  await checkRateLimit(db, `card-setup:${user.user_id}`, STRIPE_RATE_LIMIT_MAX);
  if (!stripeConfigured(env)) {
    return json({ clientSecret: null, publishableKey: null, simulated: true });
  }
  const setupIntent = await stripeRequest(env, 'POST', 'setup_intents', {
    'payment_method_types[]': 'card',
    metadata: { userId: user.user_id },
  });
  return json({ clientSecret: setupIntent.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY });
}

// #1072 (owner direction, Control Room 2026-10-01): "one card, one
// account, permanently" -- a PaymentMethod/SetupIntent id alone isn't a
// stable per-card identity (a caller can mint a fresh SetupIntent/
// PaymentMethod from the exact same physical card), but Stripe's own
// card.fingerprint is stable across all of them. migrations/0104's
// card_fingerprints is a dedicated claim table (not a column on users) for
// the same reason owned_avatar_purchases is its own table rather than a
// column (see that migration's own comment) -- INSERT OR IGNORE + an
// unconditional re-read is the same atomic claim idiom this file already
// uses for builders/sellers (see getOrCreateBuilderForUser's own comment,
// worker/lib/builder-profile.js) -- whichever caller's INSERT actually
// lands first wins the claim, and every later caller (this same account
// retrying, or a different account entirely) re-reads the same row rather
// than racing a separate SELECT-then-INSERT against card_fingerprints' own
// PRIMARY KEY. Returns whether this fingerprint is owned by a *different*
// account than `userId` -- false both for a brand-new fingerprint and for
// this same account re-confirming a card it already claimed.
export async function claimCardFingerprint(db, fingerprint, userId) {
  await db.prepare('INSERT OR IGNORE INTO card_fingerprints (fingerprint, user_id) VALUES (?, ?)')
    .bind(fingerprint, userId).run();
  const claim = await db.prepare('SELECT user_id FROM card_fingerprints WHERE fingerprint = ?')
    .bind(fingerprint).first();
  return claim.user_id !== userId;
}

// Reads back the card the frontend just collected/confirmed against the
// SetupIntent above and checks Stripe's own card.funding field — "credit"
// (not "debit"/"prepaid", per SPEC §6's own reasoning that those are too
// accessible to minors to serve as an age signal) is the only path this
// tier accepts. card_funding is recorded either way so a rejected
// debit/prepaid attempt is still visible on the account, not a silent
// no-op the builder has no way to explain to themselves later.
//
// Mirrors handleCardSetupIntent's own simulated fallback when Stripe isn't
// configured — no real card to check, so this tier is granted directly
// (the same "no real Stripe balance to ever hold against" reasoning
// simulated purchases already document) rather than the 400/503 a real
// deployment would ever actually see.
export async function handleConfirmCard(request, env, db) {
  const user = await requireCurrentUser(request, db);
  // #948: same placement as #839's own precedent — see handleCardSetupIntent's
  // own comment above.
  await checkRateLimit(db, `confirm-card:${user.user_id}`, STRIPE_RATE_LIMIT_MAX);
  // #954: trust_tier is a one-way ratchet elsewhere in this file (see
  // handleDiditVerificationSession's own "already ID-verified" guard,
  // worker/lib/didit.js, and computeNextLandCap's land_cap_m2 ratchet,
  // worker/index.js) -- id_verified must never be written back down to
  // credit_card just because this endpoint fired again (a stale tab, a
  // retried flow, a direct API call).
  if (!stripeConfigured(env)) {
    await db.prepare(`
      UPDATE users SET card_funding = 'credit',
        trust_tier = CASE WHEN trust_tier = 'id_verified' THEN trust_tier ELSE 'credit_card' END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE user_id = ?
    `).bind(user.user_id).run();
    const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.user_id).first();
    // #2430: a concurrent account deletion (self-delete from another
    // session, or escalateExpiredSuspensions' own cascade) landing in the
    // await gap since the UPDATE above can remove this row before this
    // re-SELECT runs -- same race shape #2334/#2354/#2364/#2391/#2392
    // already fixed elsewhere, not an uncaught userFromRow(undefined) crash.
    if (!updated) return json({ error: 'Account no longer exists' }, 404);
    return json({ user: userFromRow(updated) });
  }
  // #1072: this used to trust a client-supplied paymentMethodId directly,
  // never checking it against anything -- a GET on any PaymentMethod that
  // exists anywhere in this platform's own connected Stripe account
  // succeeds, so a replayed id (this user's own from a prior session,
  // another user's, or one obtained some other way) granted credit_card
  // trust tier with no real verification at all. Trusting the SetupIntent
  // id instead of the PaymentMethod id closes that: the SetupIntent was
  // created server-side by handleCardSetupIntent above with this specific
  // user's id stamped into its own metadata, and its payment_method is
  // only ever set by Stripe once a real card has actually been confirmed
  // against it -- so this endpoint now derives the PaymentMethod id itself
  // from a resource it already knows belongs to this user, rather than
  // trusting whatever id the caller happens to send.
  const input = await readJson(request);
  const setupIntentId = stringValue(input.setupIntentId, 'setupIntentId');
  const setupIntent = await stripeRequest(env, 'GET', `setup_intents/${encodeURIComponent(setupIntentId)}`);
  if (setupIntent.metadata?.userId !== user.user_id) {
    throw new HttpError('This card verification session does not belong to you.', 403);
  }
  if (setupIntent.status !== 'succeeded' || !setupIntent.payment_method) {
    throw new HttpError('Card verification is not complete yet.', 400);
  }
  const paymentMethod = await stripeRequest(env, 'GET', `payment_methods/${encodeURIComponent(setupIntent.payment_method)}`);
  const funding = paymentMethod.card?.funding || null;
  const fundingAccepted = funding === 'credit';
  // Only claimed for an otherwise-accepted (real credit) card -- a rejected
  // debit/prepaid attempt never grants the tier in the first place, so
  // there's nothing worth permanently locking the fingerprint against.
  const fingerprint = paymentMethod.card?.fingerprint || null;
  const fingerprintOwnedByAnotherAccount = fundingAccepted && fingerprint
    ? await claimCardFingerprint(db, fingerprint, user.user_id)
    : false;
  const accepted = fundingAccepted && !fingerprintOwnedByAnotherAccount;
  await db.prepare(`
    UPDATE users SET card_funding = ?,
      trust_tier = CASE WHEN trust_tier = 'id_verified' THEN trust_tier WHEN ? THEN 'credit_card' ELSE trust_tier END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ?
  `).bind(funding, accepted ? 1 : 0, user.user_id).run();
  if (fingerprintOwnedByAnotherAccount) {
    throw new HttpError('This card has already been used to verify a different account.', 409);
  }
  if (!accepted) {
    throw new HttpError('Only credit cards are accepted for this step — debit and prepaid cards can\'t be used.', 400);
  }
  const updated = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(user.user_id).first();
  // #2430: same concurrent-account-deletion race as handleConfirmCard's own
  // re-SELECT above -- a concurrent delete landing in the await gap since
  // the UPDATE can remove this row before this re-SELECT runs.
  if (!updated) return json({ error: 'Account no longer exists' }, 404);
  return json({ user: userFromRow(updated) });
}
