// #4613 (Basket 3/7, part of #4604, under #4394): the read-only quote of a basket. Every line is judged by the same
// function Buy uses and comes back with a status of its own (nothing dropped silently); what can be bought is priced
// with commission per line and shipping by the rule in #4604's design. It writes nothing.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, grantAdminTo } from './test-helpers.js';
import { combinedShippingCents } from './lib/basket-quote.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // A claimed lándlet: Buy refuses an item with no builder to credit.
  const owner = await signupBuilder('bq-lot-owner');
  await env.DB.prepare(`
    INSERT INTO landlets (landlet_id, name, status, polygon_json, owner_builder_id) VALUES ('bq-lot', 'bq-lot', 'claimed', '[]', ?)
  `).bind(owner.builderId).run();
});

describe('the combined shipping rule (#4604 design, section 5)', () => {
  // Zone United States, amounts the seller set; cents.
  it('example 1: one seller, two items, no additional-item amount: the buyer pays both', () => {
    expect(combinedShippingCents([
      { quantity: 1, firstCents: 500, additionalCents: null }, // lamp
      { quantity: 1, firstCents: 800, additionalCents: null }, // rug
    ])).toBe(1300);
  });

  it('example 2: each product also has an each-additional-item amount: the larger first item, the other at its additional amount', () => {
    const lamp = { quantity: 1, firstCents: 500, additionalCents: 150 };
    const rug = { quantity: 1, firstCents: 800, additionalCents: 200 };
    expect(combinedShippingCents([lamp, rug])).toBe(800 + 150);
    // The order things were added never changes the price.
    expect(combinedShippingCents([rug, lamp])).toBe(950);
  });

  it('example 3: two sellers are never combined: each is priced on its own', () => {
    const sellerA = combinedShippingCents([{ quantity: 1, firstCents: 500, additionalCents: 150 }]);
    const sellerB = combinedShippingCents([{ quantity: 1, firstCents: 800, additionalCents: 200 }]);
    expect(sellerA + sellerB).toBe(1300);
  });

  it('counts a quantity as that many items, and free shipping stays free', () => {
    // Three lamps: the first at 500, the other two at the additional 150.
    expect(combinedShippingCents([{ quantity: 3, firstCents: 500, additionalCents: 150 }])).toBe(500 + 2 * 150);
    // Without an additional amount every item pays its own.
    expect(combinedShippingCents([{ quantity: 3, firstCents: 500, additionalCents: null }])).toBe(1500);
    expect(combinedShippingCents([{ quantity: 4, firstCents: 0, additionalCents: null }])).toBe(0);
    expect(combinedShippingCents([])).toBe(0);
  });

  it('breaks a tie between equal first amounts the same way whatever the order', () => {
    const a = { quantity: 1, firstCents: 500, additionalCents: 100 };
    const b = { quantity: 1, firstCents: 500, additionalCents: 300 };
    expect(combinedShippingCents([a, b])).toBe(combinedShippingCents([b, a]));
  });
});

async function item(id, { priceCents = 500, sellerId = null, extra = '' } = {}) {
  await env.DB.prepare(`
    INSERT INTO catalog_templates (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id)
    VALUES (?, ?, 'building', 'misc', '#aaaaaa', 1, 1, 1, ?, ?)
  `).bind(`tpl-${id}`, `Product ${id}`, priceCents, sellerId).run();
  if (extra) await env.DB.prepare(`UPDATE catalog_templates SET ${extra} WHERE template_id = ?`).bind(`tpl-${id}`).run();
  await env.DB.prepare(`
    INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m) VALUES (?, 'bq-lot', ?, 1, 1)
  `).bind(`inst-${id}`, `tpl-${id}`).run();
  return `inst-${id}`;
}
const add = (who, instanceId, quantity = 1) => api('/basket', who.session({ method: 'POST', body: JSON.stringify({ instanceId, quantity }) }));
const quote = (who, query = '') => api(`/basket/quote${query}`, who.session());

describe('the basket quote (#4613)', () => {
  it('refuses without a session', async () => {
    expect((await api('/basket/quote')).response.status).toBe(401);
  });

  it('an empty basket is not payable and costs nothing', async () => {
    const person = await signupBuilder('bq-empty');
    const { response, body } = await quote(person);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ lines: [], sellers: [], totals: { goodsCents: 0, shippingCents: 0, totalCents: 0 }, payable: false });
  });

  it('prices every line that can be bought, with commission per line, and is payable only when all can', async () => {
    const person = await signupBuilder('bq-ok');
    await grantAdminTo(person);
    const lamp = await item('ok-lamp', { priceCents: 1000 });
    const rug = await item('ok-rug', { priceCents: 2500 });
    await add(person, lamp, 2);
    await add(person, rug);
    const { response, body } = await quote(person);
    expect(response.status).toBe(200);
    expect(body.lines.map((l) => [l.instanceId, l.status, l.quantity, l.unitPriceCents, l.lineTotalCents])).toEqual([
      [lamp, 'ok', 2, 1000, 2000],
      [rug, 'ok', 1, 2500, 2500],
    ]);
    // The commission is the single purchase's own math, per line (2% of the line).
    expect(body.lines[0].commissionCents).toBe(40);
    expect(body.lines[1].commissionCents).toBe(50);
    expect(body.totals).toEqual({ goodsCents: 4500, shippingCents: 0, totalCents: 4500 });
    expect(body.payable).toBe(true);
  });

  it('lists a line that cannot be bought with its own status and leaves it out of the totals, never dropping it', async () => {
    const person = await signupBuilder('bq-mixed');
    await grantAdminTo(person);
    const good = await item('mixed-good', { priceCents: 1000 });
    const soldOut = await item('mixed-sold', { priceCents: 700 });
    const delisted = await item('mixed-delisted', { priceCents: 700 });
    const gone = await item('mixed-gone', { priceCents: 700 });
    for (const id of [good, soldOut, delisted, gone]) expect((await add(person, id)).response.status).toBe(201);
    // What changes after the line was added: the seller sells out, delists, or the item leaves the lándlet.
    await env.DB.prepare("UPDATE catalog_templates SET stock_quantity = 0 WHERE template_id = 'tpl-mixed-sold'").run();
    await env.DB.prepare("UPDATE catalog_templates SET delisted_at = '2026-01-01T00:00:00.000Z' WHERE template_id = 'tpl-mixed-delisted'").run();
    await env.DB.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind(gone).run();
    const { body } = await quote(person);
    const status = Object.fromEntries(body.lines.map((l) => [l.instanceId, l.status]));
    expect(status).toEqual({ [good]: 'ok', [soldOut]: 'sold_out', [delisted]: 'not_for_sale', [gone]: 'item_gone' });
    expect(body.lines).toHaveLength(4);
    expect(body.lines.find((l) => l.instanceId === soldOut).code).toBe('sold_out');
    expect(body.totals.goodsCents).toBe(1000);
    expect(body.payable).toBe(false);
  });

  it('says a price changed, with the price the person saw and the new one, and only for the line that changed', async () => {
    const person = await signupBuilder('bq-price');
    await grantAdminTo(person);
    const a = await item('price-a', { priceCents: 1000 });
    const b = await item('price-b', { priceCents: 2000 });
    await add(person, a);
    await add(person, b);
    await env.DB.prepare("UPDATE catalog_templates SET price_cents = 1200 WHERE template_id = 'tpl-price-a'").run();
    const { body } = await quote(person, `?expected=${a}:1000&expected=${b}:2000`);
    const lineA = body.lines.find((l) => l.instanceId === a);
    const lineB = body.lines.find((l) => l.instanceId === b);
    expect(lineA).toMatchObject({ status: 'price_changed', code: 'price_changed', previousUnitPriceCents: 1000, unitPriceCents: 1200 });
    expect(lineB.status).toBe('ok');
    expect(body.payable).toBe(false);
    // Without an expectation there is nothing to have changed from.
    expect((await quote(person)).body.lines.find((l) => l.instanceId === a).status).toBe('ok');
  });

  it('says when a seller cannot be paid yet, the same refusal Buy gives a shopper', async () => {
    const person = await signupBuilder('bq-notready'); // not an admin: only a seller connected for real payments can be bought from
    const id = await item('notready', { priceCents: 1000 });
    await add(person, id);
    const { body } = await quote(person);
    expect(body.lines[0]).toMatchObject({ instanceId: id, status: 'seller_not_ready', code: 'seller_not_ready' });
    expect(body.payable).toBe(false);
  });

  it('reads only the signed-in person\'s own lines and writes nothing', async () => {
    const mine = await signupBuilder('bq-own');
    const other = await signupBuilder('bq-other');
    await grantAdminTo(mine);
    const id = await item('own', { priceCents: 1000 });
    await add(other, id);
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases').first()).n;
    expect((await quote(mine)).body.lines).toEqual([]);
    await add(mine, id);
    expect((await quote(mine)).body.lines).toHaveLength(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases').first()).n).toBe(before);
  });
});
