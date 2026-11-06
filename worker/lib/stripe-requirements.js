// #2928 (part 1, "detect"): which of Stripe's outstanding requirements can
// our own onboarding forms satisfy, and which must go to Stripe's own step?
//
// Owner decision (2026-11-05, recorded in AGENTS.md as "Sensitive identity
// data that only a provider needs goes directly to that provider"): the
// platform never collects a full SSN/ITIN, an ID document, proof of address,
// or business/company details itself, not even in transit. When Stripe's
// account.requirements asks for more than our base form, the person is
// handed to Stripe's own onboarding step. This module is only the
// classifier; creating Stripe's onboarding session and the UI step are the
// "hand off" half, and re-reading requirements on return is "resume".
//
// Keys are Stripe's own requirement names (v1-shaped, which is the snapshot
// shape worker/lib/seller-profile.js reads back from a v2 account too).
// An item is "ours" when a field/prefix below is something our forms or
// buildStripeAccountParams actually send; everything else due is Stripe's.
// `individual.id_number` is deliberately NOT in this list: buildStripeAccountParams
// accepts it only from the real-Stripe e2e test's test-mode value, never from
// a real form, so in production it is always Stripe's to collect.
const OUR_REQUIREMENT_PREFIXES = [
  'individual.first_name',
  'individual.last_name',
  'individual.dob.',
  'individual.address.',
  'individual.ssn_last_4',
  'individual.phone',
  'individual.email',
  'business_type',
  'business_profile.',
  'settings.payments.statement_descriptor',
  'external_account',
  'tos_acceptance.',
  'capabilities',
];

export function isRequirementCollectedByUs(requirement) {
  return OUR_REQUIREMENT_PREFIXES.some((prefix) => (
    prefix.endsWith('.') ? requirement.startsWith(prefix) : requirement === prefix
  ));
}

// currentlyDue is the stored/Stripe `requirements.currently_due` array (or
// anything else; non-strings are ignored). Returns the items our forms can
// satisfy and the items that need Stripe's own step, in input order.
export function classifyStripeRequirements(currentlyDue) {
  const ours = [];
  const needsStripeStep = [];
  for (const requirement of Array.isArray(currentlyDue) ? currentlyDue : []) {
    if (typeof requirement !== 'string' || !requirement) continue;
    (isRequirementCollectedByUs(requirement) ? ours : needsStripeStep).push(requirement);
  }
  return { ours, needsStripeStep };
}

function parseStoredList(stored) {
  if (Array.isArray(stored)) return stored;
  try {
    const parsed = JSON.parse(stored || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// #2928 (early heads-up): Stripe's `requirements.eventually_due` repeats
// everything in `currently_due` and adds what it will ask for later (volume
// or time thresholds). Takes the stored JSON columns (or arrays) and returns
// only the later-only items, so the heads-up never repeats what is already
// due. Unknown/NULL columns (rows from before the column existed) read empty.
export function eventuallyDueOnly(storedCurrentlyDue, storedEventuallyDue) {
  const dueNow = new Set(parseStoredList(storedCurrentlyDue));
  return parseStoredList(storedEventuallyDue).filter((item) => typeof item === 'string' && item && !dueNow.has(item));
}

// The later-only items that only Stripe may collect (same classifier).
export function stripeStepEventuallyDueOnly(storedCurrentlyDue, storedEventuallyDue) {
  return classifyStripeRequirements(eventuallyDueOnly(storedCurrentlyDue, storedEventuallyDue)).needsStripeStep;
}
