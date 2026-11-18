import { describe, it, expect } from 'vitest';
import modeSource from './mode.js?raw';

// #3745: the public data requests start before the sign-in checks and the
// signed-in ones start as soon as sign-in is known, so the open does not pay
// for them one after another. Pinned as order in the source: a refactor that
// moves a fetch back behind an await puts the wait back.
describe('enterShopMode starts its requests together (#3745)', () => {
  const at = (needle) => {
    const index = modeSource.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it('starts catalog, world and landlets before awaiting the sign-in checks', () => {
    const authWait = at('await authInitPromise;');
    expect(at('const catalogLoad = fetchCatalog();')).toBeLessThan(authWait);
    expect(at('const worldLoad = Promise.all([fetchWorld(), fetchAllLandlets()]);')).toBeLessThan(authWait);
  });

  it('starts the signed-in requests right after the gate, before the world is awaited', () => {
    const gate = at("markLoadingStage('signedin');");
    const worldWait = at('[world, allLandlets] = await worldLoad;');
    for (const needle of ['const lastPresenceLoad =', 'const equippedAvatarLoad =', 'const equippedAnimationLoad =']) {
      expect(at(needle)).toBeGreaterThan(gate);
      expect(at(needle)).toBeLessThan(worldWait);
    }
  });

  it('no longer fetches the catalog or world inline', () => {
    expect(modeSource).not.toContain('await fetchCatalog()');
    expect(modeSource).not.toContain('await Promise.all([fetchWorld(), fetchAllLandlets()])');
  });
});
