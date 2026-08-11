# Organic land-layout mockups

This is a product-choice artifact, not a production generator contract. The
three sketches in [`land-layout-families.svg`](mockups/land-layout-families.svg)
show layout families that can satisfy the circular availability model without
making the circle a polygon boundary. In every sketch, solid blue is the current
world circle and dashed land beyond it is already shaped but not selectable.

## A — Eroded mosaic

A seed-grown cell mosaic with uneven spacing, varied neighbor counts, and
shared seams relaxed into long curves. Cells meet at irregular three-way
junctions instead of crossing row-and-column lines, so the layout keeps a
flowing character without revealing an underlying grid, center, or preferred
direction.

- Strongest all-purpose organic appearance.
- Straightforward to grow locally from a previously generated frontier.
- Seed placement must use blue-noise spacing with deliberately varied density;
  jittering a square lattice is not sufficient and remains visibly predictable.
- Requires an explicit area-correction pass so 1,000 m² landlets remain exact.

### Broader sample

The [`large Eroded Mosaic sample`](mockups/eroded-mosaic-large.svg) shows 105
seed-grown cells across and beyond one availability circle. It is intended to
make the variation in cell size, neighbor count, orientation, and silhouette
easier to judge than the three-panel comparison.

## B — Watershed

Long branching seams imitate drainage basins and topographic watersheds. Small
tributary seams divide larger regions into individual lands.

- Most landscape-like large-scale structure.
- Can align naturally with future rivers and ridgelines.
- Harder to keep the power-law area distribution exact without distorting a
  branch near its leaves.

## C — Wind-carved

Broad, flowing seams share a prevailing direction, with intermittent cross
seams forming long irregular pieces.

- Most unusual silhouette and strongest sense of motion.
- Simple shared-curve topology makes gap/overlap guarantees easier.
- A global prevailing direction can become visually repetitive over a large
  world unless it changes gradually by region.

## Invariants for the production prototype

Whichever family is selected, the next implementation should treat the layout
as a planar subdivision rather than generating each polygon independently:

1. Store every seam once and have adjacent lands reference opposite sides of
   the same sampled curve.
2. Generate complete cells beyond the current world radius; never clip a land
   polygon to the availability circle.
3. Mark a cell selectable only when its farthest point is within the radius.
4. Keep partially intersecting cells generated and non-selectable.
5. Validate exact shared-edge identity, no interior overlap, no uncovered area,
   simple closed polygons, and target area before persistence.
6. Treat curved seams as canonical curves with a deterministic sampling rule so
   the frontend receives matching polygon vertices at every level of detail.

The existing annular-ring generator should remain legacy-only while one of
these families is prototyped. New production data should not be backfilled from
the ring algorithm, including `starter-landlet`; its replacement polygon should
come from the chosen subdivision so it shares real seams with its neighbors.
