// #3704 (Sell in the bud, 6/6, slice 1; part of #3655 and #3648; covers audit finding #3590): the
// seller's payouts are a leaf of the bud instead of a field at the bottom of Settings > Sell.
//
// Money paths are NOT touched. Every call is the one the Settings field made (fetchSellerStripeAccount,
// submitSellerStripeAccount, fetchSellerPayouts, requestSellerPayout), the same fields go in the same
// shape, the status words are the same, and anything only Stripe collects is still handed to Stripe's
// own step (src/stripeStep.js), so that data never passes through us. No value typed here is logged or
// kept. Only where it opens from, and how the form is laid out, change:
//   - labels sit above their inputs, all at one width (they used to stagger from x=64 to x=165);
//   - the date of birth is one row (month, day, year), not three unrelated boxes;
//   - the thirteen fields are two short steps ("About you", then "Where you live" and "Your bank"),
//     each with a one-line reason, and the buttons stay in view at the foot of the leaf;
//   - an account that is already complete shows its status, balance and Cash out first, and the
//     form only when asked ("Update payout account").
import { openLeaf } from '../ui/bud.js';
import {
  fetchSellerStripeAccount, submitSellerStripeAccount, fetchSellerPayouts, requestSellerPayout,
} from '../api.js';
import { consumeStripeReturnMarker, ownRequirementsDue, syncStripeStepPrompt } from '../stripeStep.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';
import { formatPriceCents, daysInMonth } from '../main.js';

// A render that was superseded (the leaf closed, or it redrew after a submit) must not write into
// a body that is no longer the current one.
let renderToken = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function describePayoutStatus(account) {
  if (!account.configured) {
    return "Stripe payouts aren't set up on this server yet — check back later.";
  }
  if (account.status === 'complete') return 'Your payout account is fully set up.';
  if (account.status === 'requirements_due') {
    const own = ownRequirementsDue(account);
    // Anything only Stripe collects is covered by the "Continue with Stripe" step, not listed here.
    return own.length > 0
      ? `Stripe needs more information: ${own.join(', ')}`
      : 'Your account needs one more step with Stripe.';
  }
  if (account.status === 'action_needed') return 'Stripe flagged an issue with this account — resubmit below.';
  if (account.connected) return 'Your account was created — verification is pending.';
  return 'Not set up yet. Real-money sales are held until this is complete.';
}

// One labelled input. The label is above the input and both fill the leaf's width.
function field(label, type, extra = {}) {
  const wrap = el('label', 'payout-field');
  wrap.append(el('span', 'payout-label', label));
  const input = document.createElement('input');
  input.type = type;
  if (extra.inputMode) input.inputMode = extra.inputMode;
  if (extra.value) input.value = extra.value;
  if (extra.min) input.min = extra.min;
  if (extra.max) input.max = extra.max;
  wrap.append(input);
  return { wrap, input };
}

function buildForm(account, onSubmitted) {
  const inputs = {};
  const add = (host, key, label, type, extra) => {
    const made = field(label, type, extra);
    inputs[key] = made.input;
    host.append(made.wrap);
  };

  const form = el('div', 'payout-form');

  // Step 1: the person.
  const stepOne = el('div', 'payout-step');
  stepOne.append(el('h3', 'payout-step-title', 'About you'));
  stepOne.append(el('p', 'payout-why', 'Needed to confirm who is being paid. Only the last 4 digits of your SSN are asked for here.'));
  add(stepOne, 'firstName', 'First name', 'text');
  add(stepOne, 'lastName', 'Last name', 'text');
  const dob = el('div', 'payout-dob');
  dob.append(el('span', 'payout-label', 'Date of birth'));
  const dobRow = el('div', 'payout-dob-row');
  const dobAdd = (key, label, extra) => {
    const made = field(label, 'number', { inputMode: 'numeric', ...extra });
    made.input.setAttribute('aria-label', `Birth ${label.toLowerCase()}`);
    inputs[key] = made.input;
    dobRow.append(made.wrap);
  };
  dobAdd('dobMonth', 'Month', { min: '1', max: '12' });
  dobAdd('dobDay', 'Day', { min: '1', max: '31' });
  dobAdd('dobYear', 'Year');
  dob.append(dobRow);
  stepOne.append(dob);
  add(stepOne, 'ssnLast4', 'SSN (last 4 digits)', 'text', { inputMode: 'numeric' });
  // #2927: Stripe started requiring this once account creation moved to Accounts v2 (#2924).
  add(stepOne, 'phone', 'Phone number', 'tel');

  // Step 2: where you live, and where to pay you.
  const stepTwo = el('div', 'payout-step');
  stepTwo.hidden = true;
  stepTwo.append(el('h3', 'payout-step-title', 'Where you live'));
  stepTwo.append(el('p', 'payout-why', 'Your address, as your bank has it.'));
  add(stepTwo, 'addressLine1', 'Street address', 'text');
  add(stepTwo, 'addressCity', 'City', 'text');
  const place = el('div', 'payout-pair');
  const placeAdd = (key, label, extra) => {
    const made = field(label, 'text', extra);
    inputs[key] = made.input;
    place.append(made.wrap);
  };
  placeAdd('addressState', 'State');
  placeAdd('addressPostalCode', 'ZIP code');
  stepTwo.append(place);
  add(stepTwo, 'addressCountry', 'Country (2-letter code)', 'text', { value: 'US' });
  stepTwo.append(el('h3', 'payout-step-title', 'Your bank'));
  stepTwo.append(el('p', 'payout-why', 'Where your payouts are sent.'));
  add(stepTwo, 'routingNumber', 'Bank routing number', 'text', { inputMode: 'numeric' });
  add(stepTwo, 'accountNumber', 'Bank account number', 'text', { inputMode: 'numeric' });

  // #1940: the day box's ceiling follows the month and year, as it did in Settings.
  const refreshDobDayMax = () => {
    const month = parseInt(inputs.dobMonth.value, 10);
    const year = parseInt(inputs.dobYear.value, 10);
    if (!Number.isFinite(month) || month < 1 || month > 12) return;
    inputs.dobDay.max = String(daysInMonth(Number.isFinite(year) ? year : new Date().getUTCFullYear(), month));
  };
  inputs.dobMonth.addEventListener('input', refreshDobDayMax);
  inputs.dobYear.addEventListener('input', refreshDobDayMax);

  const formStatus = el('div', 'payout-note');
  formStatus.setAttribute('role', 'status');
  formStatus.setAttribute('aria-live', 'polite');

  // The buttons live in one row at the foot of the leaf, in view whichever step is showing.
  const actions = el('div', 'payout-actions');
  const backBtn = el('button', 'payout-btn', 'Back');
  backBtn.type = 'button';
  backBtn.hidden = true;
  const nextBtn = el('button', 'payout-btn payout-primary', 'Next');
  nextBtn.type = 'button';
  const submitBtn = el('button', 'payout-btn payout-primary', account.connected ? 'Update payout account' : 'Set up payout account');
  submitBtn.type = 'button';
  submitBtn.hidden = true;
  actions.append(backBtn, nextBtn, submitBtn);

  const showStep = (second) => {
    stepOne.hidden = second;
    stepTwo.hidden = !second;
    backBtn.hidden = !second;
    nextBtn.hidden = second;
    submitBtn.hidden = !second;
    formStatus.textContent = '';
    formStatus.classList.remove('error');
    (second ? inputs.addressLine1 : inputs.firstName).focus({ preventScroll: true });
  };
  nextBtn.addEventListener('click', () => showStep(true));
  backBtn.addEventListener('click', () => showStep(false));

  submitBtn.addEventListener('click', async () => {
    formStatus.textContent = '';
    formStatus.classList.remove('error');
    submitBtn.disabled = true;
    backBtn.disabled = true;
    try {
      const updated = await submitSellerStripeAccount({
        individual: {
          firstName: inputs.firstName.value,
          lastName: inputs.lastName.value,
          dobDay: Number(inputs.dobDay.value),
          dobMonth: Number(inputs.dobMonth.value),
          dobYear: Number(inputs.dobYear.value),
          ssnLast4: inputs.ssnLast4.value,
          phone: inputs.phone.value,
          addressLine1: inputs.addressLine1.value,
          addressCity: inputs.addressCity.value,
          addressState: inputs.addressState.value,
          addressPostalCode: inputs.addressPostalCode.value,
          addressCountry: inputs.addressCountry.value,
        },
        externalAccount: {
          routingNumber: inputs.routingNumber.value,
          accountNumber: inputs.accountNumber.value,
          currency: 'usd',
        },
      });
      // #1373: the balance and Cash out only exist once an account does, so a first-time submit
      // redraws the whole leaf (as it redrew Settings) rather than patching one part of it.
      onSubmitted(updated);
      return;
    } catch (err) {
      // The server names the field; going Back is how to reach it from the second step.
      formStatus.textContent = err.message || 'Could not submit — check the fields and go Back to fix them.';
      formStatus.classList.add('error');
    } finally {
      submitBtn.disabled = false;
      backBtn.disabled = false;
    }
  });

  form.append(stepOne, stepTwo, formStatus, actions);
  return form;
}

// #454: only meaningful once an account exists to hold a balance against.
function buildBalance() {
  const block = el('div', 'payout-balance');
  block.append(el('h3', 'payout-step-title', 'Balance'));
  const note = el('div', 'payout-note', 'Loading…');
  block.append(note);
  const cashOutBtn = el('button', 'payout-btn payout-primary', 'Cash out');
  cashOutBtn.type = 'button';
  cashOutBtn.hidden = true;
  block.append(cashOutBtn);

  async function refresh() {
    try {
      const payouts = await fetchSellerPayouts();
      const parts = [`Available to cash out: ${formatPriceCents(payouts.availableCents)}`];
      if (payouts.heldCents > 0) parts.push(`Held: ${formatPriceCents(payouts.heldCents)}`);
      if (payouts.nextEligibleAt) parts.push(`Next eligible: ${new Date(payouts.nextEligibleAt).toLocaleDateString()}`);
      note.textContent = parts.join(' · ');
      note.classList.remove('error');
      cashOutBtn.hidden = payouts.availableCents <= 0;
    } catch (err) {
      note.textContent = err.message || 'Could not load your payout balance.';
      note.classList.add('error');
    }
  }

  cashOutBtn.addEventListener('click', async () => {
    cashOutBtn.disabled = true;
    showInlineActionStatus(block, '');
    try {
      await requestSellerPayout();
      await refresh();
      // #3249: shown beside the balance, not alert() (a suppressed dialog is silent).
      showInlineActionStatus(block, 'Payout requested.', { error: false });
    } catch (err) {
      showInlineActionStatus(block, err.message || 'Could not request a payout.');
    } finally {
      cashOutBtn.disabled = false;
    }
  });

  return { block, refresh };
}

async function renderPayouts(body) {
  renderToken += 1;
  const myToken = renderToken;
  const stale = () => myToken !== renderToken || !body.isConnected;
  body.textContent = '';

  const accountBlock = el('div', 'payout-account');
  const status = el('p', 'payout-note', 'Loading…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  accountBlock.append(status);
  body.append(accountBlock);

  let account;
  try {
    // #2928: back from Stripe's own onboarding step, re-read Stripe's view.
    account = await fetchSellerStripeAccount({ refresh: consumeStripeReturnMarker() });
  } catch (err) {
    if (stale()) return;
    status.textContent = err.message || 'Could not load your payout account status.';
    status.classList.add('error');
    return;
  }
  // The leaf was closed, or redrawn, during that wait.
  if (stale()) return;

  status.textContent = describePayoutStatus(account);
  status.classList.remove('error');
  syncStripeStepPrompt(accountBlock, 'seller', account);

  let balance = null;
  if (account.connected) {
    balance = buildBalance();
    body.append(balance.block);
  }

  const form = buildForm(account, () => { if (!stale()) void renderPayouts(body); });
  // A complete account starts on its status and balance, with the form behind one button; one that
  // still needs something starts on the form.
  if (account.connected && account.status === 'complete') {
    form.hidden = true;
    const open = el('button', 'payout-btn', 'Change payout details');
    open.type = 'button';
    open.setAttribute('aria-expanded', 'false');
    open.addEventListener('click', () => {
      form.hidden = false;
      open.hidden = true;
      form.querySelector('input')?.focus({ preventScroll: true });
    });
    body.append(open);
  }
  body.append(form);

  if (balance) await balance.refresh();
}

export function openPayoutsLeaf() {
  openLeaf({
    id: 'payouts',
    title: 'Payouts',
    render: (body) => { void renderPayouts(body); },
    onClose: () => { renderToken += 1; },
  });
}
