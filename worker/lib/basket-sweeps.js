// #4615 (Basket 5/7, part of #4604, under #4394): the two sweeps that keep a paid basket from being lost, on the
// existing cron (worker/index.js scheduled()). Both only ever finish or close what Stripe already says, and both are
// idempotent, so a rerun, or a webhook arriving at the same moment, changes nothing twice.
//
//  1. Pending baskets. A basket order is `pending` from the moment its payment is created until a succeeded payment
//     has been recorded and every seller transferred. One left pending for a quarter of an hour is looked up at Stripe:
//     a payment that succeeded is finalized now (a lost webhook, or a Transfer that failed and was never retried); one
//     that is cancelled is closed; one nobody paid within a day is cancelled at Stripe and closed, so a stale payment
//     cannot be paid long after the prices it was made at. Money that moved is never cancelled: Stripe refuses to
//     cancel a succeeded payment, and that refusal leaves the order pending for the next run to finish.
//  2. Missing transfers. A paid basket's line whose seller's share has not been transferred (the seller had no payout
//     account when it was paid) is retried once the seller has one, the money having waited on the platform's balance;
//     the seller is told when it is finally sent. Until a Transfer exists the line is not eligible for payout and a
//     refund of it is a plain refund (#4614).
import { fireNotification } from './notifications.js';
import { finalizeBasketPaymentIntent, transferSellerShares } from './basket-checkout.js';
import { getBasketOrder } from './basket-orders.js';
import { stripeConfigured, stripeRequest } from '../index.js';

export const BASKET_HEAL_AFTER_MS = 15 * 60 * 1000;
export const BASKET_CANCEL_AFTER_MS = 24 * 60 * 60 * 1000;
const BASKET_TRANSFER_RETRY_AFTER_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 25;

// Payment states Stripe lets us cancel (a payment that is processing or has succeeded cannot be).
const CANCELLABLE = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

const iso = (ms) => new Date(ms).toISOString();

async function closeOrder(db, basketOrderId) {
  await db.prepare(`UPDATE basket_orders SET status = 'cancelled' WHERE basket_order_id = ? AND status = 'pending'`)
    .bind(basketOrderId).run();
}

export async function sweepPendingBasketOrders(env, nowMs = Date.now()) {
  if (!stripeConfigured(env)) return { healed: 0, cancelled: 0 };
  const db = env.DB;
  const { results } = await db.prepare(`
    SELECT basket_order_id, payment_intent_id, created_at FROM basket_orders
    WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?
  `).bind(iso(nowMs - BASKET_HEAL_AFTER_MS), SWEEP_BATCH).all();
  let healed = 0;
  let cancelled = 0;
  for (const order of results) {
    const stale = Date.parse(order.created_at) < nowMs - BASKET_CANCEL_AFTER_MS;
    try {
      if (!order.payment_intent_id) {
        // The payment was never created (it failed before its id was attached): nothing to cancel anywhere.
        if (stale) { await closeOrder(db, order.basket_order_id); cancelled += 1; }
        continue;
      }
      const paymentIntent = await stripeRequest(env, 'GET', `payment_intents/${order.payment_intent_id}`);
      if (paymentIntent.status === 'succeeded') {
        await finalizeBasketPaymentIntent(env, paymentIntent);
        healed += 1;
      } else if (paymentIntent.status === 'canceled') {
        await closeOrder(db, order.basket_order_id);
        cancelled += 1;
      } else if (stale && CANCELLABLE.has(paymentIntent.status)) {
        await stripeRequest(env, 'POST', `payment_intents/${order.payment_intent_id}/cancel`, {}, `basket-cancel:${order.basket_order_id}`);
        await closeOrder(db, order.basket_order_id);
        cancelled += 1;
      }
    } catch (error) {
      // One basket's failure never stops the rest; it stays pending and the next run tries again.
      console.error('sweepPendingBasketOrders: basket left pending', order.basket_order_id, error?.message || error);
    }
  }
  return { healed, cancelled };
}

export async function retryMissingBasketTransfers(env, nowMs = Date.now()) {
  if (!stripeConfigured(env)) return { retried: 0 };
  const db = env.DB;
  const { results } = await db.prepare(`
    SELECT DISTINCT p.basket_order_id
    FROM purchases p
    JOIN basket_orders o ON o.basket_order_id = p.basket_order_id AND o.status = 'paid'
    JOIN sellers s ON s.seller_id = p.seller_id AND s.stripe_account_id IS NOT NULL
    WHERE p.basket_order_id IS NOT NULL AND p.stripe_transfer_id IS NULL AND p.refunded_at IS NULL
      AND p.created_at < ?
    LIMIT ?
  `).bind(iso(nowMs - BASKET_TRANSFER_RETRY_AFTER_MS), SWEEP_BATCH).all();
  let retried = 0;
  for (const { basket_order_id: basketOrderId } of results) {
    try {
      const found = await getBasketOrder(env, basketOrderId);
      if (!found?.order.payment_intent_id) continue;
      const stuck = await db.prepare(`
        SELECT p.purchase_id, p.seller_id FROM purchases p JOIN sellers s ON s.seller_id = p.seller_id AND s.stripe_account_id IS NOT NULL
        WHERE p.basket_order_id = ? AND p.stripe_transfer_id IS NULL AND p.refunded_at IS NULL
      `).bind(basketOrderId).all();
      const paymentIntent = await stripeRequest(env, 'GET', `payment_intents/${found.order.payment_intent_id}`);
      await transferSellerShares(env, found.order, paymentIntent);
      // Tell each seller whose stuck line now has its Transfer, once: after this the line is no longer missing it. A
      // line that was refunded instead (its seller was suspended or closed in the meantime) is not "sent", so it
      // does not count.
      const stuckIds = stuck.results.map((r) => r.purchase_id);
      const sent = stuckIds.length
        ? await db.prepare(`SELECT DISTINCT seller_id FROM purchases WHERE purchase_id IN (${stuckIds.map(() => '?').join(',')}) AND stripe_transfer_id IS NOT NULL`).bind(...stuckIds).all()
        : { results: [] };
      for (const { seller_id: sellerId } of sent.results) {
        const target = await db.prepare(
          'SELECT b.builder_id FROM sellers s JOIN builders b ON b.user_id = s.user_id WHERE s.seller_id = ?',
        ).bind(sellerId).first();
        if (target?.builder_id) {
          await fireNotification(db, target.builder_id, 'The payment for one of your sales has now been sent to your payout account.');
        }
      }
      retried += 1;
    } catch (error) {
      console.error('retryMissingBasketTransfers: left for the next run', basketOrderId, error?.message || error);
    }
  }
  return { retried };
}

export async function sweepBaskets(env, nowMs = Date.now()) {
  const pending = await sweepPendingBasketOrders(env, nowMs);
  const transfers = await retryMissingBasketTransfers(env, nowMs);
  return { ...pending, ...transfers };
}
