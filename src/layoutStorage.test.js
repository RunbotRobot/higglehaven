import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadInstances, saveInstances } from './layoutStorage.js';

// loadInstances/saveInstances only ever touch localStorage directly — no
// three.js/DOM dependency, so (unlike meshCrop.js/modelOptimizer.js, #1254)
// this belongs in the ordinary dependency-free src/**/*.test.js pool. A
// plain in-memory Map stands in for the real Storage interface, same
// "stub the global, don't spin up a real browser" idiom api.test.js
// already uses for fetch.
function stubLocalStorage({ throwOnSetItem = false } = {}) {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (throwOnSetItem) throw new DOMException('QuotaExceededError');
      store.set(key, value);
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadInstances', () => {
  it('returns null when nothing has been saved yet', () => {
    stubLocalStorage();
    expect(loadInstances()).toBeNull();
  });

  it('round-trips whatever saveInstances last wrote', () => {
    stubLocalStorage();
    const instances = [{ id: 'a', templateId: 'crate', x: 1, y: 2 }];
    saveInstances(instances);
    expect(loadInstances()).toEqual(instances);
  });

  it('falls back to null rather than throwing on malformed stored JSON', () => {
    const store = stubLocalStorage();
    store.set('higglehaven.landlet.instances', '{not valid json');
    expect(loadInstances()).toBeNull();
  });
});

describe('saveInstances', () => {
  it('silently swallows a localStorage.setItem failure (quota exceeded, private browsing) rather than throwing', () => {
    stubLocalStorage({ throwOnSetItem: true });
    expect(() => saveInstances([{ id: 'a', templateId: 'crate', x: 0, y: 0 }])).not.toThrow();
  });
});
