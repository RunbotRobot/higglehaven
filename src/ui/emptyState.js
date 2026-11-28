// #3875 (interface week, #3539): what a new person sees in a leaf with nothing in it. Each one says in
// one plain sentence what will appear there and, where there is one, the single thing that fills it;
// none reads as a failed load; and they all share one look (.empty-state in src/app.css) instead of
// eight hand-made ones. The sentences live here so the page's static text (index.html), the code that
// resets it, and the assistants' handbook (docs/assistant-handbook.md) say the same words;
// src/ui/emptyState.test.js checks that they do.
export const EMPTY_COPY = {
  notices: 'Nothing new. Updates about your products, your lándlet and your account will show up here.',
  friends: 'No friends yet. Tap + Add friend to invite someone by name.',
  purchases: "You haven't bought anything yet. Tap a product in Shop mode to buy it, and your orders will be listed here.",
  lands: "You don't own a lándlet yet. Claim one in Build mode to start building.",
  products: 'No products yet. Tap "Add a product" in the menu to put your first one up for sale.',
  orders: 'No orders yet. When someone buys one of your products, it will show up here.',
  chat: 'Nobody has said anything nearby yet. What you type here is seen by people close to you.',
  basket: 'Your basket is empty. Tap a product in Shop mode and choose Add to basket to gather things here.',
  search: 'Try fewer letters, or clear the search to see everything.',
};

// A paragraph for a leaf built in code (Orders). Leaves drawn from index.html carry the same class.
export function emptyState(text) {
  const node = document.createElement('p');
  node.className = 'empty-state';
  node.textContent = text;
  return node;
}
