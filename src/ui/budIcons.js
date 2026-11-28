// #3761 (part of #3759, the flower): every leaf and petal of the bud is a picture first, with its
// one small word under it. The owner: "make the icons as self-explanatory as we possibly can...
// a single tiny word under each one saying what it is. So the primary visual is the icon, and the
// word is secondary." Each icon is a picture of the thing, one line weight, drawn in the current
// text colour as inline SVG (no icon font, no emoji, no image request). They live here, in one
// place, so the line weight and the way a thing is drawn stay one hand.
//
// A leaf's icon is chosen by its DOM id (or a mode's data-mode). A leaf with no entry gets the
// plain default and a console warning, so a new leaf cannot ship as words only.

// Every path is drawn on a 24x24 grid, stroke only.
const PATHS = {
  // Places (the three mode petals)
  shop: 'M3.5 9.5 5 4.5h14l1.5 5 M3.5 9.5a2.75 2.75 0 0 0 5.5 0 2.75 2.75 0 0 0 6 0 2.75 2.75 0 0 0 5.5 0 M5 12.5v7.5h14v-7.5 M10 20v-4.5h4V20',
  build: 'M10.5 6.5l3-3 7 7-3 3z M12.2 12.2 4.5 19.9',
  sell: 'M3 3h8l10 10-8 8L3 11z M7.5 7.5h.01',
  // The top row and Shop's menu
  person: 'M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5',
  bell: 'M6 16.5v-5a6 6 0 0 1 12 0v5l2 2H4z M10 21.5h4',
  friends: 'M9 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z M2.5 20c0-3.5 2.9-5.5 6.5-5.5s6.5 2 6.5 5.5 M17 11a2.75 2.75 0 1 0 0-5.5 M17.5 14.3c2.7.3 4 2.1 4 5',
  assistant: 'M4 5h16v11.5h-8.5L6.5 20.5v-4H4z M9 10.5h.01 M15 10.5h.01 M9.5 13.2c1.4 1 3.6 1 5 0',
  chat: 'M4 4.5h16v11H11l-5 4v-4H4z M8 9h8 M8 12h5',
  // Shop's Nearby: a map pin, the picture of "what is close by"
  nearby: 'M12 21s6.5-5.7 6.5-11a6.5 6.5 0 0 0-13 0c0 5.3 6.5 11 6.5 11z M12 12.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z',
  basket: 'M3 9.5h18l-2 10.5H5z M8 9.5l3-5.5 M16 9.5l-3-5.5 M9.5 13v4 M14.5 13v4',
  bag: 'M5 8.5h14l-1 12.5H6z M9 8.5V7a3 3 0 0 1 6 0v1.5',
  plot: 'M3 17.5l9-4 9 4-9 4z M12 13.5V3.5l5.5 2.2L12 8',
  gear: 'M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5z M12 2.5l1.6 2.7 3-.7.9 3 2.9 1.2-1.1 2.8 1.1 2.8-2.9 1.2-.9 3-3-.7L12 21.5l-1.6-2.7-3 .7-.9-3-2.9-1.2L4.7 12 3.6 9.2l2.9-1.2.9-3 3 .7z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.3 9.4a2.7 2.7 0 1 1 3.9 2.4c-.8.5-1.2 1.1-1.2 2 M12 17.3h.01',
  move: 'M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3',
  login: 'M14 4.5h5.5v15H14 M4 12h10 M10.5 8.5 14 12l-3.5 3.5',
  // Build
  cube: 'M12 3l8 4v9.5l-8 4.5-8-4.5V7z M4 7l8 4.2L20 7 M12 11.2V21',
  layers: 'M12 3.5l9 4.8-9 4.8-9-4.8z M3 12.5l9 4.8 9-4.8 M3 16.8l9 4.7 9-4.7',
  undo: 'M9 13.5 4 8.5l5-5 M4 8.5h10a5.5 5.5 0 0 1 0 11h-3.5',
  redo: 'M15 13.5l5-5-5-5 M20 8.5H10a5.5 5.5 0 0 0 0 11h3.5',
  tools: 'M14.5 6.2a4 4 0 0 0-5.1 5.1L3.6 17.1a1.7 1.7 0 0 0 2.4 2.4l5.8-5.8a4 4 0 0 0 5.1-5.1l-2.6 2.6-2.4-.6-.6-2.4z',
  // Sell
  crate: 'M3.5 4h17v4.5h-17z M5 8.5V20h14V8.5 M10 12.5h4',
  storefront: 'M3 9l1.5-5h15L21 9 M3 9v0a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 M5 12v8h14v-8 M10 20v-5h4v5',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  coins: 'M3 7h18v10H3z M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M6.5 10v.01 M17.5 14v.01',
  tagPlus: 'M3 3h8l10 10-8 8L3 11z M7 4.8v4.4 M4.8 7h4.4',
  // Fallback: a leaf, so an unknown one still looks like part of the plant
  leaf: 'M5 19C5 10 10 5 20 4c0 10-5 15-14 15z M5 19 14 10',
};

// DOM id (or data-mode) -> icon. A petal the bud makes itself has the id bud-petal-<mode>-<id>.
const BY_ID = {
  'settings-btn': 'gear',
  'friends-btn': 'friends',
  'notifications-btn': 'bell',
  'my-purchases-btn': 'bag',
  'my-lands-btn': 'plot',
  'assistant-menu-btn': 'assistant',
  'account-auth-btn': 'login',
  'add-item-btn': 'cube',
  'undo-btn': 'undo',
  'redo-btn': 'redo',
  'bud-petal-shop-how-to-move': 'move',
  'bud-petal-sell-how-to-move': 'move',
  'bud-petal-build-levels': 'layers',
  'bud-petal-build-tools': 'tools',
  'bud-petal-sell-my-products': 'crate',
  'bud-petal-sell-add-product': 'tagPlus',
  'bud-petal-sell-orders': 'orders',
  'bud-petal-sell-payouts': 'coins',
  'bud-petal-sell-storefront': 'storefront',
  'bud-petal-row-help': 'help',
  'bud-petal-shop-chat': 'chat',
  'bud-petal-shop-nearby': 'nearby',
  'bud-petal-shop-basket': 'basket',
};
const BY_MODE = { shop: 'shop', build: 'build', sell: 'sell' };

const warned = new Set();

export function iconKeyFor(el) {
  const mode = el.dataset?.mode;
  if (mode && BY_MODE[mode]) return BY_MODE[mode];
  if (el.id && BY_ID[el.id]) return BY_ID[el.id];
  if (el.id && !warned.has(el.id)) {
    warned.add(el.id);
    console.warn(`bud: leaf "${el.id}" has no icon in src/ui/budIcons.js, so it shows a plain leaf`);
  }
  return 'leaf';
}

// A fresh <svg> for an icon key. aria-hidden: the word under it is the name.
export function svgIcon(key) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[key] || PATHS.leaf);
  svg.appendChild(path);
  return svg;
}

export const ICON_KEYS = Object.keys(PATHS);
export const ICON_BY_ID = BY_ID;
export const ICON_BY_MODE = BY_MODE;
