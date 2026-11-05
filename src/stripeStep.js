// #2928: when Stripe needs something our own payout forms never collect (a
// full SSN/ITIN, an ID document...), the person is handed to Stripe's own
// onboarding step, so that data goes from their browser straight to Stripe.
// This module is the shared UI for that step on both the seller and builder
// payout panels. Copy says what the person sees; nothing internal.
import { startSellerStripeStep, startBuilderStripeStep } from './api.js';

// True when Stripe has just sent the person back (the return/refresh URL we
// gave it carries ?stripe=...). The panel then re-reads Stripe's view once,
// and the marker is dropped from the address bar so a reload doesn't repeat it.
export function consumeStripeReturnMarker() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('stripe')) return false;
    params.delete('stripe');
    params.delete('role');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    return true;
  } catch {
    return false;
  }
}

// The list shown to the person: only what our own form can fix. Items only
// Stripe collects are covered by the step below instead of being listed raw.
export function ownRequirementsDue(account) {
  const stripeOnly = new Set(account.stripeStepRequirements || []);
  return (account.requirementsCurrentlyDue || []).filter((item) => !stripeOnly.has(item));
}

// Replaces any earlier prompt in `host` with a fresh one when Stripe needs
// its own step; adds nothing otherwise.
export function syncStripeStepPrompt(host, role, account) {
  host.querySelector('.stripe-step-prompt')?.remove();
  if (!account || !account.stripeStepRequirements || account.stripeStepRequirements.length === 0) return;
  const prompt = document.createElement('div');
  prompt.className = 'stripe-step-prompt';
  const text = document.createElement('div');
  text.className = 'settings-empty-note';
  text.textContent = 'Stripe needs a bit more information to verify your account. You will finish this on Stripe, then come back here.';
  prompt.appendChild(text);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'version-action-btn';
  button.textContent = 'Continue with Stripe';
  const status = document.createElement('div');
  status.className = 'settings-empty-note';
  status.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    status.classList.remove('error');
    try {
      const { url } = await (role === 'builder' ? startBuilderStripeStep() : startSellerStripeStep());
      window.location.assign(url);
    } catch (err) {
      status.textContent = err.message || 'Could not open Stripe right now. Please try again.';
      status.classList.add('error');
      button.disabled = false;
    }
  });
  prompt.appendChild(button);
  prompt.appendChild(status);
  host.appendChild(prompt);
}
