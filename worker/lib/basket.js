// #4611 (Basket 1/7, part of #4604, under #4394): the lines of a person's basket, kept on the account. Every route is
// behind a current session and filters on its own user_id. This piece only stores lines; pricing them (#4613) and
// paying them (#4614) come later, and the price is never stored on a line.
import { json, HttpError } from './http.js';
import { readJson } from './validation.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser } from './auth.js';
import { PURCHASE_MAX_QUANTITY } from './purchase-creation.js';

export const MAX_BASKET_LINES = 20;
const BASKET_MUTATE_RATE_LIMIT_MAX = 60;

export function basketLineFromRow(row) {
  return {
    instanceId: row.instance_id,
    quantity: row.quantity,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    // Only to name the line in a list; null once the item or its product is gone (the quote says what that means).
    templateId: row.template_id ?? null,
    productName: row.product_name ?? null,
  };
}

async function listFor(db, userId) {
  const { results } = await db.prepare(`
    SELECT b.instance_id, b.quantity, b.added_at, b.updated_at, pi.template_id, ct.name AS product_name
    FROM basket_lines b
    LEFT JOIN placed_instances pi ON pi.instance_id = b.instance_id
    LEFT JOIN catalog_templates ct ON ct.template_id = pi.template_id
    WHERE b.user_id = ? ORDER BY b.added_at ASC, b.instance_id
  `).bind(userId).all();
  return results.map(basketLineFromRow);
}

function quantityOf(value, { required }) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError('Quantity is required', 400, { field: 'quantity' });
    return 1;
  }
  if (!Number.isInteger(value) || value < 1) throw new HttpError('Quantity must be a whole number, 1 or more', 400, { field: 'quantity' });
  if (value > PURCHASE_MAX_QUANTITY) throw new HttpError(`Quantity must be ${PURCHASE_MAX_QUANTITY} or fewer`, 400, { field: 'quantity', limit: PURCHASE_MAX_QUANTITY });
  return value;
}

// Only what makes a line pointless to keep: the item is gone, or its product cannot be bought at all. Whether it can
// be bought right now (stock, seller, price changed) is the quote's job, so the basket may hold a line that later
// reads "sold out".
async function assertForSale(db, instanceId) {
  const row = await db.prepare(`
    SELECT ct.price_cents, ct.is_test_model, ct.delisted_at, ct.flagged_hidden_at
    FROM placed_instances pi JOIN catalog_templates ct ON ct.template_id = pi.template_id
    WHERE pi.instance_id = ?
  `).bind(instanceId).first();
  if (!row) throw new HttpError('That item is not on a lándlet any more', 404);
  if (row.price_cents == null || row.is_test_model || row.delisted_at || row.flagged_hidden_at) {
    throw new HttpError('This product is not for sale', 400);
  }
}

// GET/POST /api/basket, PATCH/DELETE /api/basket/:instanceId.
export async function handleBasket(request, db, route) {
  const user = await requireCurrentUser(request, db);

  if (request.method === 'GET' && route.length === 1) {
    return json({ lines: await listFor(db, user.user_id), maxLines: MAX_BASKET_LINES, maxQuantity: PURCHASE_MAX_QUANTITY });
  }

  if (request.method === 'POST' && route.length === 1) {
    await checkRateLimit(db, `basket-mutate:${user.user_id}`, BASKET_MUTATE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (typeof input?.instanceId !== 'string' || !input.instanceId) throw new HttpError('An item is required', 400, { field: 'instanceId' });
    const quantity = quantityOf(input.quantity, { required: false });
    await assertForSale(db, input.instanceId);
    // One statement decides both "a new line, under the cap" and "this item is already a line, so add to it", so
    // two requests at once cannot both slip under the cap or lose an increment.
    const result = await db.prepare(`
      INSERT INTO basket_lines (user_id, instance_id, quantity)
      SELECT ?1, ?2, ?3
      WHERE (SELECT COUNT(*) FROM basket_lines WHERE user_id = ?1) < ?4
         OR EXISTS (SELECT 1 FROM basket_lines WHERE user_id = ?1 AND instance_id = ?2)
      ON CONFLICT (user_id, instance_id) DO UPDATE SET
        quantity = MIN(basket_lines.quantity + excluded.quantity, ?5),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).bind(user.user_id, input.instanceId, quantity, MAX_BASKET_LINES, PURCHASE_MAX_QUANTITY).run();
    if (result.meta.changes === 0) {
      throw new HttpError(`A basket holds up to ${MAX_BASKET_LINES} different items. Remove one to add another.`, 409, { limit: MAX_BASKET_LINES });
    }
    const line = (await listFor(db, user.user_id)).find((l) => l.instanceId === input.instanceId);
    return json({ line }, 201);
  }

  if (route.length === 2) {
    const instanceId = route[1];
    if (request.method === 'PATCH') {
      await checkRateLimit(db, `basket-mutate:${user.user_id}`, BASKET_MUTATE_RATE_LIMIT_MAX);
      const input = await readJson(request);
      const quantity = quantityOf(input?.quantity, { required: true });
      const result = await db.prepare(`
        UPDATE basket_lines SET quantity = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE user_id = ? AND instance_id = ?
      `).bind(quantity, user.user_id, instanceId).run();
      if (result.meta.changes === 0) throw new HttpError('That item is not in your basket', 404);
      return json({ line: (await listFor(db, user.user_id)).find((l) => l.instanceId === instanceId) });
    }
    if (request.method === 'DELETE') {
      await checkRateLimit(db, `basket-mutate:${user.user_id}`, BASKET_MUTATE_RATE_LIMIT_MAX);
      await db.prepare('DELETE FROM basket_lines WHERE user_id = ? AND instance_id = ?').bind(user.user_id, instanceId).run();
      return json({ removed: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}
