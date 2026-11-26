// #3116: the decision logic behind one click of the checkout modal's Pay
// button, kept free of DOM/Stripe/network imports so it can be unit-tested.
//
// The charge is a two-step sequence: Stripe confirms the card (money moves),
// then our server records the purchase (finalize). If the second step fails
// (network drop, 5xx, closed laptop lid) the buyer HAS been charged, so a
// second click must retry only finalize -- the server's finalize is
// idempotent on the PaymentIntent id -- and never confirm the card again,
// which Stripe rejects with its own provider wording on an already-succeeded
// PaymentIntent. State outlives a single click so the retry knows which
// step it is on.

export function createCheckoutPayState() {
  return { paymentConfirmed: false, finalizeFailures: 0 };
}

// Stripe's answer to confirming a PaymentIntent that already succeeded (for
// instance a previous confirm that resolved after the tab lost track of it).
// That is success for our purposes: go straight to finalize.
export function isAlreadySucceededConfirmError(error) {
  return error?.code === 'payment_intent_unexpected_state'
    && error?.payment_intent?.status === 'succeeded';
}

// #3947: the wait after Pay is two real steps, so the bar follows them and never a timer. The
// shares are where the bar stands while each step is in flight; the sheet closes on success, so
// there is no third one.
export const PAY_STAGES = {
  checking: { label: 'Checking your card…', share: 0.2 },
  recording: { label: 'Card confirmed. Recording your order…', share: 0.7 },
};

// confirm(): () => Promise<{ error?: { message, code, payment_intent } }>
// finalize(): () => Promise<finalized purchase>
// onStage(name): optional, called with 'checking' before the card is confirmed and 'recording'
// before the purchase is recorded (so a retry after a charge starts at 'recording').
export async function runPayAttempt(state, { confirm, finalize, onStage = () => {} }) {
  if (!state.paymentConfirmed) {
    onStage('checking');
    const result = await confirm();
    if (result?.error) {
      if (!isAlreadySucceededConfirmError(result.error)) {
        const failure = new Error(result.error.message || 'Payment failed.');
        // #3948: kept so describePayFailure can say what to do about this kind of failure.
        failure.stripeCode = result.error.code;
        failure.stripeType = result.error.type;
        // #4460: Stripe answered, and its answer was no: the card was not charged. (A thrown error, with no
        // answer from Stripe, is not known to be a refusal.)
        failure.stripeRefused = true;
        throw failure;
      }
    }
    state.paymentConfirmed = true;
  }
  onStage('recording');
  try {
    return await finalize();
  } catch (error) {
    // #4457: counted so the sheet can offer a way out after a few failed tries (see canLeaveAfterCharge).
    state.finalizeFailures += 1;
    throw error;
  }
}

// #4457: after this many failed tries at recording a paid order the buyer may close the sheet. The order is
// still recorded (the payment provider tells us about every charge), so nothing is lost by leaving; before
// this, Cancel stays locked so a charged buyer is never told "Checkout cancelled." for a paid purchase.
export const FINALIZE_FAILURES_BEFORE_CLOSE = 3;
export function canLeaveAfterCharge(state) {
  return state.paymentConfirmed && state.finalizeFailures >= FINALIZE_FAILURES_BEFORE_CLOSE;
}
// What the buyer reads in the notice when they close the sheet after a paid purchase that could not be recorded here.
export const CHARGED_CLOSED_MESSAGE = "Your payment went through, but we couldn't record the order from here. It will appear in My purchases once it's confirmed. Your card won't be charged again.";

// What the buyer reads when an attempt fails. Once the card has been charged
// the message must say so plainly (never leave them believing the purchase
// failed) and must not echo raw provider or server text.
export const CHARGED_RETRY_MESSAGE = 'Your payment went through, but we couldn\'t finish your purchase yet. Tap "Finish purchase" to try again -- your card won\'t be charged again. Your order will appear in My purchases once it is recorded.';

// #3948: before the card is charged, a failure says what happened in plain words, whether
// anything was charged, and what to do next, instead of the provider's text alone.
const CARD_PROBLEM_COPY = Object.freeze({
  card_declined: 'Your card was declined. You were not charged. Try another card.',
  insufficient_funds: "Your card doesn't have enough available to cover this. You were not charged. Try another card.",
  expired_card: 'That card has expired. You were not charged. Try another card.',
  incorrect_cvc: "The security code doesn't match. You were not charged. Check it and try again.",
  incorrect_number: "That card number isn't right. You were not charged. Check it and try again.",
  invalid_expiry_month: "That expiry date isn't right. You were not charged. Check it and try again.",
  invalid_expiry_year: "That expiry date isn't right. You were not charged. Check it and try again.",
  processing_error: "Your card company couldn't process that just now. You were not charged. Try again in a moment, or use another card.",
  // #4460: the bank's extra verification (3-D Secure) was asked for and not completed.
  payment_intent_authentication_failure: "Your bank asked for extra verification and it wasn't completed. You were not charged. Try again or use another card.",
  authentication_required: "Your bank asked for extra verification and it wasn't completed. You were not charged. Try again or use another card.",
  card_not_supported: "That card can't be used for this purchase. You were not charged. Try another card.",
});
// #4460: Stripe refused for a reason we have no sentence for. It is never echoed (it is the provider's wording,
// and often not for a buyer to read); what the buyer needs is that nothing was charged and what to do.
export const REFUSED_FALLBACK_MESSAGE = "Your payment didn't go through. You were not charged. Try again or use another card.";
// The connection dropped while the card was being confirmed, so whether it went through is not known.
export const CONNECTION_LOST_MESSAGE = "We couldn't confirm your payment because the connection dropped. Check My purchases before trying again: if the order isn't there, you weren't charged.";

export function describePayFailure(state, error) {
  if (state.paymentConfirmed) {
    // #4457: a rate limit on recording the order (shared by everyone on one network) says how much and until when,
    // in the words apiError already built from the server's numbers (#3258), and no retry is urged before then.
    if (error?.rateLimit && typeof error.message === 'string' && error.message) {
      return `Your payment went through, but we've hit a limit on recording orders. ${error.message} Your order will appear in My purchases, and your card won't be charged again.`;
    }
    return CHARGED_RETRY_MESSAGE;
  }
  if (error?.stripeType === 'api_connection_error') return CONNECTION_LOST_MESSAGE;
  const copy = error?.stripeCode && Object.hasOwn(CARD_PROBLEM_COPY, error.stripeCode) && CARD_PROBLEM_COPY[error.stripeCode];
  if (copy) return copy;
  // An answer from Stripe that is a refusal: say not charged. Anything else (a thrown error with no answer from
  // Stripe) might have happened after the card was touched, so it is not claimed to be a refusal.
  if (error?.stripeRefused) return REFUSED_FALLBACK_MESSAGE;
  return CONNECTION_LOST_MESSAGE;
}
