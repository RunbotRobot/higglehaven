// #3651 (leaf 3/9 of #3648, the bud): where a product's card sits on screen.
//
// The card blooms BESIDE the product it describes, never over it, so what a
// shopper tapped stays in view. This file is the pure arithmetic (no DOM, no
// three.js), so every case the issue asks about is a unit test:
//   - a product off to one side: the card sits to its right (or its left near
//     the right edge);
//   - a product in the middle of a phone screen, where neither side has room
//     for a card: the card goes above or below it, whichever has more room;
//   - a product at the screen edge, off screen or behind the camera: the card
//     stays on screen (pinned to the nearest edge) and drops its pointer,
//     because there is no product on screen to point at;
//   - a product far away and tiny: its on-screen radius is floored so the
//     card keeps a readable gap from the little dot it describes. The card
//     itself is never scaled with distance.
export const CARD_MARGIN_PX = 12;
export const CARD_GAP_PX = 14;
// #3698: the top of the screen belongs to the always-visible bar (the logo, the
// gear, Shop/Build/Sell: about 46 px tall at the phone's size). A card never
// sits under it, or its close button can end up beneath the mode buttons and
// not be tappable; the card's top edge stays at least this far down.
export const CARD_TOP_CLEAR_PX = 52;
export const CARD_MIN_ANCHOR_RADIUS_PX = 10;
export const CARD_MAX_ANCHOR_RADIUS_PX = 140;
// How far from the card's top or bottom its pointer may sit, so the pointer
// never lands on a rounded corner.
export const CARD_POINTER_INSET_PX = 16;
// #4118: a card keeps the side it has until the other side is better by this much. Without it a thing
// that sits on the middle of the screen (Build's selected item is at the orbit target) flips the card
// from left to right every frame as its projected centre moves a fraction of a pixel.
export const CARD_SIDE_HYSTERESIS_PX = 48;
// #4118: a card too tall for any side of a thing with handles round it (Build's item card with More open, on a
// phone) is shortened to the room above or below the thing and scrolls inside, rather than lying over the thing's
// rings. Under this much room the card is left as it was (overlapping beats an unreadable sliver).
export const CARD_MIN_CAPPED_HEIGHT_PX = 160;
// #4242: a thing that fills the view (a wall's width, zoomed in close, with its rings round it) has no clear
// place for a card beside it, above it or below it: every place is on the thing. The card then docks to the
// top or bottom edge of the screen, whichever is farther from the thing's middle (where the rings are), as a
// strip at most this share of the screen tall (it scrolls inside), with no pointer.
export const CARD_DOCK_MAX_SHARE = 0.34;

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

// anchor: { x, y, radius, behind } in CSS pixels, from the product's projected
//   centre. `behind` is true when the product is behind the camera (its x/y
//   are then meaningless).
// card: { width, height }; viewport: { width, height }.
// Returns { left, top, side, pointerX, pointerY, edge }:
//   side: 'right' | 'left' | 'above' | 'below' = where the card is, relative to
//   the product;
//   pointerY / pointerX: where, down or along the card, its pointer toward the
//   product sits (pointerY for a card to the side, pointerX for one above or
//   below);
//   edge: true when there is no on-screen product to point at (the card is
//   then pinned and shows no pointer);
//   maxHeight: null, or the height (px) the card is to be shortened to (it scrolls inside) so it can sit
//   above or below the thing instead of over it.
//   anchor.fills (#4242): the thing covers most of the screen, so the card docks to an edge (see CARD_DOCK_MAX_SHARE).
export function placeProductCard({
  anchor, card, viewport, margin = CARD_MARGIN_PX, gap = CARD_GAP_PX, topClear = CARD_TOP_CLEAR_PX,
  previousSide = null,
}) {
  const minTop = Math.max(margin, topClear);
  const maxLeft = Math.max(margin, viewport.width - margin - card.width);
  const maxTop = Math.max(minTop, viewport.height - margin - card.height);
  const offScreen = !!anchor.behind
    || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)
    || anchor.x < 0 || anchor.x > viewport.width
    || anchor.y < 0 || anchor.y > viewport.height;

  if (anchor.behind || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    // Nothing on screen to sit beside: centred, a third of the way down.
    return {
      left: clamp((viewport.width - card.width) / 2, margin, maxLeft),
      top: clamp(viewport.height * 0.3 - card.height / 2, minTop, maxTop),
      side: 'right',
      pointerX: card.width / 2,
      pointerY: card.height / 2,
      edge: true,
      maxHeight: null,
    };
  }

  if (anchor.fills) {
    // The thing fills the view: dock. The edge farther from the thing's middle, keeping the one it had unless the
    // other is clearly better, so the card does not jump while the view moves.
    const middle = viewport.height / 2;
    const roomy = Number.isFinite(anchor.y) ? anchor.y : middle;
    const preferBelow = roomy <= middle;
    const keep = (previousSide === 'below' || previousSide === 'above') && Math.abs(roomy - middle) < CARD_SIDE_HYSTERESIS_PX;
    const side = keep ? previousSide : (preferBelow ? 'below' : 'above');
    const dockHeight = Math.max(1, Math.min(card.height, Math.floor((viewport.height - minTop - margin) * CARD_DOCK_MAX_SHARE)));
    return {
      left: clamp((viewport.width - card.width) / 2, margin, maxLeft),
      top: side === 'below' ? viewport.height - margin - dockHeight : minTop,
      side,
      pointerX: card.width / 2,
      pointerY: dockHeight / 2,
      edge: true,
      maxHeight: dockHeight < card.height ? dockHeight : null,
    };
  }

  const x = clamp(anchor.x, margin, viewport.width - margin);
  const y = clamp(anchor.y, margin, viewport.height - margin);
  const radius = clamp(anchor.radius ?? 0, CARD_MIN_ANCHOR_RADIUS_PX, CARD_MAX_ANCHOR_RADIUS_PX);

  const rightLeft = x + radius + gap;
  const leftLeft = x - radius - gap - card.width;
  const fitsRight = rightLeft <= maxLeft;
  const fitsLeft = leftLeft >= margin;
  let side;
  let left;
  let top;
  let maxHeight = null;
  let shown = card;
  if (fitsRight || fitsLeft) {
    // Both sides fit: stay on the side the card was on, rather than snapping to the right.
    side = fitsRight && fitsLeft && previousSide === 'left' ? 'left' : (fitsRight ? 'right' : 'left');
    left = fitsRight ? rightLeft : leftLeft;
    top = clamp(y - card.height / 2, minTop, maxTop);
  } else {
    // Neither side has room (a product in the middle of a narrow screen): above
    // or below it, whichever has more room, centred on it.
    // #4410: a thing whose handles reach farther up than down (Build's up arrow, seen in perspective) asks for
    // more clear space above it (anchor.aboveExtra); the card then sits farther up, or goes below.
    const aboveClear = radius + Math.max(0, anchor.aboveExtra ?? 0);
    const belowTop = y + radius + gap;
    const aboveTop = y - aboveClear - gap - card.height;
    const fitsBelow = belowTop <= maxTop;
    const fitsAbove = aboveTop >= minTop;
    const roomBelow = viewport.height - margin - (y + radius + gap);
    const roomAbove = y - aboveClear - gap - minTop;
    if (fitsBelow || fitsAbove) {
      side = fitsBelow && (!fitsAbove || roomBelow >= roomAbove) ? 'below' : 'above';
      top = side === 'below' ? belowTop : aboveTop;
      left = clamp(x - card.width / 2, margin, maxLeft);
    } else if (Math.max(roomBelow, roomAbove) >= CARD_MIN_CAPPED_HEIGHT_PX) {
      // #4118: nothing fits at the card's full height, but a shorter card would sit clear above or below:
      // shorten it (it scrolls inside) rather than lay it over the thing's handles. It keeps its side unless
      // the other has clearly more room.
      const keepBelow = previousSide === 'below' && roomBelow + CARD_SIDE_HYSTERESIS_PX >= roomAbove;
      const keepAbove = previousSide === 'above' && roomAbove + CARD_SIDE_HYSTERESIS_PX >= roomBelow;
      side = keepBelow || (!keepAbove && roomBelow >= roomAbove) ? 'below' : 'above';
      maxHeight = Math.floor(side === 'below' ? roomBelow : roomAbove);
      shown = { width: card.width, height: maxHeight };
      top = side === 'below' ? y + radius + gap : y - aboveClear - gap - maxHeight;
      left = clamp(x - card.width / 2, margin, maxLeft);
    } else {
      // Nothing fits (a very large product on a small screen): keep the card on
      // screen on the side with more room, even if it overlaps.
      // Room on each side is how far the card could sit from the thing before the screen's edge. The card
      // keeps the side it had unless the other has clearly more room (CARD_SIDE_HYSTERESIS_PX).
      const roomRight = viewport.width - margin - (x + radius + gap);
      const roomLeft = x - radius - gap - margin;
      if (previousSide === 'right' || previousSide === 'left') {
        const previousRoom = previousSide === 'right' ? roomRight : roomLeft;
        const otherRoom = previousSide === 'right' ? roomLeft : roomRight;
        side = otherRoom > previousRoom + CARD_SIDE_HYSTERESIS_PX
          ? (previousSide === 'right' ? 'left' : 'right')
          : previousSide;
      } else {
        side = x < viewport.width / 2 ? 'right' : 'left';
      }
      left = clamp(side === 'right' ? rightLeft : leftLeft, margin, maxLeft);
      top = clamp(y - card.height / 2, minTop, maxTop);
    }
  }
  const pointerY = clamp(y - top, CARD_POINTER_INSET_PX, Math.max(CARD_POINTER_INSET_PX, shown.height - CARD_POINTER_INSET_PX));
  const pointerX = clamp(x - left, CARD_POINTER_INSET_PX, Math.max(CARD_POINTER_INSET_PX, shown.width - CARD_POINTER_INSET_PX));
  return {
    left, top, side, pointerX, pointerY, edge: offScreen, maxHeight,
  };
}

// The product's on-screen radius, in pixels: the distance between the
// projected centre and the projected end of a half-width along the camera's
// right vector. Computed by the caller (it needs the camera); this only floors
// and caps it so one bad projection cannot send the card across the screen.
export function clampAnchorRadius(radiusPx) {
  if (!Number.isFinite(radiusPx)) return CARD_MIN_ANCHOR_RADIUS_PX;
  return clamp(radiusPx, CARD_MIN_ANCHOR_RADIUS_PX, CARD_MAX_ANCHOR_RADIUS_PX);
}

// What the card says and offers for a product, given what the client knows.
// Plain words, never internals. A card shows the Buy petal only when this says
// `canBuy`; every other case says why in a sentence (the issue: nothing that is
// not for sale shows a Buy petal).
//   inRange: the shopper is close enough to the product to act on it (the same
//   gate the old panel used for Buy/Rate/Return policy, SIGN_INTERACT_RADIUS_M).
//   canReview: a product is rated from an order (#3775), so only when the shopper is within
//   reach AND has an order of it that is not rated yet (`hasUnratedOrder`); otherwise the
//   control is not drawn at all, rather than drawn to refuse.
//   canReturnPolicy: only something with a price has a refund to describe.
// #3680: the line under the price that says whose product it is. The name is the
// seller's storefront name (a shop's name, not a person's); with no name known
// (a seller who has closed their shop, or a lookup that has not answered) the card
// says nothing rather than something made up.
export function sellerLine(label, rating = null) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name) return '';
  // #4375: how well the seller is rated, once they have any ratings (nothing is said for none).
  const count = rating?.ratingCount ?? 0;
  const average = rating?.ratingAverage;
  if (count > 0 && Number.isFinite(average)) return `Sold by ${name} · ${average.toFixed(1)} ★ (${count})`;
  return `Sold by ${name}`;
}

// #3681: `owned` is true when the shopper already owns this product as a digital
// good (an avatar or an animation they bought, src/shop/ownedProducts.js): the
// card says so and offers no Buy, but they can still rate it and read its return
// policy, since it is theirs.
export function productCardState({ template, inRange, owned = false, hasUnratedOrder = false }) {
  const reach = !!inRange;
  const canRate = reach && !!hasUnratedOrder;
  const priced = template?.priceCents != null;
  if (template?.isTestModel) {
    return {
      canBuy: false, canReview: canRate, canReturnPolicy: false,
      stateText: 'A testing model: not a real product and not for sale.',
    };
  }
  if (!priced) {
    return { canBuy: false, canReview: canRate, canReturnPolicy: false, stateText: 'Not for sale.' };
  }
  if (owned) {
    return { canBuy: false, canReview: canRate, canReturnPolicy: reach, stateText: 'You already own this.' };
  }
  if (template.stockQuantity === 0) {
    return { canBuy: false, canReview: canRate, canReturnPolicy: reach, stateText: 'Out of stock.' };
  }
  if (!reach) {
    return { canBuy: false, canReview: false, canReturnPolicy: false, stateText: 'Walk closer to buy this.' };
  }
  return { canBuy: true, canReview: canRate, canReturnPolicy: true, stateText: '' };
}
