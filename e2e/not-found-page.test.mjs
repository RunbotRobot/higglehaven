// #3695 (part of #3547): an address the app does not have answers 404 with a small page in
// the world's colours and one way back, for a browser; a missing file or API route keeps its
// plain 404. The page must load under the site's enforcing Content-Security-Policy.
import { launchPage, finish } from './helpers.mjs';

const session = await launchPage({ viewport: { width: 390, height: 844 } });
const { page } = session;
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const origin = new URL(page.url()).origin;

const response = await page.goto(`${origin}/nope-not-a-page`, { waitUntil: 'load' });
check(response?.status() === 404, `a mistyped address answers 404 (got ${response?.status()})`);
await page.waitForTimeout(500);
check((await page.textContent('h1'))?.includes('isn’t part of higglehaven'), 'the page says the address is not part of higglehaven');
check(await page.locator('img.wordmark').isVisible(), 'the wordmark shows');
const back = page.locator('a.back');
check(await back.isVisible() && (await back.getAttribute('href')) === '/', 'one visible way back, to the world');
check(await page.locator('style').count() === 0, 'the page uses no <style> element (the policy refuses it)');
check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page does not scroll sideways at phone width');
check(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1), 'the page fits one screen at 390x844');

// Anything that is not a page request keeps the plain 404.
const file = await page.request.get(`${origin}/models/not-a-model.glb`, { headers: { accept: '*/*' } });
check(file.status() === 404 && (await file.text()) === '', `a missing file keeps its plain 404 (got ${file.status()})`);
const api = await page.request.get(`${origin}/api/not-a-route`, { headers: { accept: 'text/html' } });
check(api.status() === 404 && (api.headers()['content-type'] || '').includes('application/json'), 'an API route keeps its JSON 404 even for a browser request');

// The page itself and its stylesheet are served as ordinary assets.
check((await page.request.get(`${origin}/not-found.css`)).status() === 200, 'its stylesheet is served');

// The way back works.
await page.goto(`${origin}/nope-not-a-page`, { waitUntil: 'load' });
await page.click('a.back');
await page.waitForLoadState('load');
check(new URL(page.url()).pathname === '/', 'tapping the button goes to the world');

// The 404 itself is the only console error this page is allowed to cause.
const unexpected = session.errors.filter((e) => !/404/.test(String(e)));
await finish(session.browser, { pass, label: '#3695: a mistyped address gets a friendly 404 page, other 404s stay plain', errors: unexpected });
