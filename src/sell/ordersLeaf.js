// #3704 (Sell in the bud, 6/6, slice 3; part of #3655 and #3648): the seller's orders are a leaf of the
// bud. Before, a sale could only be found by opening My products, then one product, then its Sales
// panel; this lists every sale of every product the seller has, newest first, each row the same row
// that panel draws (src/sell/saleRow.js, with its Mark shipped and Refund actions). Money paths are not
// touched: the list is one read-only route scoped to the signed-in seller, and the actions are the
// same routes with the same rules as before.
import { openLeaf } from '../ui/bud.js';
import { fetchSellerOrders } from '../api.js';
import { buildSaleRow } from './saleRow.js';

function note(text, className = 'orders-note') {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  return node;
}

export function openOrdersLeaf() {
  // A render that was superseded (the leaf closed, or an action redrew the list) must not write
  // into a body that is no longer current.
  let token = 0;
  async function paint(body) {
    const mine = ++token;
    body.replaceChildren(note('Loading your orders…'));
    let result;
    try {
      result = await fetchSellerOrders();
    } catch (err) {
      if (mine !== token) return;
      body.replaceChildren(note(err.message || 'Could not load your orders.', 'orders-note error'));
      return;
    }
    if (mine !== token) return;
    const { purchases, totalCount } = result;
    if (!purchases.length) {
      body.replaceChildren(note('No orders yet.'));
      return;
    }
    const list = document.createElement('div');
    list.className = 'orders-list';
    for (const purchase of purchases) {
      list.appendChild(buildSaleRow(purchase, { onChanged: () => paint(body), showProduct: true }));
    }
    const summary = note(totalCount > purchases.length
      ? `Showing newest ${purchases.length} of ${totalCount} orders.`
      : `${totalCount} order${totalCount === 1 ? '' : 's'}`);
    body.replaceChildren(summary, list);
  }
  openLeaf({
    id: 'orders',
    title: 'Orders',
    render: (body) => { void paint(body); },
    onClose: () => { token += 1; },
  });
}
