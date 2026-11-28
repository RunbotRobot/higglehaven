import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { signupBuilder } from './test-helpers.js';
import { clearSettledOrderAddresses, ADDRESS_KEPT_AFTER_SHIPPING_DAYS } from './lib/shipping-address.js';

// #4636: an order keeps its address only while it can still do a job.
let builderId;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  builderId = (await signupBuilder('order-address-retention')).builderId;
});

const ADDRESS = JSON.stringify({ name: 'A', line1: '1 St', city: 'X', region: 'OR', postalCode: '97201', country: 'US' });
async function order(id, columns = {}) {
  await env.DB.prepare(`
    INSERT INTO purchases (purchase_id, instance_id, template_id, builder_id, unit_price_cents, quantity, total_cents,
      commission_cents, builder_share_cents, platform_share_cents, shipping_address_json, shipped_at, paid_out_at, refunded_at, last_dispute_event_at)
    VALUES (?, 'i', 't', ?, 500, 1, 500, 10, 5, 5, ?, ?, ?, ?, ?)
  `).bind(id, builderId, ADDRESS, columns.shipped ?? null, columns.paidOut ?? null, columns.refunded ?? null, columns.dispute ?? null).run();
}
const addressOf = async (id) => (await env.DB.prepare('SELECT shipping_address_json AS a FROM purchases WHERE purchase_id = ?').bind(id).first()).a;

describe('clearSettledOrderAddresses (#4636)', () => {
  it('keeps the address of an order still to be shipped, or shipped and paid out but inside the term (a card dispute can still come)', async () => {
    const now = Date.now();
    await order('ret-open');
    await order('ret-shipped-recent', { shipped: new Date(now - 5 * 86400000).toISOString() });
    const stampPaid = new Date(now - 1000).toISOString();
    await order('ret-paid-inside-term', { shipped: new Date(now - 30 * 86400000).toISOString(), paidOut: stampPaid });
    await clearSettledOrderAddresses(env.DB, now);
    expect(await addressOf('ret-open')).toBe(ADDRESS);
    expect(await addressOf('ret-shipped-recent')).toBe(ADDRESS);
    expect(await addressOf('ret-paid-inside-term')).toBe(ADDRESS);
  });

  it('clears it at once for a refunded order and after the term for a shipped one, leaving the order itself', async () => {
    const now = Date.now();
    const stamp = new Date(now - 1000).toISOString();
    await order('ret-refunded', { refunded: stamp });
    // A dispute withdrawal marks the order refunded too, but the card dispute still needs the address.
    await order('ret-disputed', { refunded: stamp, shipped: new Date(now - 20 * 86400000).toISOString(), dispute: 1700000000 });
    await order('ret-old', { shipped: new Date(now - (ADDRESS_KEPT_AFTER_SHIPPING_DAYS + 1) * 86400000).toISOString() });
    const changed = await clearSettledOrderAddresses(env.DB, now);
    expect(changed).toBe(2);
    expect(await addressOf('ret-disputed')).toBe(ADDRESS);
    for (const id of ['ret-refunded', 'ret-old']) {
      expect(await addressOf(id)).toBeNull();
      expect((await env.DB.prepare('SELECT total_cents FROM purchases WHERE purchase_id = ?').bind(id).first()).total_cents).toBe(500);
    }
    // Running it again changes nothing.
    expect(await clearSettledOrderAddresses(env.DB, now)).toBe(0);
  });
});

describe('an open dispute holds the address past the term (#4648)', () => {
  it('keeps it while the dispute is open, and the term applies once it is won', async () => {
    const now = Date.now();
    const old = new Date(now - (ADDRESS_KEPT_AFTER_SHIPPING_DAYS + 5) * 86400000).toISOString();
    await order('ret-dispute-open', { shipped: old });
    await order('ret-dispute-won', { shipped: old });
    await order('ret-no-dispute', { shipped: old });
    await env.DB.prepare("INSERT INTO purchase_disputes (dispute_id, purchase_id, outcome) VALUES ('dp_ret_open', 'ret-dispute-open', 'open'), ('dp_ret_won', 'ret-dispute-won', 'won')").run();
    await clearSettledOrderAddresses(env.DB, now);
    expect(await addressOf('ret-dispute-open')).toBe(ADDRESS);
    expect(await addressOf('ret-dispute-won')).toBeNull();
    expect(await addressOf('ret-no-dispute')).toBeNull();
    // The dispute is decided: the next run clears it.
    await env.DB.prepare("UPDATE purchase_disputes SET outcome = 'won' WHERE dispute_id = 'dp_ret_open'").run();
    await clearSettledOrderAddresses(env.DB, now);
    expect(await addressOf('ret-dispute-open')).toBeNull();
  });
});
