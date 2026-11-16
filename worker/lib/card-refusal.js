// #3565: what the sign-up card step tells a person when the card they gave
// cannot be used. Public copy: it says what happened in plain terms, why the
// rule exists, that nothing was charged, and the way forward (government ID),
// never an internal. The client has the same shape for Stripe's own refusals
// (src/account/cardVerifyCopy.js); this is the half only the server can say,
// because only the server learns the card's funding type.
export const ID_ROUTE = 'You can also verify with a government ID instead, no card needed.';

const REASON = 'Credit cards are only issued to adults, but people under 18 can hold debit, prepaid and gift cards (Apple Cash and Cash App included), so those cannot stand as proof of age.';

// `funding` is Stripe's card.funding: credit, debit, prepaid or unknown.
export function cardNotAcceptedMessage(funding) {
  const kind = funding === 'prepaid' ? 'a prepaid card'
    : funding === 'debit' ? 'a debit card'
      : 'not a credit card we can recognise';
  const lead = funding === 'prepaid' || funding === 'debit' ? `That is ${kind}.` : `That card is ${kind}.`;
  return `${lead} ${REASON} Nothing was charged. Try a credit card, or ${ID_ROUTE.charAt(0).toLowerCase()}${ID_ROUTE.slice(1)}`;
}

export const CARD_ALREADY_USED_MESSAGE = `This card has already been used to verify a different account. Nothing was charged. Try another credit card, or ${ID_ROUTE.charAt(0).toLowerCase()}${ID_ROUTE.slice(1)}`;
