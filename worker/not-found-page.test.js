// #3695: a mistyped address gets a small page for a browser and keeps its plain 404 for everything else.
import { describe, it, expect } from 'vitest';
import { withNotFoundPage, wantsHtmlPage } from './lib/not-found-page.js';

const PAGE = '<!doctype html><title>Not here</title>';
const env = (pageResponse) => ({ ASSETS: { fetch: async (request) => (new URL(request.url).pathname === '/not-found' ? pageResponse() : new Response(null, { status: 404 })) } });
const htmlPage = () => new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const asset404 = () => new Response(null, { status: 404 });
const get = (path, accept, method = 'GET') => new Request(`https://example.test${path}`, { method, headers: accept ? { accept } : {} });

describe('withNotFoundPage', () => {
  it('answers a browser page request for a missing address with the page, still a 404', async () => {
    const response = await withNotFoundPage(get('/nope', 'text/html,application/xhtml+xml'), env(htmlPage), asset404());
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(PAGE);
  });

  it('keeps the plain 404 for a request that does not ask for a page', async () => {
    for (const accept of [undefined, 'image/png', '*/*', 'application/json']) {
      const response = await withNotFoundPage(get('/models/x.glb', accept), env(htmlPage), asset404());
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
  });

  it('leaves anything that is not a 404 alone', async () => {
    const ok = new Response('hello', { status: 200 });
    expect(await withNotFoundPage(get('/', 'text/html'), env(htmlPage), ok)).toBe(ok);
  });

  it('leaves a non-GET request alone, and answers HEAD with no body', async () => {
    expect(wantsHtmlPage(get('/x', 'text/html', 'POST'))).toBe(false);
    const head = await withNotFoundPage(get('/x', 'text/html', 'HEAD'), env(htmlPage), asset404());
    expect(head.status).toBe(404);
    expect(await head.text()).toBe('');
  });

  it('falls back to the plain 404 when the page cannot be read', async () => {
    const original = asset404();
    expect(await withNotFoundPage(get('/x', 'text/html'), env(() => new Response('', { status: 404 })), original)).toBe(original);
    expect(await withNotFoundPage(get('/x', 'text/html'), env(() => { throw new Error('boom'); }), original)).toBe(original);
    expect(await withNotFoundPage(get('/x', 'text/html'), env(() => new Response('x', { status: 200, headers: { 'content-type': 'application/json' } })), original)).toBe(original);
  });
});
