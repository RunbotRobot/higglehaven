// #3737 (part of #3735): the hashed build files are cached for a year and never
// re-checked (a new build is a new name), the unhashed images and seed models for an
// hour, and index.html and the unhashed script keep revalidating so a deploy is picked up
// on the next open. Reads the real built app (public/_headers, copied into dist).
import { launchPage, finish } from './helpers.mjs';

const { browser, page, errors } = await launchPage({ promptAnswer: 'Cache Tester', viewport: { width: 390, height: 844 } });
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const origin = new URL(page.url()).origin;
const cacheControl = async (path) => {
  const res = await page.request.get(origin + path);
  return { status: res.status(), cc: res.headers()['cache-control'] || '' };
};

const html = await (await page.request.get(origin + '/')).text();
const hashed = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
check(hashed.length >= 3, `the page names its hashed files (${JSON.stringify(hashed)})`);
check(hashed.some((p) => /\/assets\/three-/.test(p)), 'the three.js chunk is its own hashed file');
for (const path of hashed) {
  const { status, cc } = await cacheControl(path);
  check(status === 200 && cc === 'public, max-age=31536000, immutable', `${path} is cached for a year, immutable (${status}, "${cc}")`);
}
for (const path of ['/wordmark.png', '/bird-standing.png', '/bird-flying.png', '/favicon.svg', '/models/crate.glb']) {
  const { status, cc } = await cacheControl(path);
  check(status === 200 && cc === 'public, max-age=3600, stale-while-revalidate=86400', `${path} is cached for an hour, refreshed in the background (${status}, "${cc}")`);
}
for (const path of ['/', '/viewport-refresh.js']) {
  const { status, cc } = await cacheControl(path);
  check(status === 200 && /max-age=0/.test(cc) && /must-revalidate/.test(cc), `${path} still revalidates on every open (${status}, "${cc}")`);
}

await finish(browser, { pass: pass && errors.length === 0, label: '#3737: hashed files are immutable; index.html and the unhashed script still revalidate', errors });
