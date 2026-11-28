// #4614 (Basket 4/7): the basket order records, and the purchase-row columns that tie a purchase to its basket line.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBasketOrder, getBasketOrder, attachBasketPaymentIntent, markBasketOrderPaid } from './lib/basket-orders.js';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const line = (n, cents) => ({ instanceId: `i${n}`, templateId: `t${n}`, sellerId: 's1', landletOwnerBuilderId: 'b1', productName: `P${n}`,
  buyerLabel: 'Buyer', quantity: 1, unitPriceCents: cents, totalCents: cents, commissionCents: 2, builderShareCents: 1,
  platformShareCents: 1, isDigitalGood: false, isAvatarCategory: false, isAnimationCategory: false });

describe('basket orders (#4614)', () => {
  it('records an order with numbered line snapshots and the summed total', async () => {
    const { basketOrderId, totalCents } = await createBasketOrder(env, { userId: 'u1', lines: [line(1, 500), line(2, 700)] });
    expect(totalCents).toBe(1200);
    const got = await getBasketOrder(env, basketOrderId);
    expect(got.order).toMatchObject({ status: 'pending', total_cents: 1200, user_id: 'u1' });
    expect(got.lines.map((l) => [l.line_no, l.instance_id])).toEqual([[1, 'i1'], [2, 'i2']]);
  });

  it('refuses an empty basket and marks paid exactly once', async () => {
    await expect(createBasketOrder(env, { userId: 'u1', lines: [] })).rejects.toThrow();
    const { basketOrderId } = await createBasketOrder(env, { userId: 'u1', lines: [line(3, 100)] });
    await attachBasketPaymentIntent(env, basketOrderId, 'pi_basket_1');
    expect(await markBasketOrderPaid(env, basketOrderId)).toBe(true);
    expect(await markBasketOrderPaid(env, basketOrderId)).toBe(false);
  });

  it('keeps one purchase per PaymentIntent outside a basket but allows one per line inside one', async () => {
    const ins = (id, pi, lineNo) => env.DB.prepare(`
      INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, unit_price_cents, quantity,
        total_cents, commission_cents, builder_share_cents, platform_share_cents, payment_intent_id, basket_order_id, basket_line_no)
      VALUES (?, 'i', 't', NULL, NULL, 'x', 1, 1, 1, 0, 0, 0, ?, ?, ?)
    `).bind(id, pi, lineNo === null ? null : 'bko_x', lineNo).run();
    await ins('p1', 'pi_solo', null);
    await expect(ins('p2', 'pi_solo', null)).rejects.toThrow();
    await ins('p3', 'pi_bk', 1);
    await ins('p4', 'pi_bk', 2);
    await expect(ins('p5', 'pi_bk', 2)).rejects.toThrow();
  });
});
