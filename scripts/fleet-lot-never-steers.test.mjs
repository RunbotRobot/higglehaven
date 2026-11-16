// #3597 piece 3 (AGENTS.md, "The fleet has a lándlet of its own in the live
// world and may use it freely; it is never used to steer people"). The fleet's
// lot (central-mosaic-012, owned by higglehaven0) is an ordinary lándlet that
// shoppers can find and buy from; nothing may feature it, spawn people at it,
// or send them to it. These pins fail if code starts to treat it specially.
import { describe, it, expect } from 'vitest';
import presenceAndContent from '../src/shop/presenceAndContent.js?raw';
import creditOrbs from '../worker/lib/credit-orbs.js?raw';
import social from '../worker/lib/social.js?raw';

// The test pool has no real filesystem, so shipped source is read through
// Vite's raw imports. Test files, and this one, are not shipped code.
const globbed = import.meta.glob(
  ['../src/**/*.{js,mjs,html}', '../worker/**/*.{js,mjs}', '../public/**/*.{js,html}', '!../**/*.test.*'],
  { query: '?raw', import: 'default', eager: true },
);
const sources = Object.keys(globbed);
const read = (p) => globbed[p];

describe('the fleet lándlet is never used to steer people', () => {
  it('scans a real set of shipped files', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('no shipped code names the fleet lot or its owner account', () => {
    const offenders = sources.filter((p) => /central-mosaic|higglehaven0/.test(read(p)));
    expect(offenders).toEqual([]);
  });

  it('no featured, suggested, home or default-landlet concept exists in code', () => {
    const offenders = sources.filter((p) => /featured_?landlet|suggested_?landlet|spawn_?landlet|home_?landlet|default_?landlet|starting_?landlet/i.test(read(p)));
    expect(offenders).toEqual([]);
  });

  it('Shop spawn takes no landlet: a position drawn over the whole disk', () => {
    const src = presenceAndContent;
    expect(src).toMatch(/export function pickShopSpawnLocation\(\) \{/);
    const body = src.slice(src.indexOf('export function pickShopSpawnLocation()'), src.indexOf('export function updateShopLandletInfo'));
    expect(body).not.toMatch(/shopLandlets|landlet_id|landletId/);
  });

  it('credit orbs only ever land on greenbelt landlets, so a claimed lot never gets them', () => {
    const src = creditOrbs;
    const body = src.slice(src.indexOf('export async function spawnCreditOrbIfDue'), src.indexOf('function creditOrbFromRow'));
    expect(body).toMatch(/status = 'greenbelt'/);
  });

  it('"Go to Last Location" reads only the caller\'s own presence row', () => {
    const src = social;
    const start = src.indexOf("route[1] === 'me'");
    const body = src.slice(start, src.indexOf("if (request.method === 'GET' && route.length === 1)", start));
    expect(body).toMatch(/WHERE user_id = \?/);
  });
});
