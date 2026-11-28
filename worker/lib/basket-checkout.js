// #4614 (Basket 4/7, part of #4604, under #4394): paying a basket. ONE PaymentIntent on the platform's own account
// takes the whole total; every line is recorded as an ordinary purchase; then one Transfer per seller moves that
// seller's share (price minus the commission) out of the charge. A basket cannot use the one-product destination charge
// (`transfer_data`), which pays exactly one seller. The design is on #4604.
//
// This piece is behind `BASKET_CHECKOUT_ENABLED` (off unless the variable is the string "true") because a basket line is
// not yet handled by refunds, disputes and payout requests (#4616). Nothing in the app calls the route yet (#4615).
//
// The PaymentIntent carries only `basketOrderId`; what it pays for is the order's own snapshot in the database.
// Finalize (the buyer's call and the payment webhook share it) is idempotent line by line: a line already recorded is
// skipped, so a redelivery or a second caller completes what is missing and nothing is recorded twice. A failure
// throws, so the webhook is redelivered; nothing is lost and nothing is double-credited.
import { json, HttpError, ERROR_CODES } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { requireVerifiedSession } from './auth.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';
import { priceBasket } from './basket-quote.js';
import { shippingAddressForPurchase } from './shipping-address.js';
import { createBasketOrder, attachBasketPaymentIntent, getBasketOrder, markBasketOrderPaid } from './basket-orders.js';
import {
  resolvePurchaseTarget, computePurchaseAmounts, resolveFinalizeBuilderId, writePurchaseRow, writeOrphanedPurchaseRow,
  purchaseFromRow,
} from './purchase-creation.js';
import { stripeConfigured, stripeRequest, sendEmail } from '../index.js';
import { basketReceiptMessage } from './email-layout.js';
import { isUserSuspended } from './account-moderation.js';
import { clawBackPurchaseCommission } from './purchase-lifecycle.js';

const BASKET_CHECKOUT_RATE_LIMIT_MAX = 10;

export function basketCheckoutEnabled(env) {
  return env.BASKET_CHECKOUT_ENABLED === 'true';
}

// GET /api/basket-config (#4664): public, no session. The one switch the checkout reads, as a boolean, so the client
// draws nothing for a basket until it can be paid for ("a control is not drawn for a person it can only refuse").
export function handleBasketConfig(env) {
  return json({ checkoutEnabled: basketCheckoutEnabled(env) });
}

// POST /api/basket/checkout { shippingAddress?, expected?: { <instanceId>: <unitPriceCents> } }
export async function handleBasketCheckout(request, env) {
  const db = env.DB;
  if (!basketCheckoutEnabled(env)) throw new HttpError('Not found', 404);
  const user = await requireVerifiedSession(request, db);
  await checkRateLimit(db, `basket-checkout:${user.user_id}`, BASKET_CHECKOUT_RATE_LIMIT_MAX);
  let input = {};
  try { input = await request.json(); } catch { input = {}; }
  if (!input || typeof input !== 'object') input = {};
  const buyerBuilder = await getOrCreateBuilderForUser(db, user);
  const { results: basketLines } = await db.prepare(
    'SELECT instance_id, quantity FROM basket_lines WHERE user_id = ? ORDER BY added_at ASC, instance_id',
  ).bind(user.user_id).all();
  if (!basketLines.length) throw new HttpError('Your basket is empty.', 400, { code: ERROR_CODES.NOT_FOR_SALE });
  const expected = new Map(Object.entries(input.expected && typeof input.expected === 'object' ? input.expected : {})
    .filter(([, cents]) => Number.isInteger(cents)));

  // The same judgment the basket quote shows: every line must be buyable at the price on the screen, or nothing is
  // charged and each line says why. Never a partial charge.
  const quote = await priceBasket(env, user, basketLines, expected);
  if (!quote.payable) {
    throw new HttpError('Some items in your basket cannot be bought right now. You were not charged.', 409, { code: ERROR_CODES.NOT_FOR_SALE, lines: quote.lines });
  }
  if (!quote.lines.every((l) => l.paysWithCard)) {
    throw new HttpError('Your basket has an item that cannot be paid for with a card. You were not charged.', 409, { code: ERROR_CODES.NOT_FOR_SALE, lines: quote.lines });
  }
  if (!stripeConfigured(env)) throw new HttpError('Stripe payments are not configured on this server yet.', 503, { code: ERROR_CODES.PAYMENTS_UNAVAILABLE });

  // Snapshot every line from a fresh look at it (the same shared function the quote used), so the order records what is
  // charged. The address is checked for each shipped product before any card is touched.
  const lines = [];
  let shippingAddress = null;
  for (const basketLine of basketLines) {
    const { instance, template, landlet } = await resolvePurchaseTarget(env, db, user, basketLine.instance_id);
    const amounts = computePurchaseAmounts(template, { quantity: basketLine.quantity }, buyerBuilder.label);
    const address = shippingAddressForPurchase(template, input);
    if (address) shippingAddress = address;
    lines.push({
      instanceId: instance.instance_id,
      templateId: template.template_id,
      sellerId: template.seller_id ?? null,
      landletOwnerBuilderId: landlet.owner_builder_id,
      productName: template.name,
      buyerLabel: amounts.buyerLabel,
      quantity: amounts.quantity,
      unitPriceCents: amounts.unitPriceCents,
      totalCents: amounts.totalCents,
      commissionCents: amounts.commissionCents,
      builderShareCents: amounts.builderShareCents,
      platformShareCents: amounts.platformShareCents,
      isDigitalGood: !!JSON.parse(template.metadata_json || '{}').digitalGoodDisclaimer,
      isAvatarCategory: template.category === 'avatar',
      isAnimationCategory: template.category === 'animation',
    });
  }
  const { basketOrderId, totalCents } = await createBasketOrder(env, { userId: user.user_id, buyerBuilderId: buyerBuilder.builder_id, lines });
  const paymentIntent = await stripeRequest(env, 'POST', 'payment_intents', {
    amount: totalCents,
    currency: 'usd',
    transfer_group: basketOrderId,
    metadata: { basketOrderId, shippingAddress: shippingAddress ? JSON.stringify(shippingAddress) : '' },
  }, `basket:${basketOrderId}`).catch((err) => {
    if (err instanceof HttpError && !err.code) {
      console.error('basket payment creation failed', err.message);
      throw new HttpError('Could not start the payment.', err.status, { code: ERROR_CODES.PAYMENT_NOT_STARTED });
    }
    throw err;
  });
  await attachBasketPaymentIntent(env, basketOrderId, paymentIntent.id);
  return json({
    requiresPayment: true,
    basketOrderId,
    totalCents,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  });
}

async function lineRecorded(db, paymentIntentId, lineNo) {
  return db.prepare('SELECT * FROM purchases WHERE payment_intent_id = ? AND basket_line_no = ?').bind(paymentIntentId, lineNo).first();
}

// Records one line as an ordinary purchase, once. Real money has already moved, so a vanished product or landlet takes
// the same orphan path as a one-product charge (#472): a row is always written.
async function recordBasketLine(env, order, line, paymentIntent, shippingAddressJson) {
  const db = env.DB;
  const existing = await lineRecorded(db, paymentIntent.id, line.line_no);
  if (existing) return existing;
  const amounts = {
    quantity: line.quantity,
    buyerLabel: line.buyer_label || null,
    unitPriceCents: line.unit_price_cents,
    totalCents: line.total_cents,
    commissionCents: line.commission_cents,
    builderShareCents: line.builder_share_cents,
    platformShareCents: line.platform_share_cents,
  };
  const basket = { basketOrderId: order.basket_order_id, lineNo: line.line_no };
  const isDigitalGood = !!line.is_digital_good;
  // Only a shipped product keeps the address (a digital good, an avatar or an animation has nothing to send).
  const addressForLine = isDigitalGood || line.is_avatar_category || line.is_animation_category ? null : shippingAddressJson;
  const instance = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(line.instance_id).first();
  const template = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(line.template_id).first();
  const builderId = instance && template ? await resolveFinalizeBuilderId(db, { builderId: line.landlet_owner_builder_id }) : null;
  try {
    if (instance && template && builderId) {
      await writePurchaseRow(
        env, instance, template, { owner_builder_id: builderId }, amounts, paymentIntent.id, isDigitalGood, order.buyer_builder_id,
        !!line.is_avatar_category, `basket:${order.basket_order_id}:${line.line_no}`, !!line.is_animation_category, true,
        addressForLine, basket,
      );
    } else {
      await writeOrphanedPurchaseRow(env, {
        instanceId: line.instance_id, templateId: line.template_id, builderId: line.landlet_owner_builder_id || '',
        sellerId: line.seller_id || '', buyerBuilderId: order.buyer_builder_id || '', isAvatarCategory: String(!!line.is_avatar_category),
        isAnimationCategory: String(!!line.is_animation_category), shippingAddress: addressForLine || '',
      }, amounts, paymentIntent.id, isDigitalGood, basket);
    }
  } catch (error) {
    // A concurrent finalize recorded this line first: its row is the answer.
    const winner = await lineRecorded(db, paymentIntent.id, line.line_no);
    if (!winner) throw error;
  }
  return lineRecorded(db, paymentIntent.id, line.line_no);
}

// One Transfer per seller, out of this charge, for the sellers' share (price minus the commission) of their lines that
// still stand. Idempotent in Stripe by key, and only the rows still without a transfer id are written, so a rerun is
// harmless. A line already refunded is left out (its refund took the buyer's money back before the seller was paid).
// A seller who was suspended or closed between the payment and now is not paid: their lines are refunded whole to the
// buyer instead (#4616), so nobody pays a seller the platform has stopped.
export async function transferSellerShares(env, order, paymentIntent) {
  const db = env.DB;
  const { results: standing } = await db.prepare(`
    SELECT * FROM purchases
    WHERE basket_order_id = ? AND seller_id IS NOT NULL AND stripe_transfer_id IS NULL AND refunded_at IS NULL
  `).bind(order.basket_order_id).all();
  const bySeller = new Map();
  for (const row of standing) {
    if (!bySeller.has(row.seller_id)) bySeller.set(row.seller_id, []);
    bySeller.get(row.seller_id).push(row);
  }
  for (const [sellerId, rows] of bySeller) {
    const seller = await db.prepare('SELECT stripe_account_id, user_id FROM sellers WHERE seller_id = ?').bind(sellerId).first();
    const closed = await db.prepare('SELECT 1 AS closed FROM closed_sellers WHERE seller_id = ?').bind(sellerId).first();
    if (closed || !seller || await isUserSuspended(db, seller.user_id)) {
      for (const row of rows) await refundLineWhole(env, row);
      continue;
    }
    if (!seller.stripe_account_id) {
      console.error('basket: seller has no payout account, share stays on the platform', order.basket_order_id, sellerId);
      continue;
    }
    const amountCents = rows.reduce((sum, r) => sum + r.total_cents - r.commission_cents, 0);
    if (amountCents <= 0) continue;
    const transfer = await stripeRequest(env, 'POST', 'transfers', {
      amount: amountCents,
      currency: 'usd',
      destination: seller.stripe_account_id,
      transfer_group: order.basket_order_id,
      ...(typeof paymentIntent.latest_charge === 'string' ? { source_transaction: paymentIntent.latest_charge } : {}),
      metadata: { basketOrderId: order.basket_order_id, sellerId },
    }, `basket-transfer:${order.basket_order_id}:${sellerId}:${rows.map((r) => r.basket_line_no).join('-')}`);
    await db.prepare(
      `UPDATE purchases SET stripe_transfer_id = ? WHERE basket_order_id = ? AND seller_id = ? AND stripe_transfer_id IS NULL AND refunded_at IS NULL`,
    ).bind(transfer.id, order.basket_order_id, sellerId).run();
  }
}

// The whole price back to the buyer for a line whose seller can no longer be paid: a Stripe refund of the full total
// (no transfer exists to pull back, and the platform keeps no commission on a sale it did not complete), the line marked
// refunded, and the builder's commission taken back the usual way. The guard is atomic; Stripe's own key makes a retry safe.
async function refundLineWhole(env, row) {
  const db = env.DB;
  const guard = await db.prepare(
    `UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), refunded_amount_cents = ?
     WHERE purchase_id = ? AND refunded_at IS NULL AND paid_out_at IS NULL`,
  ).bind(row.total_cents, row.purchase_id).run();
  if (guard.meta.changes === 0) return;
  try {
    await stripeRequest(env, 'POST', 'refunds', {
      payment_intent: row.payment_intent_id,
      amount: row.total_cents,
    }, `refund-seller-stopped:${row.purchase_id}`);
  } catch (err) {
    await db.prepare('UPDATE purchases SET refunded_at = NULL, refunded_amount_cents = 0 WHERE purchase_id = ?').bind(row.purchase_id).run();
    throw err;
  }
  await clawBackPurchaseCommission(db, row, row.product_name || 'A product', { buyerRefundCents: row.total_cents });
}

// One email to the buyer: a part per seller, then the total. Names and sellers are the orders' own records.
async function sendBasketReceipt(env, order, purchases) {
  const buyer = await env.DB.prepare('SELECT email FROM users WHERE user_id = ?').bind(order.user_id).first();
  if (!buyer?.email || purchases.length === 0) return;
  const bySeller = new Map();
  for (const p of purchases) {
    const seller = p.seller_name || 'the seller';
    if (!bySeller.has(seller)) bySeller.set(seller, []);
    bySeller.get(seller).push({ name: p.product_name || 'a product', quantity: p.quantity, totalCents: p.total_cents });
  }
  const sections = [...bySeller].map(([sellerName, lines]) => ({ sellerName, lines }));
  await sendEmail(env, { to: buyer.email, ...basketReceiptMessage(sections, order.total_cents) });
}

export async function finalizeBasketPaymentIntent(env, paymentIntent) {
  const db = env.DB;
  const found = await getBasketOrder(env, paymentIntent.metadata?.basketOrderId);
  if (!found) {
    console.error('basket: payment succeeded for an unknown basket order', paymentIntent.id, paymentIntent.metadata?.basketOrderId);
    throw new HttpError('This payment does not match an order.', 400);
  }
  const { order, lines } = found;
  if (order.payment_intent_id !== paymentIntent.id || (paymentIntent.amount != null && paymentIntent.amount !== order.total_cents)) {
    console.error('basket: payment does not match its order', paymentIntent.id, order.basket_order_id);
    throw new HttpError('This payment does not match its order.', 400);
  }
  const shippingAddressJson = paymentIntent.metadata?.shippingAddress || null;
  for (const line of lines) await recordBasketLine(env, order, line, paymentIntent, shippingAddressJson);
  await transferSellerShares(env, order, paymentIntent);
  const firstFinalize = await markBasketOrderPaid(env, order.basket_order_id);
  // What was bought leaves the basket; anything added since stays.
  await db.prepare(`
    DELETE FROM basket_lines WHERE user_id = ? AND instance_id IN (SELECT instance_id FROM basket_order_lines WHERE basket_order_id = ?)
  `).bind(order.user_id, order.basket_order_id).run();
  const { results } = await db.prepare('SELECT * FROM purchases WHERE basket_order_id = ? ORDER BY basket_line_no').bind(order.basket_order_id).all();
  // #4617: one receipt, once (only the call that made the basket paid sends it), never a reason to fail a payment.
  if (firstFinalize) {
    try { await sendBasketReceipt(env, order, results); } catch (error) { console.error('basket: receipt email failed', order.basket_order_id, error); }
  }
  return json({ basketOrderId: order.basket_order_id, purchases: results.map(purchaseFromRow) });
}
