// #3417 (5/7 of #3412, "Everything built is always shown as itself"): a
// read-only, public endpoint that returns, for one tile of the world, every
// landlet's placements in the compact form of far-placements-encoding.js, so
// the client can draw distant landlets from tiny shared product models (6/7)
// without one full instance-list request per landlet.
//
// What it returns is exactly what a shopper sees up close, derived from data
// the server already holds and nothing the client supplies:
//   * a landlet with an active (published) version shows that version's frozen
//     copy; one that was never published shows its live draft (the same rule
//     the Shop loader applies, src/shop/presenceAndContent.js);
//   * a suspended builder's landlet is empty, a suspended or permanently
//     closed seller's products are left out (AGENTS.md "Nothing that isn't
//     actively for sale is visible to shoppers or builders"), and so are
//     delisted products (#3279);
//   * a placed product whose catalog row is gone is left out (nothing to draw).
//
// Tiles are fixed squares of FAR_PLACEMENT_TILE_M metres keyed by their landlet
// centres, so a landlet belongs to exactly one tile and the response for a tile
// can be cached and invalidated by tile.
//
// Cache: the Workers edge cache (caches.default), keyed by tile, no extra
// binding and no free-tier quota. A hit costs no D1 query. It is per data
// centre, so an explicit invalidation (invalidateFarPlacementsAt) reaches the
// data centre handling the write and every other one expires within
// FAR_PLACEMENT_CACHE_TTL_S; that bounded lag is the stated price of a global
// cache with no purge fan-out. See docs/API.md "Far placements".
import { json, HttpError } from './http.js';
import { builderNotSuspendedSql } from './auth.js';
import { encodeFarPlacements } from './far-placements-encoding.js';

export const FAR_PLACEMENT_TILE_M = 512;
export const FAR_PLACEMENT_CACHE_TTL_S = 60;
// A world radius of 20,000 m (the e2e "large world") is about 80 tiles each way.
const MAX_TILE_INDEX = 1000;

const cacheKeyFor = (tileX, tileY) => new Request(`https://far-placements.cache.invalid/tile/${tileX}/${tileY}`);

export function farPlacementTileFor(centerXM, centerYM) {
  return { x: Math.floor(centerXM / FAR_PLACEMENT_TILE_M), y: Math.floor(centerYM / FAR_PLACEMENT_TILE_M) };
}

// Drop the cached tile that holds a landlet centred at (centerXM, centerYM).
// Best effort and never throws: a cache problem must not fail the write that
// called it. Reaches this data centre only (see the header comment).
export async function invalidateFarPlacementsAt(centerXM, centerYM) {
  try {
    const tile = farPlacementTileFor(centerXM, centerYM);
    await caches.default.delete(cacheKeyFor(tile.x, tile.y));
  } catch {
    // ignore
  }
}

// Whether a placed product may be drawn for a shopper: the catalog row exists,
// is not delisted, and its seller is neither suspended nor permanently closed
// (the predicates #3033 and #3057 apply to the published-version read).
const TEMPLATE_VISIBLE_SQL = `EXISTS (
  SELECT 1 FROM catalog_templates t
  WHERE t.template_id = i.template_id AND t.delisted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM sellers s
      JOIN account_suspensions a ON a.user_id = s.user_id AND a.lifted_at IS NULL AND a.escalated_at IS NULL
      WHERE s.seller_id = t.seller_id
    )
    AND NOT EXISTS (SELECT 1 FROM closed_sellers c WHERE c.seller_id = t.seller_id)
)`;

const COLUMNS = `l.landlet_id AS landlet_id, l.center_x_m AS cx, l.center_y_m AS cy,
  i.template_id, i.x_m, i.y_m, i.z_m, i.rotation_x_rad, i.rotation_y_rad, i.rotation_z_rad, i.scale, i.crop_json`;

async function loadTileRows(db, tile) {
  const minX = tile.x * FAR_PLACEMENT_TILE_M;
  const minY = tile.y * FAR_PLACEMENT_TILE_M;
  const inTile = 'l.center_x_m >= ?1 AND l.center_x_m < ?2 AND l.center_y_m >= ?3 AND l.center_y_m < ?4';
  const bounds = [minX, minX + FAR_PLACEMENT_TILE_M, minY, minY + FAR_PLACEMENT_TILE_M];
  const { results } = await db.prepare(`
    SELECT * FROM (
      SELECT ${COLUMNS} FROM landlets l
      JOIN version_instances i ON i.version_id = l.active_version_id
      WHERE ${inTile} AND l.active_version_id IS NOT NULL
        AND ${builderNotSuspendedSql('l.owner_builder_id')} AND ${TEMPLATE_VISIBLE_SQL}
      UNION ALL
      SELECT ${COLUMNS} FROM landlets l
      JOIN placed_instances i ON i.landlet_id = l.landlet_id
      WHERE ${inTile} AND l.active_version_id IS NULL
        AND ${builderNotSuspendedSql('l.owner_builder_id')} AND ${TEMPLATE_VISIBLE_SQL}
    ) ORDER BY landlet_id, template_id, x_m, y_m, z_m
  `).bind(...bounds).all();
  return results;
}

function parseTile(url) {
  const raw = url.searchParams.get('tile');
  const match = typeof raw === 'string' ? raw.match(/^(-?\d{1,4}),(-?\d{1,4})$/) : null;
  if (!match) throw new HttpError('tile must be "x,y" (whole numbers)', 400);
  const tile = { x: Number(match[1]), y: Number(match[2]) };
  if (Math.abs(tile.x) > MAX_TILE_INDEX || Math.abs(tile.y) > MAX_TILE_INDEX) throw new HttpError('tile is outside the world', 400);
  return tile;
}

const withCacheHeader = (response, state) => {
  const out = new Response(response.body, response);
  out.headers.set('x-far-placements-cache', state);
  return out;
};

export async function handleFarPlacements(request, db, url) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  const tile = parseTile(url);
  const cache = caches.default;
  const key = cacheKeyFor(tile.x, tile.y);

  const cached = await cache.match(key);
  if (cached) return withCacheHeader(cached, 'hit');

  const rows = await loadTileRows(db, tile);
  const body = encodeFarPlacements({ x: tile.x, y: tile.y, sizeM: FAR_PLACEMENT_TILE_M }, rows);
  const response = json(body);
  response.headers.set('cache-control', `public, max-age=${FAR_PLACEMENT_CACHE_TTL_S}`);
  try {
    await cache.put(key, response.clone());
  } catch {
    // an unavailable cache only costs the next read a query
  }
  return withCacheHeader(response, 'miss');
}
