// #4612 (Basket 2/7, part of #4604, under #4394): "Basket", a leaf under Shop's own stem that lists the lines a person
// has gathered, grouped by seller, each with a quantity stepper and Remove. It is always in the stem (menus never
// change), draws nothing until it is opened, and the server holds every rule (caps, what a line is); this only shows
// what the server answers. #4666 slice 1: the leaf also asks for the server's quote (#4613) and shows each line's
// price, a plain sentence for any line that cannot be bought, each seller's shipping when above zero, and the total.
// Paying (#4614) is a later slice, so there is no Pay button yet.
import { addBudPetals, openLeaf } from '../ui/bud.js';
import { fetchBasket, fetchBasketQuote, addToBasket, setBasketQuantity, removeFromBasket } from '../api.js';
import { emptyState, EMPTY_COPY } from '../ui/emptyState.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';
import { groupBasketLines } from './basketGroups.js';
import { statusSentence, quoteLinesByInstance, expectedPrices, sellerTotals } from './basketQuote.js';
import { formatPriceCents } from '../main.js';
import { loadBasketConfig } from './basketConfig.js';

function button(label, ariaLabel, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'basket-action';
  btn.textContent = label;
  btn.setAttribute('aria-label', ariaLabel);
  btn.addEventListener('click', onClick);
  return btn;
}

function lineRow(line, { maxQuantity, onChange, quoteLine, onAccept }) {
  const row = document.createElement('div');
  row.className = 'basket-row';
  row.dataset.instanceId = line.instanceId;
  const name = document.createElement('div');
  name.className = 'my-purchase-name';
  name.textContent = line.productName || 'A product that is no longer here';
  const controls = document.createElement('div');
  controls.className = 'basket-controls';
  const notes = [];
  if (quoteLine) {
    const sentence = statusSentence(quoteLine, formatPriceCents);
    const note = document.createElement('div');
    note.className = sentence ? 'orders-note error basket-line-note' : 'orders-note basket-line-price';
    note.textContent = sentence || `${formatPriceCents(quoteLine.unitPriceCents)} each · ${formatPriceCents(quoteLine.lineTotalCents)}`;
    notes.push(note);
    if (quoteLine.status === 'price_changed') {
      notes.push(button('Accept new price', `Accept the new price for ${line.productName || 'this'}`, () => onAccept(line.instanceId, quoteLine.unitPriceCents)));
    }
  }
  const quantity = document.createElement('span');
  quantity.className = 'basket-quantity';
  quantity.textContent = String(line.quantity);
  quantity.setAttribute('role', 'status');
  const act = async (task) => {
    for (const btn of controls.querySelectorAll('button')) btn.disabled = true;
    try {
      await task();
      await onChange();
    } catch (err) {
      for (const btn of controls.querySelectorAll('button')) btn.disabled = false;
      showInlineActionStatus(row, err.message || 'That did not work. Try again.');
    }
  };
  const less = button('−', `One fewer ${line.productName || 'of this'}`, () => act(() => setBasketQuantity(line.instanceId, line.quantity - 1)));
  less.disabled = line.quantity <= 1;
  const more = button('+', `One more ${line.productName || 'of this'}`, () => act(() => setBasketQuantity(line.instanceId, line.quantity + 1)));
  more.disabled = line.quantity >= maxQuantity;
  const remove = button('Remove', `Remove ${line.productName || 'this'} from your basket`, () => act(() => removeFromBasket(line.instanceId)));
  controls.append(less, quantity, more, remove);
  row.append(name, ...notes, controls);
  return row;
}

export function openBasketLeaf() {
  let token = 0;
  let lastQuote = null;
  const accepted = new Map();
  async function paint(body) {
    const mine = ++token;
    let result;
    let quote = null;
    let quoteError = null;
    try {
      result = await fetchBasket();
    } catch (err) {
      if (mine !== token) return;
      const failed = document.createElement('p');
      failed.className = 'orders-note error';
      failed.textContent = err.message || "Couldn't load your basket.";
      const retry = button('Try again', 'Try loading your basket again', () => paint(body));
      body.replaceChildren(failed, retry);
      return;
    }
    if (mine !== token) return;
    if (!result.lines.length) {
      body.replaceChildren(emptyState(EMPTY_COPY.basket));
      return;
    }
    try {
      quote = await fetchBasketQuote(expectedPrices(lastQuote, accepted));
      lastQuote = quote;
    } catch (err) {
      quoteError = err.message || "Couldn't price your basket.";
    }
    if (mine !== token) return;
    const quoted = quoteLinesByInstance(quote);
    const onAccept = (instanceId, cents) => { accepted.set(instanceId, cents); paint(body); };
    const list = document.createElement('div');
    list.className = 'basket-list';
    for (const group of groupBasketLines(result.lines)) {
      const section = document.createElement('section');
      section.className = 'basket-seller-group';
      const heading = document.createElement('h3');
      heading.className = 'basket-seller';
      heading.textContent = group.sellerName;
      section.append(heading);
      for (const line of group.lines) {
        section.append(lineRow(line, { maxQuantity: result.maxQuantity, onChange: () => paint(body), quoteLine: quoted.get(line.instanceId), onAccept }));
      }
      const totals = sellerTotals(quote, group.lines[0].sellerId);
      if (totals && totals.shippingCents > 0) {
        const shipping = document.createElement('p');
        shipping.className = 'orders-note basket-shipping';
        shipping.textContent = `Shipping ${formatPriceCents(totals.shippingCents)}`;
        section.append(shipping);
      }
      list.append(section);
    }
    if (quoteError) {
      const failed = document.createElement('p');
      failed.className = 'orders-note error';
      failed.textContent = quoteError;
      list.prepend(failed);
    } else if (quote?.totals) {
      const total = document.createElement('p');
      total.className = 'orders-note basket-total';
      total.textContent = `Total ${formatPriceCents(quote.totals.totalCents)}`;
      list.append(total);
    }
    body.replaceChildren(list);
  }
  openLeaf({
    id: 'basket',
    title: 'Basket',
    render: (body) => {
      const loading = document.createElement('p');
      loading.className = 'orders-note';
      loading.textContent = 'Loading your basket…';
      body.replaceChildren(loading);
      paint(body);
    },
    onClose: () => { token += 1; },
  });
}

// "Add to basket" on a product card. Resolves to a sentence for the card to show: what happened, or why not.
export async function addInstanceToBasket(instanceId) {
  await addToBasket(instanceId, 1);
  return 'Added to your basket.';
}

// #4664: the petal is added when the server says a basket can be paid for, not before; until then (and when the answer
// cannot be read) the Shop stem is the one it always was.
loadBasketConfig().then((enabled) => {
  if (enabled) addBudPetals('shop', [{ id: 'basket', label: 'Basket', run: openBasketLeaf }]);
});
