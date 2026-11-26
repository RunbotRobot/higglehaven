// #4376 (owner decision, option A, 2026-11-26): approving a counterfeit flag hides the listing and strikes the seller,
// and nothing more. Refunding the people who already bought it is a separate admin action, "Refund buyers", with a
// confirmation that names the count and the total first.
//
//   GET  /api/product-flags/:templateId/refund-buyers   what the action would do (a look-only admin may read it)
//   POST /api/product-flags/:templateId/refund-buyers   do it, for a full admin, naming what was confirmed
//
// Every refund goes through the same two steps a seller's own Refund uses (finalizeRefundReversal, then
// clawBackPurchaseCommission), so the 99% rate (#651), the Stripe idempotency key (#871), the commission clawback and
// the buyer's notice are unchanged and one purchase is never refunded twice. A purchase whose seller has already been
// paid out is never refunded here (reverse_transfer would pull money that backs other sales: #1061), and one that was
// partly refunded already is left alone too (a full refund on top would exceed the charge); both are reported to the
// admin with their count and total so nobody is told they were refunded when they were not. The platform covering those
// from its own funds is a separate money decision and is not made here.
import { json, HttpError } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson } from './validation.js';
import { requireAdmin, requireAdminOrViewer } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
import { refundAmountCents, purchaseProductName } from './purchase-record.js';
import { finalizeRefundReversal, clawBackPurchaseCommission } from './purchase-lifecycle.js';

const COUNTERFEIT_REFUND_RATE_LIMIT_MAX = 20;
// Each refund is a Stripe call plus several database writes, and a Worker request has a small subrequest budget, so
// one press does a bounded batch and says how many are left; pressing again (the page does) carries on.
export const COUNTERFEIT_REFUND_BATCH = 8;
const BUYER_REASON = 'It was refunded because the listing was removed after a confirmed counterfeit report.';

async function loadPlan(db, templateId) {
  const template = await db.prepare('SELECT template_id, name FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
  if (!template) throw new HttpError('Catalog template not found', 404);
  const approved = await db.prepare("SELECT 1 AS ok FROM product_flags WHERE template_id = ? AND status = 'approved' LIMIT 1").bind(templateId).first();
  if (!approved) throw new HttpError('Approve the counterfeit flag on this listing first; buyers are only refunded after that.', 409);
  const { results } = await db.prepare(`
    SELECT * FROM purchases WHERE template_id = ? AND refunded_at IS NULL AND total_cents > 0
    ORDER BY created_at, purchase_id
  `).bind(templateId).all();
  const refundable = [];
  const blocked = [];
  for (const purchase of results) {
    if (purchase.paid_out_at || (purchase.refunded_amount_cents || 0) > 0) blocked.push(purchase);
    else refundable.push(purchase);
  }
  const sum = (rows, f) => rows.reduce((total, row) => total + f(row), 0);
  return {
    template,
    refundable,
    blocked,
    summary: {
      templateId,
      productName: template.name,
      // What will go back to buyers (99% of each order) and what those orders cost them.
      refundCount: refundable.length,
      refundCents: sum(refundable, (row) => refundAmountCents(row.total_cents)),
      orderTotalCents: sum(refundable, (row) => row.total_cents),
      // Buyers this action cannot refund: the seller was already paid out, or the order was partly refunded.
      notRefundableCount: blocked.length,
      notRefundableCents: sum(blocked, (row) => row.total_cents),
    },
  };
}

export async function handleCounterfeitRefundBuyers(request, env, route) {
  const db = env.DB;
  const templateId = route[1];
  if (request.method === 'GET') {
    await requireAdminOrViewer(request, db);
    const { summary } = await loadPlan(db, templateId);
    return json({ refundBuyers: summary });
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);

  const admin = await requireAdmin(request, db);
  await checkRateLimit(db, `counterfeit-refund:${admin.user_id}`, COUNTERFEIT_REFUND_RATE_LIMIT_MAX);
  const input = await readJson(request);
  const { expectedCount, expectedRefundCents } = input;
  if (!Number.isInteger(expectedCount) || !Number.isInteger(expectedRefundCents) || expectedCount < 0 || expectedRefundCents < 0) {
    throw new HttpError('expectedCount and expectedRefundCents are required: the count and total the admin confirmed.', 400);
  }
  const plan = await loadPlan(db, templateId);
  // The confirmation named a count and a total; refund only if that is still what would happen.
  if (plan.summary.refundCount !== expectedCount || plan.summary.refundCents !== expectedRefundCents) {
    throw new HttpError('The list of buyers to refund changed since you looked at it. Look at the new count and total, then confirm again.', 409);
  }

  const templateName = plan.template.name;
  let refunded = 0;
  let refundedCents = 0;
  let failed = 0;
  let firstError = null;
  for (const purchase of plan.refundable.slice(0, COUNTERFEIT_REFUND_BATCH)) {
    try {
      // false: a concurrent refund or payout got there first; nothing is owed from this call for that purchase.
      if (!(await finalizeRefundReversal(env, purchase))) continue;
      await clawBackPurchaseCommission(db, purchase, (await purchaseProductName(db, purchase)) || templateName, { buyerReason: BUYER_REASON, buyerRefundCents: purchase.payment_intent_id ? refundAmountCents(purchase.total_cents) : null });
      refunded += 1;
      refundedCents += refundAmountCents(purchase.total_cents);
    } catch (err) {
      failed += 1;
      firstError = firstError || (err?.message || 'The refund could not be made');
      console.error('counterfeit refund failed', purchase.purchase_id, err);
    }
  }
  const after = await loadPlan(db, templateId);
  await adminActionLogStatement(db, admin.user_id, 'counterfeit_refund_buyers', 'template', templateId, {
    templateName,
    refunded,
    refundedCents,
    failed,
    remaining: after.summary.refundCount,
    notRefundableCount: after.summary.notRefundableCount,
    notRefundableCents: after.summary.notRefundableCents,
  }).run();
  return json({
    refunded,
    refundedCents,
    failed,
    firstError,
    refundBuyers: after.summary,
  });
}
