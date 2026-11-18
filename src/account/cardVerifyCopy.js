// #3565: what the sign-up card step says when Stripe itself refuses the card
// (before the server ever sees it). Stripe's own sentence is never shown alone:
// it is replaced by ours, in plain terms, ending with the same two things every
// refusal on this step ends with: nothing was charged, and the government-ID way
// in. The server's own refusals (a debit or prepaid card that Stripe accepted,
// a card already used) are in worker/lib/card-refusal.js.
const ID_ROUTE = 'or verify with a government ID instead, no card needed.';
const END = `Nothing was charged. Try another credit card, ${ID_ROUTE}`;

const BY_CODE = {
  expired_card: 'That card has expired.',
  incorrect_number: 'That card number does not look right.',
  invalid_number: 'That card number does not look right.',
  incomplete_number: 'That card number is not complete.',
  invalid_expiry_month: 'That expiry date does not look right.',
  invalid_expiry_year: 'That expiry date does not look right.',
  invalid_expiry_year_past: 'That card has expired.',
  incomplete_expiry: 'That expiry date is not complete.',
  incorrect_cvc: 'That security code does not look right.',
  invalid_cvc: 'That security code does not look right.',
  incomplete_cvc: 'That security code is not complete.',
  incorrect_zip: 'That postal code does not match the card.',
  incomplete_zip: 'That postal code is not complete.',
  processing_error: 'The card could not be processed just now.',
  rate_limit: 'Too many tries in a row.',
  setup_intent_authentication_failure: 'Your bank did not confirm the card.',
  authentication_required: 'Your bank asked for a confirmation that did not complete.',
};

// Cards a bank refuses outright. Many prepaid, gift and wallet-backed cards
// land here, so the sentence says the likely reason without claiming it.
const DECLINED = 'The card was declined. Prepaid, debit and gift cards (Apple Cash and Cash App included) are not accepted here, because people under 18 can hold them.';

// `error` is Stripe.js's result.error: { type, code, decline_code, message }.
export function describeCardRefusal(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  const type = error && typeof error.type === 'string' ? error.type : '';
  let lead;
  if (BY_CODE[code]) lead = BY_CODE[code];
  else if (code === 'card_declined' || type === 'card_error') lead = DECLINED;
  else lead = 'The card could not be verified.';
  return `${lead} ${END}`;
}

// The two lines the card step opens with. They give the reason for the rule,
// not just the rule.
// An account that ticked the 18-or-older box at sign-up is not shown the tick again, so its intro
// speaks only of the proof (#3734); an account that never ticked it sees both, below.
export const VERIFY_INTRO_PROOF_ONLY = 'Building and selling on higglehaven takes proof that you are 18 or older: either a credit card or a government ID. A card is never charged; only its type is checked.';
export const VERIFY_INTRO = 'Building and selling on higglehaven takes two things: confirming you are 18 or older, and proof of it, either a credit card or a government ID. A card is never charged; only its type is checked.';
export const CARD_STEP_INTRO = 'Use a credit card. Credit cards are only issued to adults, so they work as proof of age. Debit, prepaid and gift cards (Apple Cash and Cash App included) can be held by people under 18, so they are not accepted.';
export const ID_INSTEAD_LABEL = 'No credit card? Verify with a government ID instead';
