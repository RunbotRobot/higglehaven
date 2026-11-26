import { describe, expect, it } from 'vitest';
import {
  CARD_DOCK_MAX_SHARE, CARD_GAP_PX, CARD_MARGIN_PX, CARD_MAX_ANCHOR_RADIUS_PX, CARD_MIN_ANCHOR_RADIUS_PX, CARD_TOP_CLEAR_PX,
  clampAnchorRadius, placeProductCard, productCardState, sellerLine,
} from './productCardLayout.js';

const PHONE = { width: 390, height: 844 };
const CARD = { width: 200, height: 120 };

describe('placeProductCard (#3651)', () => {
  it('puts the card beside a product in the middle of the screen, on its right', () => {
    const place = placeProductCard({ anchor: { x: 120, y: 400, radius: 30 }, card: CARD, viewport: PHONE });
    expect(place.side).toBe('right');
    expect(place.left).toBe(120 + 30 + CARD_GAP_PX);
    expect(place.edge).toBe(false);
    // Centred on the product, and the pointer lands on it.
    expect(place.top).toBe(400 - CARD.height / 2);
    expect(place.top + place.pointerY).toBe(400);
  });

  it('never covers the product: the card starts past the product\'s own edge', () => {
    const place = placeProductCard({ anchor: { x: 100, y: 300, radius: 60 }, card: CARD, viewport: PHONE });
    expect(place.left).toBeGreaterThanOrEqual(100 + 60);
  });

  it('flips to the left when the right side has no room', () => {
    const place = placeProductCard({ anchor: { x: 340, y: 400, radius: 30 }, card: CARD, viewport: PHONE });
    expect(place.side).toBe('left');
    expect(place.left + CARD.width).toBeLessThanOrEqual(340 - 30);
    expect(place.left).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
  });

  it('stays on screen for a product at the top or bottom edge', () => {
    const top = placeProductCard({ anchor: { x: 100, y: 4, radius: 20 }, card: CARD, viewport: PHONE });
    expect(top.top).toBe(CARD_TOP_CLEAR_PX); // #3698: below the always-visible top bar
    const bottom = placeProductCard({ anchor: { x: 100, y: 840, radius: 20 }, card: CARD, viewport: PHONE });
    expect(bottom.top + CARD.height).toBeLessThanOrEqual(PHONE.height - CARD_MARGIN_PX);
    // The pointer still points at where the product is.
    expect(top.pointerY).toBeGreaterThanOrEqual(0);
    expect(bottom.pointerY).toBeLessThanOrEqual(CARD.height);
  });

  it('keeps the card on screen, with no pointer, for a product that has left the screen', () => {
    for (const x of [-300, 900]) {
      const place = placeProductCard({ anchor: { x, y: 400, radius: 30 }, card: CARD, viewport: PHONE });
      expect(place.edge).toBe(true);
      expect(place.left).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
      expect(place.left + CARD.width).toBeLessThanOrEqual(PHONE.width - CARD_MARGIN_PX);
    }
  });

  it('keeps the card on screen, with no pointer, for a product behind the camera', () => {
    const place = placeProductCard({ anchor: { x: NaN, y: NaN, radius: 0, behind: true }, card: CARD, viewport: PHONE });
    expect(place.edge).toBe(true);
    expect(place.left).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
    expect(place.top).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
    const behindWithNumbers = placeProductCard({ anchor: { x: 200, y: 400, radius: 20, behind: true }, card: CARD, viewport: PHONE });
    expect(behindWithNumbers.edge).toBe(true);
  });

  it('gives a tiny far-away product a readable gap, not a card touching a dot', () => {
    const place = placeProductCard({ anchor: { x: 100, y: 400, radius: 0.4 }, card: CARD, viewport: PHONE });
    expect(place.left).toBe(100 + CARD_MIN_ANCHOR_RADIUS_PX + CARD_GAP_PX);
  });

  it('puts the card above or below a product in the middle of a phone screen, never over it', () => {
    // 390 px wide: a 200 px card plus a product 66 px in radius cannot sit beside a
    // product at the centre, so the card goes above or below it.
    const mid = placeProductCard({ anchor: { x: 195, y: 248, radius: 66 }, card: CARD, viewport: PHONE });
    expect(['above', 'below']).toContain(mid.side);
    expect(mid.edge).toBe(false);
    // Clear of the product: its whole radius plus the gap away.
    if (mid.side === 'below') expect(mid.top).toBeGreaterThanOrEqual(248 + 66 + CARD_GAP_PX);
    else expect(mid.top + CARD.height).toBeLessThanOrEqual(248 - 66 - CARD_GAP_PX);
    expect(mid.left).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
    expect(mid.left + CARD.width).toBeLessThanOrEqual(PHONE.width - CARD_MARGIN_PX);
    // The pointer lands on the product's column.
    expect(mid.left + mid.pointerX).toBeCloseTo(195, 0);
  });

  it('chooses below when the product is high on the screen and above when it is low', () => {
    const high = placeProductCard({ anchor: { x: 195, y: 150, radius: 66 }, card: CARD, viewport: PHONE });
    expect(high.side).toBe('below');
    const low = placeProductCard({ anchor: { x: 195, y: 700, radius: 66 }, card: CARD, viewport: PHONE });
    expect(low.side).toBe('above');
  });

  it('keeps extra clear space above a thing whose handles reach farther up (#4410)', () => {
    // A thing low on the screen: the card goes above it, and sits aboveExtra farther up than it would.
    const plain = placeProductCard({ anchor: { x: 195, y: 700, radius: 122 }, card: CARD, viewport: PHONE });
    const extra = placeProductCard({ anchor: { x: 195, y: 700, radius: 122, aboveExtra: 48 }, card: CARD, viewport: PHONE });
    expect(plain.side).toBe('above');
    expect(extra.side).toBe('above');
    expect(extra.top).toBe(plain.top - 48);
    // Below it the extra changes nothing.
    const belowPlain = placeProductCard({ anchor: { x: 195, y: 250, radius: 122 }, card: CARD, viewport: PHONE });
    const belowExtra = placeProductCard({ anchor: { x: 195, y: 250, radius: 122, aboveExtra: 48 }, card: CARD, viewport: PHONE });
    expect(belowExtra.top).toBe(belowPlain.top);
  });

  it('keeps the card on screen even when neither side has room', () => {
    const narrow = { width: 260, height: 600 };
    const place = placeProductCard({ anchor: { x: 130, y: 300, radius: 80 }, card: CARD, viewport: narrow });
    expect(place.left).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
    expect(place.left + CARD.width).toBeLessThanOrEqual(narrow.width - CARD_MARGIN_PX);
  });
});

describe('a card too tall to sit clear is shortened, not laid over the thing (#4118)', () => {
  // Build's item card with More open: 240 x 540 on a phone, round an item whose rings reach 112 px.
  const TALL = { width: 240, height: 540 };
  const anchor = { x: 290, y: 440, radius: 112 };

  it('shortens the card to the room below (or above) the thing and keeps it clear of it', () => {
    const place = placeProductCard({ anchor, card: TALL, viewport: PHONE });
    expect(place.maxHeight).not.toBeNull();
    expect(place.maxHeight).toBeLessThan(TALL.height);
    expect(['above', 'below']).toContain(place.side);
    const top = place.top;
    const bottom = place.top + place.maxHeight;
    // clear of the circle round the thing: wholly below its bottom or wholly above its top
    const clear = top >= anchor.y + anchor.radius || bottom <= anchor.y - anchor.radius;
    expect(clear).toBe(true);
    expect(top).toBeGreaterThanOrEqual(CARD_TOP_CLEAR_PX);
    expect(bottom).toBeLessThanOrEqual(PHONE.height - CARD_MARGIN_PX);
  });

  it('does not shorten a card that fits at full height', () => {
    expect(placeProductCard({ anchor: { x: 195, y: 420, radius: 112 }, card: { width: 240, height: 150 }, viewport: PHONE }).maxHeight).toBeNull();
    expect(placeProductCard({ anchor: { x: 60, y: 420, radius: 30 }, card: CARD, viewport: PHONE }).maxHeight).toBeNull();
  });

  it('keeps the side it had unless the other has clearly more room', () => {
    const first = placeProductCard({ anchor, card: TALL, viewport: PHONE });
    const nudged = placeProductCard({ anchor: { ...anchor, y: anchor.y + 20 }, card: TALL, viewport: PHONE, previousSide: first.side });
    expect(nudged.side).toBe(first.side);
  });

  it('leaves a card overlapping, as before, when even a shortened one has no room', () => {
    const place = placeProductCard({ anchor: { x: 130, y: 300, radius: 140 }, card: TALL, viewport: { width: 260, height: 600 } });
    expect(place.maxHeight).toBeNull();
  });
});

describe('a thing that fills the view docks the card to an edge, clear of its middle (#4242)', () => {
  const phone = { width: 390, height: 844 };
  const card = { width: 240, height: 420 };
  const fills = (y, extra = {}) => ({ x: 195, y, radius: 140, behind: false, fills: true, ...extra });

  it('puts it on the bottom edge when the thing is in the top half, the top edge when in the bottom half', () => {
    const low = placeProductCard({ anchor: fills(300), card, viewport: phone });
    expect(low.side).toBe('below');
    expect(low.top + (low.maxHeight ?? card.height)).toBeLessThanOrEqual(phone.height - 12 + 0.5);
    const high = placeProductCard({ anchor: fills(600), card, viewport: phone });
    expect(high.side).toBe('above');
    expect(high.top).toBeGreaterThanOrEqual(52);
  });

  it('shortens it to a strip (it scrolls inside), with no pointer, centred across the screen', () => {
    const placed = placeProductCard({ anchor: fills(300), card, viewport: phone });
    expect(placed.maxHeight).toBeLessThanOrEqual(Math.ceil((844 - 52 - 12) * CARD_DOCK_MAX_SHARE));
    expect(placed.edge).toBe(true);
    expect(placed.left).toBe(75);
  });

  it('leaves a short card whole', () => {
    const placed = placeProductCard({ anchor: fills(300), card: { width: 240, height: 120 }, viewport: phone });
    expect(placed.maxHeight).toBeNull();
  });

  it('keeps the edge it has while the thing is near the middle, and moves only when clearly better', () => {
    const middle = 844 / 2;
    expect(placeProductCard({ anchor: fills(middle - 10), card, viewport: phone, previousSide: 'above' }).side).toBe('above');
    expect(placeProductCard({ anchor: fills(middle - 10), card, viewport: phone, previousSide: 'below' }).side).toBe('below');
    expect(placeProductCard({ anchor: fills(middle - 200), card, viewport: phone, previousSide: 'above' }).side).toBe('below');
  });

  it('never lies on the middle of a thing that fills the view, wherever it is (the owner, zoomed in on a wall)', () => {
    for (const y of [120, 300, 422, 560, 760]) {
      const placed = placeProductCard({ anchor: fills(y), card, viewport: phone });
      const bottom = placed.top + (placed.maxHeight ?? card.height);
      expect(placed.top <= 52 + 0.5 || bottom >= phone.height - 12 - 0.5, `y=${y}`).toBe(true); // against an edge
    }
  });

  it('leaves a thing that does not fill the view to the ordinary rules', () => {
    const ordinary = placeProductCard({ anchor: { x: 90, y: 400, radius: 40, behind: false }, card: { width: 200, height: 120 }, viewport: phone });
    expect(ordinary.side).toBe('right');
    expect(ordinary.edge).toBe(false);
  });
});

describe('the top bar stays clear (#3698)', () => {
  it('never puts any part of the card in the top bar, wherever the product is', () => {
    for (const y of [0, 20, 60, 80, 92, 120]) {
      for (const x of [20, 195, 370]) {
        const place = placeProductCard({ anchor: { x, y, radius: 30 }, card: { width: 240, height: 160 }, viewport: PHONE });
        expect(place.top).toBeGreaterThanOrEqual(CARD_TOP_CLEAR_PX);
      }
    }
  });
  it('does the same for a product off screen or behind the camera', () => {
    const behind = placeProductCard({ anchor: { x: NaN, y: NaN, radius: 0, behind: true }, card: { width: 240, height: 700 }, viewport: PHONE });
    expect(behind.top).toBeGreaterThanOrEqual(CARD_TOP_CLEAR_PX);
  });
  it('still keeps a card on screen on a screen too short to leave room', () => {
    const place = placeProductCard({ anchor: { x: 100, y: 100, radius: 20 }, card: { width: 240, height: 300 }, viewport: { width: 390, height: 320 } });
    expect(place.top).toBeGreaterThanOrEqual(CARD_TOP_CLEAR_PX);
  });
});

describe('clampAnchorRadius (#3651)', () => {
  it('floors a tiny radius, caps a huge one, and survives a bad number', () => {
    expect(clampAnchorRadius(0.2)).toBe(CARD_MIN_ANCHOR_RADIUS_PX);
    expect(clampAnchorRadius(4000)).toBe(CARD_MAX_ANCHOR_RADIUS_PX);
    expect(clampAnchorRadius(55)).toBe(55);
    expect(clampAnchorRadius(NaN)).toBe(CARD_MIN_ANCHOR_RADIUS_PX);
  });
});

describe('productCardState (#3651)', () => {
  const priced = { priceCents: 1200, isTestModel: false, stockQuantity: null };

  it('offers Buy for a priced, in-stock product the shopper stands next to, and Rate only with an unrated order (#3775)', () => {
    expect(productCardState({ template: priced, inRange: true })).toEqual({
      canBuy: true, canReview: false, canReturnPolicy: true, stateText: '',
    });
    expect(productCardState({ template: priced, inRange: true, hasUnratedOrder: true })).toEqual({
      canBuy: true, canReview: true, canReturnPolicy: true, stateText: '',
    });
  });

  it('never draws Rate without an unrated order, whatever else is true of the product (#3775)', () => {
    for (const template of [priced, { priceCents: null }, { priceCents: 5, isTestModel: true }, { priceCents: 5, stockQuantity: 0 }]) {
      for (const owned of [false, true]) {
        expect(productCardState({ template, inRange: true, owned }).canReview).toBe(false);
        expect(productCardState({ template, inRange: true, owned, hasUnratedOrder: true }).canReview).toBe(true);
        expect(productCardState({ template, inRange: false, owned, hasUnratedOrder: true }).canReview).toBe(false);
      }
    }
  });

  it('says to walk closer, and offers nothing, when the shopper is too far away', () => {
    const state = productCardState({ template: priced, inRange: false });
    expect(state.canBuy).toBe(false);
    expect(state.canReview).toBe(false);
    expect(state.canReturnPolicy).toBe(false);
    expect(state.stateText).toMatch(/closer/i);
  });

  it('shows no Buy petal, and says why, for every product that is not for sale', () => {
    const cases = [
      [{ priceCents: null }, /not for sale/i],
      [{ priceCents: 500, isTestModel: true }, /testing model/i],
      [{ priceCents: 500, stockQuantity: 0 }, /out of stock/i],
    ];
    for (const [template, words] of cases) {
      const state = productCardState({ template, inRange: true });
      expect(state.canBuy).toBe(false);
      expect(state.stateText).toMatch(words);
    }
  });

  it('still lets a shopper rate a product that is not for sale (when they have an unrated order), but describes no refund for it', () => {
    const state = productCardState({ template: { priceCents: null }, inRange: true, hasUnratedOrder: true });
    expect(state.canReview).toBe(true);
    expect(state.canReturnPolicy).toBe(false);
  });

  it('still describes the return policy of a priced product that is out of stock', () => {
    const state = productCardState({ template: { priceCents: 500, stockQuantity: 0 }, inRange: true });
    expect(state.canReturnPolicy).toBe(true);
    expect(state.canBuy).toBe(false);
  });

  it('treats unlimited stock (null) and stock above zero as in stock', () => {
    expect(productCardState({ template: { priceCents: 1, stockQuantity: 3 }, inRange: true }).canBuy).toBe(true);
    expect(productCardState({ template: { priceCents: 1, stockQuantity: null }, inRange: true }).canBuy).toBe(true);
  });
});

describe('productCardState, a product the shopper already owns (#3681)', () => {
  const priced = { priceCents: 1200, isTestModel: false, stockQuantity: null };

  it('says so and offers no Buy, but still lets them rate it and read its return policy', () => {
    expect(productCardState({ template: priced, inRange: true, owned: true, hasUnratedOrder: true })).toEqual({
      canBuy: false, canReview: true, canReturnPolicy: true, stateText: 'You already own this.',
    });
  });
  it('offers no rating or policy from out of reach, like the other states', () => {
    const state = productCardState({ template: priced, inRange: false, owned: true, hasUnratedOrder: true });
    expect(state.canBuy).toBe(false);
    expect(state.canReview).toBe(false);
    expect(state.canReturnPolicy).toBe(false);
  });
  it('is not mentioned for a product that is not for sale or is a testing model', () => {
    expect(productCardState({ template: { priceCents: null }, inRange: true, owned: true }).stateText).toBe('Not for sale.');
    expect(productCardState({ template: { priceCents: 5, isTestModel: true }, inRange: true, owned: true }).stateText).toMatch(/testing model/i);
  });
  it('a product not owned is unchanged', () => {
    expect(productCardState({ template: priced, inRange: true, owned: false }).canBuy).toBe(true);
    expect(productCardState({ template: priced, inRange: true }).canBuy).toBe(true);
  });
});

describe('sellerLine rating (#4375)', () => {
  it('adds the average and count once the seller has ratings', () => {
    expect(sellerLine('Maple Workshop', { ratingAverage: 4.75, ratingCount: 12 })).toBe('Sold by Maple Workshop · 4.8 ★ (12)');
  });
  it('says nothing about ratings for a seller with none', () => {
    expect(sellerLine('Maple Workshop', { ratingAverage: null, ratingCount: 0 })).toBe('Sold by Maple Workshop');
    expect(sellerLine('Maple Workshop', { ratingCount: 3 })).toBe('Sold by Maple Workshop');
  });
});

describe('sellerLine (#3680)', () => {
  it('says who sells the product, by the seller\'s storefront name', () => {
    expect(sellerLine('Maple Workshop')).toBe('Sold by Maple Workshop');
    expect(sellerLine('  Maple Workshop  ')).toBe('Sold by Maple Workshop');
  });
  it('says nothing when no name is known, rather than something made up', () => {
    expect(sellerLine(null)).toBe('');
    expect(sellerLine(undefined)).toBe('');
    expect(sellerLine('')).toBe('');
    expect(sellerLine('   ')).toBe('');
    expect(sellerLine(42)).toBe('');
  });
});

describe('a card keeps its side (#4118)', () => {
  // An expanded card on a phone fits on neither side, above nor below a thing in the middle of the screen
  // (Build's selected item sits at the orbit target), which used to flip from left to right every frame.
  // #4118: a short screen, where not even a shortened card has room above or below (the case that still overlaps).
  const BIG = { width: 235, height: 590 };
  const SHORT = { width: 390, height: 480 };
  const jitter = [194.6, 195.0, 195.4, 195.1, 194.9, 195.3, 194.7];

  it('an anchor jittering around the middle of the screen never changes the card\'s side', () => {
    let side = null;
    const seen = new Set();
    for (const x of jitter) {
      const place = placeProductCard({
        anchor: { x, y: 240, radius: 140 }, card: BIG, viewport: SHORT, previousSide: side,
      });
      side = place.side;
      seen.add(side);
    }
    expect(seen.size).toBe(1);
  });

  it('moves to the other side only once it is clearly better, and then stays there', () => {
    let side = 'right';
    const step = (x) => {
      side = placeProductCard({ anchor: { x, y: 240, radius: 140 }, card: BIG, viewport: SHORT, previousSide: side }).side;
      return side;
    };
    expect(step(200)).toBe('right'); // a little right of the middle: stays
    expect(step(215)).toBe('right'); // the left has 40 px more room: inside the margin
    expect(step(330)).toBe('left');  // clearly more room on the left now
    expect(step(200)).toBe('left');  // back near the middle: does not flip back
  });

  it('with no earlier side the old rule applies, and a side that fits is still chosen when both do', () => {
    const fresh = placeProductCard({ anchor: { x: 195, y: 240, radius: 140 }, card: BIG, viewport: SHORT });
    expect(fresh.side).toBe('left');
    const both = placeProductCard({ anchor: { x: 195, y: 400, radius: 20 }, card: { width: 100, height: 100 }, viewport: PHONE, previousSide: 'left' });
    expect(both.side).toBe('left');
    const bothFresh = placeProductCard({ anchor: { x: 195, y: 400, radius: 20 }, card: { width: 100, height: 100 }, viewport: PHONE });
    expect(bothFresh.side).toBe('right');
  });
});
