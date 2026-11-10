// #3385: at the world's edge the avatar and its follow camera are one rigid
// pair. The owner's rule (2026-11-10, #3374): "blocking both the camera and
// the avatar from crossing the dome boundary, while still keeping a constant
// distance between avatar and camera." The camera is always exactly the
// follow distance from the avatar's anchor along the look direction; when
// either end would cross the boundary the PAIR moves in, never one end alone,
// so the avatar gets closer to the dome when the camera faces it than when the
// camera faces the centre (accepted by the owner), and turning the camera is
// never blocked: the avatar slides inward just far enough instead.
//
// Pure (no three.js, no DOM) so the geometry is unit-tested directly
// (src/shop/rigidCameraPair.test.js).
//
// Horizontal geometry. The camera is the avatar plus a fixed horizontal offset
// (offsetX, offsetY) for a given look direction, and a shift of the pair moves
// both in (x, y) only, so each end's allowed radius (which depends only on its
// own height) is constant for the shift. The legal avatar positions are the
// intersection of two discs:
//   A: the avatar's own disc, centre (0, 0), radius avatarLimitM
//   B: the disc whose members put the camera inside its limit, centre
//      (-offsetX, -offsetY), radius cameraLimitM
// Both are convex, so the legal set is convex and the nearest legal point to
// the avatar is exact in closed form (no iteration): the avatar's own
// projection onto whichever disc it sits outside, or, when that lands outside
// the other disc, the nearer corner where the two circles cross.

function clampToDisc(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius) return { x, y };
  const scale = radius / distance;
  return { x: cx + dx * scale, y: cy + dy * scale };
}

const inDisc = (point, cx, cy, radius) => Math.hypot(point.x - cx, point.y - cy) <= radius + 1e-9;

// Returns the legal (x, y) nearest to the avatar's, or null when the two discs
// do not overlap (a world so small that no avatar position keeps the camera
// inside; the caller then bounds the camera alone, as before #3385).
export function keepPairInside({ x, y, offsetX, offsetY, avatarLimitM, cameraLimitM }) {
  const bx = -offsetX;
  const by = -offsetY;
  const a = Math.max(0, avatarLimitM);
  const b = Math.max(0, cameraLimitM);
  const here = { x, y };
  if (inDisc(here, 0, 0, a) && inDisc(here, bx, by, b)) return here;

  const centres = Math.hypot(bx, by);
  if (centres > a + b) return null; // no overlap at all
  // One disc inside the other: the smaller one is the whole legal set.
  if (centres + Math.min(a, b) <= Math.max(a, b)) {
    return a <= b ? clampToDisc(x, y, 0, 0, a) : clampToDisc(x, y, bx, by, b);
  }

  const onA = clampToDisc(x, y, 0, 0, a);
  if (inDisc(onA, bx, by, b)) return onA;
  const onB = clampToDisc(x, y, bx, by, b);
  if (inDisc(onB, 0, 0, a)) return onB;

  // The nearest legal point is a corner where the two circles cross.
  const along = (a * a - b * b + centres * centres) / (2 * centres);
  const half = Math.sqrt(Math.max(0, a * a - along * along));
  const ux = bx / centres;
  const uy = by / centres;
  const mx = ux * along;
  const my = uy * along;
  const c1 = { x: mx - uy * half, y: my + ux * half };
  const c2 = { x: mx + uy * half, y: my - ux * half };
  return Math.hypot(c1.x - x, c1.y - y) <= Math.hypot(c2.x - x, c2.y - y) ? c1 : c2;
}
