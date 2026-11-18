import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import { ICON_KEYS, ICON_BY_ID, ICON_BY_MODE, iconKeyFor } from './budIcons.js';

// #3761: every leaf of the open bud is an icon with its word, so a leaf with no picture is a bug
// found here, not by a person staring at words only.
describe('the bud icons', () => {
  it('every id and mode maps to a drawn icon', () => {
    for (const [id, key] of Object.entries(ICON_BY_ID)) expect(ICON_KEYS, id).toContain(key);
    for (const [mode, key] of Object.entries(ICON_BY_MODE)) expect(ICON_KEYS, mode).toContain(key);
  });

  it('every button the account menu panel ships with has an icon', () => {
    const panel = indexHtml.slice(indexHtml.indexOf('id="account-menu-panel"'), indexHtml.indexOf('id="mode-nav"'));
    const ids = [...panel.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(4);
    for (const id of ids) expect(ICON_BY_ID[id], `${id} has no icon in src/ui/budIcons.js`).toBeTruthy();
  });

  it('the three modes are a shop front, a hammer and a price tag', () => {
    expect(iconKeyFor({ dataset: { mode: 'shop' }, id: '' })).toBe('shop');
    expect(iconKeyFor({ dataset: { mode: 'build' }, id: '' })).toBe('build');
    expect(iconKeyFor({ dataset: { mode: 'sell' }, id: '' })).toBe('sell');
  });

  it('an unknown leaf gets the plain leaf, never nothing', () => {
    expect(iconKeyFor({ dataset: {}, id: 'bud-petal-build-something-new' })).toBe('leaf');
  });
});
