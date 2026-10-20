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

export class HttpError extends Error {
  constructor(message, status, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}
