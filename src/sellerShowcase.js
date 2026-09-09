// #540: Sell mode's "faux lándlet" 3D array — pure layout/pagination math,
// split out from src/main.js (which wires this against the live THREE.js
// scene) so it can be unit-tested directly, per this project's own
// convention for genuinely dependency-free frontend modules (see
// vitest.config.js's own comment on src/**/*.test.js).

// A page's total never exceeds this budget — comfortably under
// MAX_MODEL_BYTES (worker/index.js's own single-upload cap, 20MB) so even a
// page of several large models stays well short of it, while still fitting
// more than one small product per page in the common case.
export const SELLER_SHOWCASE_PAGE_BYTES_CAP = 12 * 1024 * 1024;

// Every template uploaded before #540 added modelSizeBytes tracking has it
// as null — treated as this flat estimate for pagination purposes (rather
// than 0, which would let an unbounded number of legacy templates pile
// onto a single page) until it's actually re-uploaded and gets a real value.
export const SELLER_SHOWCASE_UNKNOWN_MODEL_SIZE_BYTES = 1 * 1024 * 1024;

// Clearance added around each page's own largest item's footprint when
// sizing that item's grid cell — keeps adjacent real (not scaled-down)
// product meshes from visually touching even at their widest declared
// dimension.
export const SELLER_SHOWCASE_CELL_MARGIN_M = 1.5;

// Greedy bin-packing by cumulative model size, in whatever order
// `templates` already arrives in (myProducts()'s own order, so this
// respects #542's shared sort/filter rather than re-sorting on its own) —
// never an empty page, so even a single template whose own size already
// exceeds the cap still gets a page to itself rather than being dropped.
export function computeSellerShowcasePages(templates) {
  const pages = [];
  let current = [];
  let currentBytes = 0;
  for (const template of templates) {
    const bytes = template.modelSizeBytes ?? SELLER_SHOWCASE_UNKNOWN_MODEL_SIZE_BYTES;
    if (current.length > 0 && currentBytes + bytes > SELLER_SHOWCASE_PAGE_BYTES_CAP) {
      pages.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(template);
    currentBytes += bytes;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

// A square-ish grid (columns first, so it stays roughly square as a page's
// item count grows) sized off that page's own largest item, so nothing
// overlaps regardless of how big any one product's declared dimensions
// are — real placed-instance meshes, not scaled-down thumbnails, per #540's
// owner-confirmed design. Returns each template alongside its grid
// position (col/row) and center offset (x/y) from the page's own origin,
// plus the overall ground-plane size those positions fit inside.
export function layoutSellerShowcasePage(templates) {
  const cellSize = Math.max(...templates.map((t) => Math.max(t.dimensions.width, t.dimensions.depth)))
    + SELLER_SHOWCASE_CELL_MARGIN_M;
  const columns = Math.ceil(Math.sqrt(templates.length));
  const rows = Math.ceil(templates.length / columns);
  const placements = templates.map((template, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    return {
      template,
      col,
      row,
      x: (col - (columns - 1) / 2) * cellSize,
      y: ((rows - 1) / 2 - row) * cellSize,
    };
  });
  return { cellSize, columns, rows, groundWidth: columns * cellSize, groundDepth: rows * cellSize, placements };
}
