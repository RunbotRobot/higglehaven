// #4198: where a move in Build has to stop so the item stays on its own lándlet. Pure functions over the shared
// definition (shared/landlet-outline.js), so what Build lets through is exactly what the Worker will accept
// ("A gesture is constrained while it happens": never accept a move the server will refuse).
//
// A move is a request for a new place for one item (or an offset for a bundle). If the place is legal it is taken.
// If not, the item is slid: first along each axis alone (so it runs along a slanted edge instead of sticking to it),
// then pulled back along the line to where it started, to the last legal point. An item that was already off the
// lándlet (stored before this rule) has no legal start to pull back to: it stays where it is until the finger
// reaches ground that is legal, and then it jumps there.
import { footprintCorners, footprintInsideOutline, scaleOutline, parseOutline } from '../../shared/landlet-outline.js';

const SEARCH_STEPS = 24;

// The outline Build is working on, in the lándlet's own coordinates; null until a lándlet with a usable polygon is
// loaded (then the caller keeps its square limit).
let activeOutline = null;
export function setBuildOutline(polygon) {
  activeOutline = parseOutline(polygon);
}
export function getBuildOutline() {
  return activeOutline;
}

function legal(outline, size, x, y, z, rotationZ, heightScale) {
  const scaled = scaleOutline(outline, heightScale(z));
  return footprintInsideOutline(scaled, footprintCorners({ x, y, width: size.width, depth: size.depth, rotationZ }));
}

// Is this item, at this place, entirely on the lándlet?
export function itemLegalAt(outline, item, x, y, z, heightScale = () => 1) {
  return legal(outline, item, x, y, z, item.rotationZ ?? 0, heightScale);
}

// One item. `item` is { width, depth, rotationZ }, `from` the last place it was (x, y), `to` where the finger asks
// (x, y), `z` its height. Returns { x, y, limited }.
export function limitItemMove(outline, item, from, to, z, heightScale = () => 1) {
  const rotationZ = item.rotationZ ?? 0;
  const ok = (x, y) => legal(outline, item, x, y, z, rotationZ, heightScale);
  if (ok(to.x, to.y)) return { x: to.x, y: to.y, limited: false };
  if (!ok(from.x, from.y)) return { x: from.x, y: from.y, limited: true };
  // The candidates: slide along one axis at a time (the part of the move that is still legal is kept), or pull back
  // along the line to the last legal point. Whichever lands nearest what was asked wins, so a diagonal drag into a
  // slanted edge runs along it and a straight push into a wall stops at the wall.
  const candidates = [pullBack(from, to, ok)];
  if (ok(to.x, from.y)) candidates.push({ x: to.x, y: from.y });
  if (ok(from.x, to.y)) candidates.push({ x: from.x, y: to.y });
  candidates.sort((a, b) => Math.hypot(to.x - a.x, to.y - a.y) - Math.hypot(to.x - b.x, to.y - b.y));
  return { ...candidates[0], limited: true };
}

// The last legal point on the line from `from` (legal) toward `to`.
function pullBack(from, to, ok) {
  let low = 0;
  let high = 1;
  for (let i = 0; i < SEARCH_STEPS; i += 1) {
    const mid = (low + high) / 2;
    if (ok(from.x + (to.x - from.x) * mid, from.y + (to.y - from.y) * mid)) low = mid;
    else high = mid;
  }
  return { x: from.x + (to.x - from.x) * low, y: from.y + (to.y - from.y) * low };
}

// A new item with no previous place (tap to place, paste): the nearest legal point on the line from the lándlet's
// centre to where it was asked for. The centre itself may be off the lándlet for an odd shape; then the item stays
// at the request and the caller's other limits apply.
export function limitItemPlacement(outline, item, to, z, heightScale = () => 1) {
  return limitItemMove(outline, item, { x: 0, y: 0 }, to, z, heightScale);
}

// A bundle moved as one rigid body: `members` is [{ item, start: { x, y }, z }], `offset` the finger's total offset
// from where the bundle started. Every member must be legal at start + offset. Returns the offset to use.
export function limitGroupOffset(outline, members, offset, heightScale = () => 1) {
  const fits = (dx, dy) => members.every((member) => legal(
    outline, member.item, member.start.x + dx, member.start.y + dy, member.z, member.item.rotationZ ?? 0, heightScale,
  ));
  if (fits(offset.x, offset.y)) return { x: offset.x, y: offset.y, limited: false };
  if (!fits(0, 0)) return { x: 0, y: 0, limited: true };
  const candidates = [pullBack({ x: 0, y: 0 }, offset, fits)];
  if (fits(offset.x, 0)) candidates.push({ x: offset.x, y: 0 });
  if (fits(0, offset.y)) candidates.push({ x: 0, y: offset.y });
  candidates.sort((a, b) => Math.hypot(offset.x - a.x, offset.y - a.y) - Math.hypot(offset.x - b.x, offset.y - b.y));
  return { ...candidates[0], limited: true };
}
