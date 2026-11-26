// #4432: the stem's path, as pure numbers so it can be tested. It starts at the head's base (the bud is turned
// to point down and to the right, so its base is at its upper left) and the top of the stem curls into it: it
// rises beside the head, arcs over and meets the base moving down and to the right, along the bud's own axis, so
// the head reads as hanging from the curl. Then it runs down, curves across to the leaves' line and goes
// straight down to the last leaf. One path, no corner; it is drawn from the head outward, so the unfold grows it
// along its whole length, curl first (#4431).
export const STEM_CURL_REACH_PX = 14; // how far left of the base the stem rises
export const STEM_CURL_DROP_PX = 22; // how far below the base the curl has straightened out

export function stemPathD({ x0, y0, stemX, y1, y2, lastMid }) {
  const xv = Math.max(6, x0 - STEM_CURL_REACH_PX); // never off the left edge of the screen
  const reach = x0 - xv;
  const yc = y0 + STEM_CURL_DROP_PX;
  // The first curve leaves the base heading up and to the left (the axis, reversed), swings round and comes down
  // the vertical at xv. A cubic whose first control is the axis reversed from the base keeps the tangent at the
  // base exactly on the axis (45 degrees, down and right) with no kink.
  const k = Math.max(4, reach * 1.1);
  const head = `M ${x0} ${y0} C ${x0 - k} ${y0 - k} ${xv} ${y0 - 4} ${xv} ${yc}`;
  const top = Math.max(yc + 1, y1);
  const mid = (top + y2) / 2;
  return `${head} L ${xv} ${top} C ${xv} ${mid} ${stemX} ${mid} ${stemX} ${y2} L ${stemX} ${Math.max(y2 + 1, lastMid)}`;
}
