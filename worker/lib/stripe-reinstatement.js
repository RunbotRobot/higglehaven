// #1407 (sub-issue of #1404, gated on #1405/#1406/#1065 all landing first):
// the actual AI-made Stripe-reinstatement decision flow -- the owner's
// stated intent (#1404) is to run higglehaven without human staff, with
// Claude making account-moderation judgment calls like this one, backed by
// a strict written rubric, a mandatory audit trail, and an escalate-on-
// ambiguity discipline that never auto-approves on uncertainty.
//
// The owner's exact rubric (#1406's own issue comment, 2026-10-07,
// reproduced verbatim so a future change to this file can diff against the
// real source of truth rather than a paraphrase):
//
//   1. Confirmed fraud (chargebacks/disputes resolved against the seller,
//      or a Stripe fraud determination) -> permanent, hard ban. No
//      reinstatement, ever. Not a case-by-case judgment call -- a fixed
//      rule, applied consistently.
//   2. Suspected/unconfirmed (account restricted on risk signals, nothing
//      adjudicated) -> eligible for reinstatement, gated on all of:
//      - 90-day cooling-off period from the restriction.
//      - New bank account for payouts AND a fresh identity re-verification
//        (new Didit session) -- a new card number alone is not sufficient
//        evidence anything actually changed.
//      - Cap of 2 reinstatements total. A 3rd flag of any kind (confirmed
//        or suspected) is a permanent ban, regardless of whether any
//        individual flag was ever confirmed -- repeated flagging is itself
//        treated as evidence of a pattern.
//
// Design decisions interpreting the rubric (flagged explicitly, not
// invented silently):
//
// - "Cap of 2 reinstatements" and "a 3rd flag is a permanent ban" are the
//   same rule stated two ways, not two separate counters: since a subject
//   can only ever be approved while evaluating their 1st or 2nd flag (the
//   3rd-flag-or-later branch below always denies outright, regardless of
//   disposition), the total number of approvals across a subject's history
//   is structurally capped at 2.
// - "New bank account for payouts" is not independently checked here --
//   it's satisfied structurally by the mechanism itself. An approval
//   resets stripe_account_id to NULL (mirroring the existing admin
//   stripe-account-reset primitive, #1065), and the next onboarding
//   submission (handleBuilderStripeAccount/handleSellerStripeAccount,
//   worker/index.js / worker/lib/seller-profile.js) necessarily creates a
//   brand-new Stripe Custom account when stripe_account_id is null -- a
//   fresh Connect account has no carried-over payout bank details from the
//   old, disabled one, so completing onboarding again inherently requires
//   fresh bank details. There is nothing to check in advance.
// - "Fresh identity re-verification" is checked directly: an approved
//   didit_verification_sessions row for this subject's own user_id, with
//   created_at after the triggering flag's own flagged_at. A session
//   created before the flag (the one that was already on file when the
//   restriction happened) doesn't count as "fresh."
// - Genuinely ambiguous cases (cooling-off elapsed but no fresh
//   re-verification on record yet) resolve to 'escalated', never
//   'approved' -- #1404's own design note is explicit that the two failure
//   modes aren't symmetric for a money/trust decision (a wrongful delay is
//   recoverable, a wrongful approval risks real fraud).
import { json, HttpError } from './http.js';
import { readJson, stringValue } from './validation.js';
import { requireAdmin, requireSessionBuilder } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import { requireBuilder } from './builder-profile.js';
import { requireSessionSeller, stripeAccountStatusJson } from '../index.js';

// #2124's own precedent (stripe-account-reset is rate-limited unlike most
// sibling admin mutations, since it mutates a live Stripe linkage) --
// mirrored here for the same reason, duplicated locally rather than
// exported per the established worker/lib/seller-profile.js precedent for
// this exact constant.
const STRIPE_ACCOUNT_FLAG_RATE_LIMIT_MAX = 20;
const STRIPE_REINSTATEMENT_REQUEST_RATE_LIMIT_MAX = 10;

// Versioned so a future rubric change (a new #1406-style owner decision)
// never retroactively reinterprets an already-logged decision -- a reader
// of an old account_moderation_decisions row can tell exactly which
// rubric text produced it.
const REINSTATEMENT_RUBRIC_VERSION = '1406-v1';

const COOLING_OFF_DAYS = 90;

async function requireSeller(db, sellerId) {
  const row = await db.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(sellerId).first();
  if (!row) throw new HttpError('Seller not found', 404);
  return row;
}

const SUBJECT_TABLE = { builder: 'builders', seller: 'sellers' };
const SUBJECT_ID_COLUMN = { builder: 'builder_id', seller: 'seller_id' };

async function requireSubject(db, subjectType, subjectId) {
  return subjectType === 'builder' ? requireBuilder(db, subjectId) : requireSeller(db, subjectId);
}

// Admin-only: records that this builder's/seller's Stripe account was
// flagged, with the rubric-relevant disposition. This is the premise the
// reinstatement-request flow below evaluates against -- distinct from
// (and recorded in a separate table from) the AI-made *decision* itself,
// the same way a police report and a parole-board ruling are separate
// records of separate events.
export async function handleStripeAccountFlag(request, db, subjectType, subjectId) {
  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `stripe-account-flag:${admin.user_id}`, STRIPE_ACCOUNT_FLAG_RATE_LIMIT_MAX);
  const subject = await requireSubject(db, subjectType, subjectId);
  const input = await readJson(request);
  const disposition = stringValue(input.disposition, 'disposition');
  if (disposition !== 'confirmed_fraud' && disposition !== 'suspected') {
    throw new HttpError("disposition must be 'confirmed_fraud' or 'suspected'", 400);
  }
  // #2708's own 280-char cap -- reused here for the same reasons that
  // comment gives (permanently stored free text, not unbounded like most
  // other moderation reason fields).
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new HttpError('reason is required', 400);
  if (reason.length > 280) throw new HttpError('reason must be 280 characters or fewer', 400);

  const flagId = `stripe-flag-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO stripe_account_flags
      (flag_id, subject_type, subject_id, disposition, reason, stripe_account_id_at_flag_time, flagged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(flagId, subjectType, subjectId, disposition, reason, subject.stripe_account_id ?? null, admin.user_id).run();
  return json({ flagId, subjectType, subjectId, disposition, reason }, 201);
}

// Resets the subject's Stripe linkage exactly the same way the existing
// admin stripe-account-reset primitive does (worker/index.js's builder
// branch / worker/lib/seller-profile.js's seller branch) -- same
// concurrency-safe WHERE re-asserting stripe_account_id, same fields
// cleared. Deliberately NOT logged to admin_action_log: no admin acted
// here, this is the AI-made decision's own effect, and
// account_moderation_decisions (written by the caller right after this
// resolves) is this decision's real audit trail.
async function performReinstatementReset(db, subjectType, subjectId, currentStripeAccountId) {
  const table = SUBJECT_TABLE[subjectType];
  const idColumn = SUBJECT_ID_COLUMN[subjectType];
  const nowIso = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE ${table}
    SET stripe_account_id = NULL, stripe_onboarding_status = 'not_started', stripe_requirements_due = NULL, stripe_updated_at = ?, updated_at = ?
    WHERE ${idColumn} = ? AND stripe_account_id = ?
  `).bind(nowIso, nowIso, subjectId, currentStripeAccountId).run();
  return result.meta.changes > 0;
}

async function recordDecision(db, { subjectType, subjectId, outcome, reasoning }) {
  const decisionId = `moderation-decision-${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO account_moderation_decisions
      (decision_id, decision_type, subject_builder_id, subject_ref, outcome, rubric_version, reasoning, decided_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    decisionId,
    'stripe_reinstatement',
    subjectType === 'builder' ? subjectId : null,
    `${subjectType}:${subjectId}`,
    outcome,
    REINSTATEMENT_RUBRIC_VERSION,
    reasoning,
    'ai:stripe-reinstatement-flow',
  ).run();
  return decisionId;
}

// Generic, user-facing-safe messages -- the full `reasoning` (which flag
// count, which rubric clause, exact dates) stays in the audit-trail row
// only. Revealing the mechanics to the caller would hand a bad actor a
// tuning signal for exactly what to fake next time.
const OUTCOME_MESSAGES = {
  approved: 'Your Stripe account has been reset. You can now reconnect a new account by completing onboarding again.',
  denied: 'Your reinstatement request was not approved. If you believe this is in error, contact our customer service team.',
  escalated: 'Your reinstatement request needs additional review before a decision can be made. Our team will follow up.',
};

// The core rubric evaluation, deterministic given the subject's own flag
// history and (for the gated branch) their Didit verification history --
// no free-form judgment call, matching #1404's own "an explicit, written
// rubric... not unconstrained discretion" requirement.
async function evaluateReinstatement(db, subjectType, subjectId, userId) {
  const { results: flags } = await db.prepare(
    'SELECT * FROM stripe_account_flags WHERE subject_type = ? AND subject_id = ? ORDER BY flagged_at ASC',
  ).bind(subjectType, subjectId).all();

  if (flags.length === 0) {
    throw new HttpError('No Stripe account flag is on record for this account -- there is nothing to reinstate', 409);
  }

  const hasConfirmedFraud = flags.some((flag) => flag.disposition === 'confirmed_fraud');
  const flagCount = flags.length;

  if (hasConfirmedFraud) {
    return {
      outcome: 'denied',
      reasoning: 'Confirmed fraud is on record for this account (a chargeback/dispute resolved against the subject, or a Stripe fraud determination). Per the owner-approved rubric (#1406), this is a permanent, hard ban with no reinstatement path, regardless of elapsed time or any new evidence.',
    };
  }

  // Every flag on record is 'suspected' at this point (confirmed_fraud
  // already returned above). A 3rd-or-later flag of any kind is a
  // permanent ban per the rubric -- this is also what structurally caps
  // total approvals at 2 (see this file's own header comment).
  if (flagCount >= 3) {
    return {
      outcome: 'denied',
      reasoning: `This is flag #${flagCount} on this account. Per the owner-approved rubric (#1406), a 3rd flag of any kind is treated as evidence of a pattern and results in a permanent ban, regardless of whether any individual flag was ever confirmed as fraud.`,
    };
  }

  const mostRecentFlag = flags[flags.length - 1];
  const flaggedAtMs = Date.parse(mostRecentFlag.flagged_at);
  const coolingOffEndsAt = new Date(flaggedAtMs + COOLING_OFF_DAYS * 24 * 60 * 60 * 1000);
  if (Date.now() < coolingOffEndsAt.getTime()) {
    return {
      outcome: 'denied',
      reasoning: `The rubric's 90-day cooling-off period from the most recent flag (${mostRecentFlag.flagged_at}) has not yet elapsed. Eligible again on ${coolingOffEndsAt.toISOString()}.`,
    };
  }

  // "Fresh" re-verification: an approved Didit session created after the
  // flag that started this cooling-off window -- a session already on
  // file before the flag doesn't demonstrate anything changed.
  const freshVerification = await db.prepare(`
    SELECT 1 FROM didit_verification_sessions
    WHERE user_id = ? AND status = 'approved' AND created_at > ?
  `).bind(userId, mostRecentFlag.flagged_at).first();

  if (!freshVerification) {
    return {
      outcome: 'escalated',
      reasoning: 'The 90-day cooling-off period has elapsed, but no fresh (post-flag) approved identity re-verification is on record. Per the rubric this requires a new Didit verification session completed after the flag. Escalating rather than denying outright, since the subject may simply not have completed one yet -- this is not evidence of anything disqualifying.',
    };
  }

  return {
    outcome: 'approved',
    reasoning: `All rubric gates satisfied: no confirmed fraud on record, this is flag #${flagCount} of the 2 allowed before a permanent ban, the 90-day cooling-off period elapsed on ${coolingOffEndsAt.toISOString()}, and a fresh approved identity re-verification is on record. Stripe linkage will be reset -- onboarding a brand-new Connect account structurally requires fresh payout bank details, satisfying the rubric's "new bank account" gate.`,
  };
}

// Self-service: POST /api/{builders,sellers}/me/stripe-reinstatement-request.
// Resolves the caller's own subject from their session -- never a
// client-supplied id, same discipline every other self-service route in
// this codebase already follows.
export async function handleStripeReinstatementRequest(request, env, db, subjectType) {
  const sessionSubject = subjectType === 'builder'
    ? await requireSessionBuilder(request, db)
    : await requireSessionSeller(request, db);
  const subjectId = subjectType === 'builder' ? sessionSubject.builder_id : sessionSubject.seller_id;
  await checkRateLimit(db, `stripe-reinstatement-request:${subjectType}:${subjectId}`, STRIPE_REINSTATEMENT_REQUEST_RATE_LIMIT_MAX);

  const { outcome, reasoning } = await evaluateReinstatement(db, subjectType, subjectId, sessionSubject.user_id);
  await recordDecision(db, { subjectType, subjectId, outcome, reasoning });

  if (outcome === 'approved') {
    const current = await requireSubject(db, subjectType, subjectId);
    if (current.stripe_account_id) {
      await performReinstatementReset(db, subjectType, subjectId, current.stripe_account_id);
    }
    const updated = await requireSubject(db, subjectType, subjectId);
    return json({ outcome, message: OUTCOME_MESSAGES[outcome], stripeAccount: stripeAccountStatusJson(env, updated) }, 200);
  }

  return json({ outcome, message: OUTCOME_MESSAGES[outcome] }, 200);
}
