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
  return { paymentConfirmed: false };
}

// Stripe's answer to confirming a PaymentIntent that already succeeded (for
// instance a previous confirm that resolved after the tab lost track of it).
// That is success for our purposes: go straight to finalize.
export function isAlreadySucceededConfirmError(error) {
  return error?.code === 'payment_intent_unexpected_state'
    && error?.payment_intent?.status === 'succeeded';
}

// confirm(): () => Promise<{ error?: { message, code, payment_intent } }>
// finalize(): () => Promise<finalized purchase>
export async function runPayAttempt(state, { confirm, finalize }) {
  if (!state.paymentConfirmed) {
    const result = await confirm();
    if (result?.error) {
      if (!isAlreadySucceededConfirmError(result.error)) {
        throw new Error(result.error.message || 'Payment failed.');
      }
    }
    state.paymentConfirmed = true;
  }
  return finalize();
}

// What the buyer reads when an attempt fails. Once the card has been charged
// the message must say so plainly (never leave them believing the purchase
// failed) and must not echo raw provider or server text.
export const CHARGED_RETRY_MESSAGE = 'Your payment went through, but we couldn\'t finish your purchase yet. Tap "Finish purchase" to try again -- your card won\'t be charged again.';

export function describePayFailure(state, error) {
  if (state.paymentConfirmed) return CHARGED_RETRY_MESSAGE;
  return error?.message || 'Payment failed.';
}
