// #4611 (Basket 1/7, part of #4604): the lines of a person's own basket. Behind a session, filtered on the account, one
// line per placed item, at most twenty lines, a quantity cap, nothing stored but the item and how many, and the lines go
// with the account (deletion) and into the data export.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(`
    INSERT INTO landlets (landlet_id, name, status, polygon_json) VALUES ('basket-lot', 'basket-lot', 'greenbelt', '[]')
  `).run();
});

async function item(id, { priceCents = 500, extra = '' } = {}) {
  await env.DB.prepare(`
    INSERT INTO catalog_templates (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents)
    VALUES (?, ?, 'building', 'misc', '#aaaaaa', 1, 1, 1, ?)
  `).bind(`tpl-${id}`, `Product ${id}`, priceCents).run();
  if (extra) await env.DB.prepare(`UPDATE catalog_templates SET ${extra} WHERE template_id = ?`).bind(`tpl-${id}`).run();
  await env.DB.prepare(`
    INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m) VALUES (?, 'basket-lot', ?, 1, 1)
  `).bind(`inst-${id}`, `tpl-${id}`).run();
  return `inst-${id}`;
}
const add = (who, instanceId, quantity) => api('/basket', who.session({ method: 'POST', body: JSON.stringify(quantity === undefined ? { instanceId } : { instanceId, quantity }) }));

describe('basket lines (#4611)', () => {
  it('refuses every route without a session', async () => {
    expect((await api('/basket')).response.status).toBe(401);
    expect((await api('/basket', { method: 'POST', body: JSON.stringify({ instanceId: 'x' }) })).response.status).toBe(401);
  });

  it('adds, adds to, changes and removes a line, naming the product and storing no price', async () => {
    const person = await signupBuilder('basket-crud');
    const id = await item('crud');
    const first = await add(person, id);
    expect(first.response.status).toBe(201);
    expect(first.body.line).toMatchObject({ instanceId: id, quantity: 1, productName: 'Product crud' });
    expect(JSON.stringify(first.body)).not.toMatch(/price/i);
    // The same item again adds to its line, it does not make a second one.
    expect((await add(person, id, 2)).body.line.quantity).toBe(3);
    const list = await api('/basket', person.session());
    expect(list.body.lines).toHaveLength(1);
    expect(list.body.maxLines).toBe(20);
    expect(list.body.maxQuantity).toBe(1000);

    const set = await api(`/basket/${id}`, person.session({ method: 'PATCH', body: JSON.stringify({ quantity: 5 }) }));
    expect(set.body.line.quantity).toBe(5);
    expect((await api(`/basket/${id}`, person.session({ method: 'DELETE' }))).body).toEqual({ removed: true });
    expect((await api('/basket', person.session())).body.lines).toEqual([]);
    // Removing what is not there is not an error.
    expect((await api(`/basket/${id}`, person.session({ method: 'DELETE' }))).response.status).toBe(200);
  });

  it('is private to the person: another account never sees or changes a line', async () => {
    const a = await signupBuilder('basket-owner');
    const b = await signupBuilder('basket-other');
    const id = await item('private');
    await add(a, id, 2);
    expect((await api('/basket', b.session())).body.lines).toEqual([]);
    expect((await api(`/basket/${id}`, b.session({ method: 'PATCH', body: JSON.stringify({ quantity: 9 }) }))).response.status).toBe(404);
    await api(`/basket/${id}`, b.session({ method: 'DELETE' }));
    expect((await api('/basket', a.session())).body.lines[0].quantity).toBe(2);
  });

  it('names what is wrong with a quantity, and caps a line', async () => {
    const person = await signupBuilder('basket-quantity');
    const id = await item('quantity');
    for (const bad of [0, -1, 1.5, '2']) {
      const res = await add(person, id, bad);
      expect(res.response.status).toBe(400);
      expect(res.body.field).toBe('quantity');
    }
    expect((await add(person, id, 1001)).response.status).toBe(400);
    await add(person, id, 1000);
    // Adding more to a full line stops at the cap instead of failing.
    expect((await add(person, id, 5)).body.line.quantity).toBe(1000);
    const missing = await api(`/basket/${id}`, person.session({ method: 'PATCH', body: JSON.stringify({}) }));
    expect(missing.response.status).toBe(400);
  });

  it('refuses an item that is gone or cannot be bought', async () => {
    const person = await signupBuilder('basket-refusals');
    expect((await add(person, 'inst-does-not-exist')).response.status).toBe(404);
    expect((await api('/basket', person.session({ method: 'POST', body: JSON.stringify({}) }))).response.status).toBe(400);
    await env.DB.prepare(`
      INSERT INTO catalog_templates (template_id, name, category, subcategory, color, width_m, depth_m, height_m)
      VALUES ('tpl-unpriced', 'Unpriced', 'building', 'misc', '#aaaaaa', 1, 1, 1)
    `).run();
    await env.DB.prepare(`INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m) VALUES ('inst-unpriced', 'basket-lot', 'tpl-unpriced', 1, 1)`).run();
    expect((await add(person, 'inst-unpriced')).response.status).toBe(400);
    const delisted = await item('delisted', { extra: "delisted_at = '2026-01-01T00:00:00Z'" });
    expect((await add(person, delisted)).response.status).toBe(400);
    const test = await item('testmodel', { extra: 'is_test_model = 1' });
    expect((await add(person, test)).response.status).toBe(400);
  });

  it('keeps at most twenty different items, and still lets a full basket add to a line it has', async () => {
    const person = await signupBuilder('basket-cap');
    const ids = [];
    for (let i = 0; i < 21; i += 1) ids.push(await item(`cap-${i}`));
    for (let i = 0; i < 20; i += 1) expect((await add(person, ids[i])).response.status).toBe(201);
    const over = await add(person, ids[20]);
    expect(over.response.status).toBe(409);
    expect(over.body.limit).toBe(20);
    expect(over.body.error).toContain('up to 20');
    expect((await add(person, ids[0], 2)).body.line.quantity).toBe(3);
    expect((await api('/basket', person.session())).body.lines).toHaveLength(20);
  });

  it('shows a line whose item is gone with no name rather than dropping it', async () => {
    const person = await signupBuilder('basket-gone');
    const id = await item('gone');
    await add(person, id);
    await env.DB.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind(id).run();
    const list = await api('/basket', person.session());
    expect(list.body.lines).toHaveLength(1);
    expect(list.body.lines[0]).toMatchObject({ instanceId: id, productName: null, templateId: null });
  });

  it('is in the data export, and goes when the account is deleted', async () => {
    const person = await signupBuilder('basket-export-delete');
    const id = await item('export');
    await add(person, id, 2);
    const exported = await api('/auth/export-data', person.session());
    expect(exported.body.communication.basketLines).toHaveLength(1);
    expect(exported.body.communication.basketLines[0]).toMatchObject({ instanceId: id, quantity: 2 });
    const deleted = await api('/auth/delete-account', person.session({
      method: 'POST', body: JSON.stringify({ password: 'a fine long password here' }),
    }));
    expect(deleted.response.status).toBe(200);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM basket_lines WHERE instance_id = ?').bind(id).first();
    expect(left.n).toBe(0);
  });
});
