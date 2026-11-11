// #3477 (1/4 of #3418, part of #3412): what the far view should draw, as pure
// functions (no three.js, no DOM) so it is unit-testable. Drawing the result is
// leaf 2/4 (#3478); the handover with the normal loader is 3/4 (#3479).
//
// Owner decision "Everything built is always shown as itself: simplified with
// distance, never replaced by a stand-in and never left out": every landlet in
// view beyond the full-load radius is drawn from its products' far models. The
// only things dropped are an item too small to see (under one pixel), and, on a
// device that cannot draw everything, the smallest on screen first.
import { apparentSizePx } from './lodTier.js';
import { horizontalDistanceM } from './loadRadius.js';

// Must match worker/lib/far-placements.js FAR_PLACEMENT_TILE_M.
export const FAR_VIEW_TILE_M = 512;

// An item whose bounding sphere is narrower than this many CSS pixels on screen
// covers less than about one pixel and adds nothing to the picture.
export const FAR_VIEW_MIN_PX = 1;

// Caps for a phone-class device, in view at once. A far model is at most about
// 200 triangles (src/modelTiers.js), so 2,000 instances at full size is the
// triangle cap; most far models are smaller, so the instance cap binds only
// for very small products. The smallest on screen are dropped first.
export const FAR_VIEW_MAX_INSTANCES = 4000;
export const FAR_VIEW_MAX_TRIANGLES = 400_000;

// How far out the far view reaches, from the avatar. The world is a few
// kilometres across; beyond this the horizon haze hides everything anyway.
export const FAR_VIEW_RANGE_M = 2500;

// Tiles whose square comes within `rangeM` of (x, y), nearest first.
export function farViewTilesInRange(x, y, rangeM = FAR_VIEW_RANGE_M, tileM = FAR_VIEW_TILE_M) {
  const tiles = [];
  const minX = Math.floor((x - rangeM) / tileM);
  const maxX = Math.floor((x + rangeM) / tileM);
  const minY = Math.floor((y - rangeM) / tileM);
  const maxY = Math.floor((y + rangeM) / tileM);
  for (let tx = minX; tx <= maxX; tx++) {
    for (let ty = minY; ty <= maxY; ty++) {
      const nearestX = Math.min(Math.max(x, tx * tileM), (tx + 1) * tileM);
      const nearestY = Math.min(Math.max(y, ty * tileM), (ty + 1) * tileM);
      const distance = horizontalDistanceM(x, y, nearestX, nearestY);
      if (distance <= rangeM) tiles.push({ x: tx, y: ty, distance });
    }
  }
  return tiles.sort((a, b) => a.distance - b.distance || a.x - b.x || a.y - b.y);
}

export function farViewTileKey(tile) {
  return `${tile.x},${tile.y}`;
}

// Turns a `GET /api/far-placements` payload into named items with world
// positions (the landlet's centre added), grouped by landlet. Same shape as the
// server encoding (worker/lib/far-placements-encoding.js decodeFarPlacements),
// with `cx`/`cy` already applied.
export function decodeFarPlacementsPayload(payload) {
  const templates = Array.isArray(payload?.templates) ? payload.templates : [];
  const landlets = Array.isArray(payload?.landlets) ? payload.landlets : [];
  return landlets.map((landlet) => ({
    id: landlet.id,
    cx: landlet.cx,
    cy: landlet.cy,
    items: (landlet.items ?? []).flatMap(([t, x, y, z, rotationX, rotationY, rotationZ, scale, crop]) => {
      const templateId = templates[t];
      if (templateId === undefined) return [];
      return [{
        templateId, x: landlet.cx + x, y: landlet.cy + y, z,
        localX: x, localY: y, rotationX, rotationY, rotationZ, scale, crop: crop ?? null,
      }];
    }),
  }));
}

// Chooses what to draw.
//   landlets   decoded landlets (decodeFarPlacementsPayload), any number of tiles
//   loadedIds  Set of landlet ids the normal loader has loaded: not drawn here
//   camera     { x, y, z } world position
//   view       { fovDeg, viewportHeightPx }
//   models     { radiusM(templateId, scale) -> metres, triangles(templateId) -> count,
//                has(templateId) -> boolean (a far model exists to draw) }
//   caps       { maxInstances, maxTriangles, minPx }
// Returns { byTemplate: Map<templateId, item[]>, stats } where each item gains
// `px`, and stats counts what was kept and why anything was left out.
export function planFarView({ landlets, loadedIds, camera, view, models, caps = {} }) {
  const maxInstances = caps.maxInstances ?? FAR_VIEW_MAX_INSTANCES;
  const maxTriangles = caps.maxTriangles ?? FAR_VIEW_MAX_TRIANGLES;
  const minPx = caps.minPx ?? FAR_VIEW_MIN_PX;
  const stats = {
    landlets: 0, skippedLoaded: 0, candidates: 0, tooSmall: 0, noModel: 0, overBudget: 0, instances: 0, triangles: 0,
  };
  const candidates = [];
  for (const landlet of landlets) {
    if (loadedIds?.has(landlet.id)) { stats.skippedLoaded += 1; continue; }
    stats.landlets += 1;
    for (const item of landlet.items) {
      stats.candidates += 1;
      if (!models.has(item.templateId)) { stats.noModel += 1; continue; }
      const dx = item.x - camera.x;
      const dy = item.y - camera.y;
      const dz = item.z - camera.z;
      const px = apparentSizePx(models.radiusM(item.templateId, item.scale ?? 1), Math.hypot(dx, dy, dz), view.fovDeg, view.viewportHeightPx);
      if (px < minPx) { stats.tooSmall += 1; continue; }
      candidates.push({ ...item, px, landletId: landlet.id });
    }
  }
  // Largest on screen first, so the budget keeps the most visible items and a
  // build queue fed in this order also builds the largest first.
  candidates.sort((a, b) => b.px - a.px);
  const byTemplate = new Map();
  let triangles = 0;
  let instances = 0;
  for (const item of candidates) {
    const cost = models.triangles(item.templateId);
    if (instances >= maxInstances || triangles + cost > maxTriangles) { stats.overBudget += 1; continue; }
    instances += 1;
    triangles += cost;
    let list = byTemplate.get(item.templateId);
    if (!list) byTemplate.set(item.templateId, list = []);
    list.push(item);
  }
  stats.instances = instances;
  stats.triangles = triangles;
  return { byTemplate, stats };
}
