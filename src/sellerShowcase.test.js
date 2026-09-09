import { describe, expect, it } from 'vitest';
import {
  computeSellerShowcasePages, layoutSellerShowcasePage,
  SELLER_SHOWCASE_PAGE_BYTES_CAP, SELLER_SHOWCASE_UNKNOWN_MODEL_SIZE_BYTES, SELLER_SHOWCASE_CELL_MARGIN_M,
} from './sellerShowcase.js';

function template(templateId, { modelSizeBytes = null, width = 1, depth = 1, height = 1 } = {}) {
  return { templateId, modelSizeBytes, dimensions: { width, depth, height } };
}

describe('computeSellerShowcasePages', () => {
  it('returns no pages for an empty template list', () => {
    expect(computeSellerShowcasePages([])).toEqual([]);
  });

  it('packs everything onto one page when well under the cap', () => {
    const templates = [template('a', { modelSizeBytes: 1000 }), template('b', { modelSizeBytes: 2000 })];
    expect(computeSellerShowcasePages(templates)).toEqual([templates]);
  });

  it('starts a new page once adding the next template would exceed the cap', () => {
    const a = template('a', { modelSizeBytes: SELLER_SHOWCASE_PAGE_BYTES_CAP - 100 });
    const b = template('b', { modelSizeBytes: 200 });
    const c = template('c', { modelSizeBytes: 100 });
    expect(computeSellerShowcasePages([a, b, c])).toEqual([[a], [b, c]]);
  });

  it('never produces an empty page, even for a single template already over the cap on its own', () => {
    const huge = template('huge', { modelSizeBytes: SELLER_SHOWCASE_PAGE_BYTES_CAP * 2 });
    const small = template('small', { modelSizeBytes: 100 });
    expect(computeSellerShowcasePages([huge, small])).toEqual([[huge], [small]]);
  });

  it('treats a null modelSizeBytes (a pre-#540 template) as the flat estimate, not zero', () => {
    // Enough legacy (null) templates to cross the cap purely off the flat
    // estimate — if null were treated as 0 bytes, this would all land on
    // one page instead.
    const count = Math.ceil(SELLER_SHOWCASE_PAGE_BYTES_CAP / SELLER_SHOWCASE_UNKNOWN_MODEL_SIZE_BYTES) + 1;
    const templates = Array.from({ length: count }, (_, i) => template(`legacy-${i}`));
    const pages = computeSellerShowcasePages(templates);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toHaveLength(count);
  });

  it('preserves input order (myProducts()/#542\'s own sort or filter), never re-sorting', () => {
    const templates = [template('z'), template('a'), template('m')];
    expect(computeSellerShowcasePages(templates)[0].map((t) => t.templateId)).toEqual(['z', 'a', 'm']);
  });
});

describe('layoutSellerShowcasePage', () => {
  it('lays out a single item in a 1x1 grid with the ground sized to its own footprint plus margin', () => {
    const t = template('solo', { width: 2, depth: 3 });
    const { columns, rows, cellSize, groundWidth, groundDepth, placements } = layoutSellerShowcasePage([t]);
    expect(columns).toBe(1);
    expect(rows).toBe(1);
    expect(cellSize).toBe(3 + SELLER_SHOWCASE_CELL_MARGIN_M);
    expect(groundWidth).toBe(cellSize);
    expect(groundDepth).toBe(cellSize);
    expect(placements).toEqual([{ template: t, col: 0, row: 0, x: 0, y: 0 }]);
  });

  it('sizes every cell off the page\'s largest item, not each item\'s own', () => {
    const small = template('small', { width: 1, depth: 1 });
    const huge = template('huge', { width: 10, depth: 4 });
    const { cellSize } = layoutSellerShowcasePage([small, huge]);
    expect(cellSize).toBe(10 + SELLER_SHOWCASE_CELL_MARGIN_M);
  });

  it('arranges a square-ish grid (ceil(sqrt(N)) columns) as item count grows', () => {
    const templates = Array.from({ length: 5 }, (_, i) => template(`t${i}`));
    const { columns, rows, placements } = layoutSellerShowcasePage(templates);
    expect(columns).toBe(3); // ceil(sqrt(5))
    expect(rows).toBe(2); // ceil(5 / 3)
    expect(placements).toHaveLength(5);
    // Every placement lands in a distinct, in-bounds grid cell.
    const cells = new Set(placements.map((p) => `${p.col},${p.row}`));
    expect(cells.size).toBe(5);
    for (const p of placements) {
      expect(p.col).toBeGreaterThanOrEqual(0);
      expect(p.col).toBeLessThan(columns);
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(rows);
    }
  });

  it('centers the grid on the origin — placements are symmetric around (0, 0)', () => {
    const templates = Array.from({ length: 4 }, (_, i) => template(`t${i}`));
    const { placements } = layoutSellerShowcasePage(templates);
    const xs = placements.map((p) => p.x).sort((a, b) => a - b);
    const ys = placements.map((p) => p.y).sort((a, b) => a - b);
    expect(xs[0]).toBe(-xs[xs.length - 1]);
    expect(ys[0]).toBe(-ys[ys.length - 1]);
  });
});
