// #4664: whether a basket can be paid for yet. Add to basket and the Basket petal are drawn only when it can (a control is
// not drawn for a person it can only refuse), and they appear together on the day the server's switch flips. Read once
// per page, from the public GET /api/basket-config; until the answer is in, and when it cannot be read, nothing is drawn
// (it fails closed here, unlike an anti-abuse check, because a missing basket costs a shopper nothing and a basket that
// cannot be paid for costs them a dead end).
import { fetchBasketConfig } from '../api.js';

let enabled = false;
let loading = null;
const listeners = new Set();

export function basketCheckoutEnabled() {
  return enabled;
}

export function onBasketConfig(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadBasketConfig() {
  if (!loading) {
    loading = fetchBasketConfig()
      .then((config) => {
        enabled = config?.checkoutEnabled === true;
        if (enabled) for (const listener of listeners) listener();
        return enabled;
      })
      .catch(() => false);
  }
  return loading;
}
