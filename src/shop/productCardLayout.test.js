import { describe, expect, it } from 'vitest';
import {
  CARD_GAP_PX, CARD_MARGIN_PX, CARD_MAX_ANCHOR_RADIUS_PX, CARD_MIN_ANCHOR_RADIUS_PX,
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
    expect(top.top).toBe(CARD_MARGIN_PX);
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

  it('keeps the card on screen even when neither side has room', () => {
    const narrow = { width: 260, height: 600 };
    const place = placeProductCard({ anchor: { x: 130, y: 300, radius: 80 }, card: CARD, viewport: narrow });
    expect(place.left).toBeGreaterThanOrEqual(CARD_MARGIN_PX);
    expect(place.left + CARD.width).toBeLessThanOrEqual(narrow.width - CARD_MARGIN_PX);
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

  it('offers Buy and Rate for a priced, in-stock product the shopper stands next to', () => {
    expect(productCardState({ template: priced, inRange: true })).toEqual({
      canBuy: true, canReview: true, canReturnPolicy: true, stateText: '',
    });
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

  it('still lets a shopper rate a product that is not for sale, but describes no refund for it', () => {
    const state = productCardState({ template: { priceCents: null }, inRange: true });
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
