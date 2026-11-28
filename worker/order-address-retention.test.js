import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';
import { clearClosedOrderAddresses, ORDER_ADDRESS_KEEP_DAYS } from './lib/order-address-retention.js';

// #4636: a closed order's address copy is cleared after the grace; open or recent orders keep theirs.
const NOW = Date.parse('2026-12-01T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

let builderId;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  builderId = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host ${crypto.randomUUID()}` }) })).body.builder.builderId;
});

async function order(tag, { refundedAt = null, paidOutAt = null, shippedAt = null } = {}) {
  await env.DB.prepare(`
    INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label,
      unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents,
      shipping_address_json, refunded_at, paid_out_at, shipped_at)
    VALUES (?, ?, 'tpl', ?, 's', 'x', 500, 1, 500, 10, 5, 5, '{"line1":"1 Main"}', ?, ?, ?)
  `).bind(`retain-${tag}`, `retain-inst-${tag}`, builderId, refundedAt, paidOutAt, shippedAt).run();
}
const kept = async (tag) => (await env.DB.prepare('SELECT shipping_address_json AS a FROM purchases WHERE purchase_id = ?').bind(`retain-${tag}`).first()).a !== null;

describe('clearClosedOrderAddresses', () => {
  it('clears refunded and shipped-and-paid-out orders past the grace, and nothing else', async () => {
    const old = ORDER_ADDRESS_KEEP_DAYS + 1;
    await order('refunded-old', { refundedAt: daysAgo(old) });
    await order('refunded-new', { refundedAt: daysAgo(1) });
    await order('paid-old', { shippedAt: daysAgo(old + 8), paidOutAt: daysAgo(old) });
    await order('paid-new', { shippedAt: daysAgo(9), paidOutAt: daysAgo(1) });
    await order('shipped-only', { shippedAt: daysAgo(old + 20) });
    await order('open');
    expect(await clearClosedOrderAddresses(env.DB, NOW)).toBe(2);
    expect(await kept('refunded-old')).toBe(false);
    expect(await kept('paid-old')).toBe(false);
    for (const tag of ['refunded-new', 'paid-new', 'shipped-only', 'open']) expect(await kept(tag), tag).toBe(true);
    expect(await clearClosedOrderAddresses(env.DB, NOW)).toBe(0);
  });
});
