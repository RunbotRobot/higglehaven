// #2501: shared HTTP response/error/request helpers, used from worker/
// index.js's own route dispatcher and nearly every handle* route handler
// (json: 104 distinct handle* callers + 15 other internal callers;
// HttpError: 72 distinct handle* callers + 100 other internal callers;
// clientIp: 15+ distinct handle* callers, spanning rate-limiting bucket
// keys and unrelated uses like presence IP logging) -- genuinely
// cross-cutting, not something any one feature area owns. Extracted
// verbatim, zero behavior change.

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export function json(payload, status = 200, extraHeaders) {
  const headers = extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS;
  return new Response(JSON.stringify(payload, null, 2), { status, headers });
}

// #1954: stable, machine-readable error codes. The English `message` on an
// HttpError is written for logs, tests and developers and may be reworded at
// any time; a client that needs to say something to a player maps on `code`
// instead (src/errorCopy.js owns the player-facing copy, and a test fails if a
// code here has no copy there). Pass one as `{ code: ERROR_CODES.X }` in the
// third argument: it travels in the response body next to `error`. An error
// with no code keeps showing its own message, which is right for the many
// validation and auth messages that are already written for players.
export const ERROR_CODES = Object.freeze({
  INTERNAL_ERROR: 'internal_error',
  CHANGED_CONCURRENTLY: 'changed_concurrently',
  LANDLET_NOT_FOUND: 'landlet_not_found',
  LANDLET_NOT_CLAIMABLE: 'landlet_not_claimable',
  LANDLET_OWNERSHIP_LOST: 'landlet_ownership_lost',
  AUCTION_ALREADY_ACTIVE: 'auction_already_active',
  AUCTION_NOT_OWNER: 'auction_not_owner',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  UPSTREAM_FAILED: 'upstream_failed',
  STALE_REFERENCE: 'stale_reference',
  SELLER_SUSPENDED: 'seller_suspended',
});

export class HttpError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
    this.code = extra?.code ?? null;
  }
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

// #2529: same shared-response-helper shape as json above, for the handful
// of plain-HTML routes (Control Room/admin pages, their sign-in gate) --
// extracted verbatim, zero behavior change.
export function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
