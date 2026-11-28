// #4613 (Basket 3/7, part of #4604, under #4394): the read-only quote of a basket. Showing the basket asks the server
// to re-judge every line exactly as Buy would (`resolvePurchaseTarget`, the one function the single-product quote and
// the purchase share, so a basket and a Buy cannot disagree) and to price what can be bought, with shipping by the
// rule in #4604's design. It creates nothing and touches no card; paying (#4614) will run the same function again and
// refuse, line by line, whatever this says is not "ok". No line is ever dropped silently: each line comes back with a
// status of its own.
import { json, HttpError, ERROR_CODES } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { requireVerifiedSession } from './auth.js';
import { resolvePurchaseTarget, computePurchaseAmounts } from './purchase-creation.js';
import { requiresShippingAddress } from './shipping-address.js';

const BASKET_QUOTE_RATE_LIMIT_MAX = 60;

// Per-item shipping, in the buyer's zone. #4603 (a seller sets a cost for each zone, and an optional "each additional
// item" amount) will read those here; until it exists nothing has a shipping cost, so every amount is zero and the
// rule below runs on zeros. This is the one place that changes when it lands.
export function shippingAmountsFor() {
  return { firstCents: 0, additionalCents: null };
}

// The rule (#4604 design, section 5): for one seller, the buyer pays each item's per-item amount, except that every
// item after the first is charged its "each additional item" amount when the seller set one (otherwise its own
// per-item amount). The first item is the one with the largest per-item amount, so the order things were added never
// changes the price. `lines` are { quantity, firstCents, additionalCents } for ONE seller; a quantity of 3 is three
// items. Nothing is netted across sellers: the caller groups by seller first.
export function combinedShippingCents(lines) {
  const items = lines.filter((l) => l.quantity > 0);
  if (!items.length) return 0;
  const additionalOf = (l) => (Number.isInteger(l.additionalCents) ? l.additionalCents : l.firstCents);
  // The line whose per-item amount is largest supplies the first item; ties go to the cheaper additional amount so
  // the result does not depend on the order of `lines` either.
  let lead = items[0];
  for (const l of items) {
    if (l.firstCents > lead.firstCents || (l.firstCents === lead.firstCents && additionalOf(l) < additionalOf(lead))) lead = l;
  }
  let total = lead.firstCents;
  for (const l of items) total += additionalOf(l) * (l === lead ? l.quantity - 1 : l.quantity);
  return total;
}

// What a refusal from the shared purchase checks means for one line of a basket.
function statusFor(error) {
  if (error.status === 404) return 'item_gone';
  switch (error.code) {
    case ERROR_CODES.SOLD_OUT: return 'sold_out';
    case ERROR_CODES.SELLER_SUSPENDED: return 'seller_not_selling';
    case ERROR_CODES.NOT_FOR_SALE: return 'not_for_sale';
    case ERROR_CODES.SELLER_NOT_READY: return 'seller_not_ready';
    case ERROR_CODES.ALREADY_OWNED: return 'already_owned';
    default: return 'cannot_buy';
  }
}

// Prices the signed-in person's own basket. `expectedUnitPriceCents` maps instanceId to the unit price the person last
// saw; a line whose live price differs is "price_changed" with the new price, like Buy's own check (#4456).
export async function priceBasket(env, user, lines, expectedUnitPriceCents = new Map()) {
  const db = env.DB;
  const priced = [];
  for (const line of lines) {
    const base = { instanceId: line.instance_id, quantity: line.quantity };
    try {
      const { template, paysWithCard } = await resolvePurchaseTarget(env, db, user, line.instance_id);
      const amounts = computePurchaseAmounts(template, { quantity: line.quantity }, null);
      const expected = expectedUnitPriceCents.get(line.instance_id);
      const common = {
        ...base,
        productName: template.name,
        sellerId: template.seller_id ?? null,
        unitPriceCents: template.price_cents,
        lineTotalCents: amounts.totalCents,
        commissionCents: amounts.commissionCents,
        paysWithCard,
        requiresShippingAddress: requiresShippingAddress(template),
      };
      if (Number.isInteger(expected) && expected !== template.price_cents) {
        priced.push({ ...common, status: 'price_changed', code: ERROR_CODES.PRICE_CHANGED, previousUnitPriceCents: expected, shipping: shippingAmountsFor(template) });
      } else {
        priced.push({ ...common, status: 'ok', shipping: shippingAmountsFor(template) });
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      priced.push({ ...base, status: statusFor(error), code: error.code, message: error.message });
    }
  }

  // Only lines that can be bought count toward the totals; a line that cannot is still listed, with its status.
  const bySeller = new Map();
  for (const line of priced) {
    if (line.status !== 'ok') continue;
    const key = line.sellerId ?? '';
    if (!bySeller.has(key)) bySeller.set(key, { sellerId: line.sellerId, goodsCents: 0, commissionCents: 0, lineCount: 0, shippingInputs: [] });
    const group = bySeller.get(key);
    group.goodsCents += line.lineTotalCents;
    group.commissionCents += line.commissionCents;
    group.lineCount += 1;
    group.shippingInputs.push({ quantity: line.quantity, firstCents: line.shipping.firstCents, additionalCents: line.shipping.additionalCents });
  }
  const sellers = [...bySeller.values()].map(({ shippingInputs, ...group }) => ({ ...group, shippingCents: combinedShippingCents(shippingInputs) }));
  const goodsCents = sellers.reduce((sum, s) => sum + s.goodsCents, 0);
  const shippingCents = sellers.reduce((sum, s) => sum + s.shippingCents, 0);
  return {
    lines: priced.map(({ shipping, ...line }) => line),
    sellers,
    totals: { goodsCents, shippingCents, totalCents: goodsCents + shippingCents },
    // Every line can be bought and there is something to buy; paying (#4614) refuses anything less.
    payable: priced.length > 0 && priced.every((l) => l.status === 'ok'),
  };
}

// GET /api/basket/quote[?expected=<instanceId>:<unitPriceCents>&...]
export async function handleBasketQuote(request, env) {
  const db = env.DB;
  const user = await requireVerifiedSession(request, db);
  await checkRateLimit(db, `basket-quote:${user.user_id}`, BASKET_QUOTE_RATE_LIMIT_MAX);
  const expected = new Map();
  for (const entry of new URL(request.url).searchParams.getAll('expected').slice(0, 20)) {
    const at = entry.lastIndexOf(':');
    const cents = Number(entry.slice(at + 1));
    if (at > 0 && Number.isInteger(cents) && cents >= 0) expected.set(entry.slice(0, at), cents);
  }
  const { results } = await db.prepare(
    'SELECT instance_id, quantity FROM basket_lines WHERE user_id = ? ORDER BY added_at ASC, instance_id',
  ).bind(user.user_id).all();
  return json(await priceBasket(env, user, results, expected));
}
