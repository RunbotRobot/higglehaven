// #4614 (Basket 4/7, part of #4604): the records behind paying a basket. A basket is paid by one PaymentIntent on the
// platform's own account; what it is paying for is kept here (not in Stripe metadata, which is far too small for twenty
// lines), and the PaymentIntent carries only `basketOrderId`. Lines are snapshots taken at payment creation.

export function newBasketOrderId() {
  return `bko_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

// lines: [{ instanceId, templateId, sellerId, landletOwnerBuilderId, productName, buyerLabel, quantity, unitPriceCents,
//           totalCents, commissionCents, builderShareCents, platformShareCents, isDigitalGood, isAvatarCategory,
//           isAnimationCategory }] in basket order; line numbers are 1.. in that order.
export async function createBasketOrder(env, { userId, buyerBuilderId = null, lines }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('A basket order needs at least one line.');
  const basketOrderId = newBasketOrderId();
  const totalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const db = env.DB;
  const statements = [
    db.prepare(`INSERT INTO basket_orders (basket_order_id, user_id, buyer_builder_id, total_cents) VALUES (?, ?, ?, ?)`)
      .bind(basketOrderId, userId, buyerBuilderId, totalCents),
    ...lines.map((l, i) => db.prepare(`
      INSERT INTO basket_order_lines
        (basket_order_id, line_no, instance_id, template_id, seller_id, landlet_owner_builder_id, product_name, buyer_label,
         quantity, unit_price_cents, total_cents, commission_cents, builder_share_cents, platform_share_cents,
         is_digital_good, is_avatar_category, is_animation_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(basketOrderId, i + 1, l.instanceId, l.templateId, l.sellerId ?? null, l.landletOwnerBuilderId ?? null,
      l.productName ?? null, l.buyerLabel ?? null, l.quantity, l.unitPriceCents, l.totalCents, l.commissionCents,
      l.builderShareCents, l.platformShareCents, l.isDigitalGood ? 1 : 0, l.isAvatarCategory ? 1 : 0, l.isAnimationCategory ? 1 : 0)),
  ];
  await db.batch(statements);
  return { basketOrderId, totalCents };
}

export async function attachBasketPaymentIntent(env, basketOrderId, paymentIntentId) {
  await env.DB.prepare(`UPDATE basket_orders SET payment_intent_id = ? WHERE basket_order_id = ? AND status = 'pending'`)
    .bind(paymentIntentId, basketOrderId).run();
}

export async function getBasketOrder(env, basketOrderId) {
  const order = await env.DB.prepare(`SELECT * FROM basket_orders WHERE basket_order_id = ?`).bind(basketOrderId).first();
  if (!order) return null;
  const { results } = await env.DB.prepare(`SELECT * FROM basket_order_lines WHERE basket_order_id = ? ORDER BY line_no`)
    .bind(basketOrderId).all();
  return { order, lines: results };
}

// Pending -> paid, once. Returns true only for the call that made the change, so a retried webhook does not repeat it.
export async function markBasketOrderPaid(env, basketOrderId) {
  const r = await env.DB.prepare(`
    UPDATE basket_orders SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE basket_order_id = ? AND status = 'pending'
  `).bind(basketOrderId).run();
  return (r.meta?.changes ?? 0) > 0;
}
