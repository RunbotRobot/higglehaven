// #3695 (part of #3547): an address the app does not have used to answer 404 with an
// empty body: a blank page for someone following an old or mistyped link. For a request
// from a browser (it accepts HTML) the 404 now carries a small page in the world's own
// colours with one way back. Everything that is not a page request (a missing model, an
// image, a script, any API call) keeps the plain 404 it had.

const NOT_FOUND_PAGE_PATH = '/not-found';

export function wantsHtmlPage(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

// `assetResponse` is what the static assets answered. Returns it unchanged unless it is a
// 404 for a page request and the not-found page itself can be read.
export async function withNotFoundPage(request, env, assetResponse) {
  if (assetResponse.status !== 404 || !wantsHtmlPage(request)) return assetResponse;
  try {
    const pageUrl = new URL(NOT_FOUND_PAGE_PATH, request.url);
    const page = await env.ASSETS.fetch(new Request(pageUrl, { method: 'GET', headers: { accept: 'text/html' } }));
    if (page.status !== 200 || !(page.headers.get('content-type') ?? '').includes('text/html')) return assetResponse;
    const headers = new Headers(page.headers);
    headers.set('cache-control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers });
  } catch {
    return assetResponse;
  }
}
