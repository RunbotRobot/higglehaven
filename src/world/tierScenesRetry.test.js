// #4309: a failed load of a product's simpler versions is not remembered as the answer for the visit.
import { afterEach, describe, expect, it, vi } from 'vitest';

const noop = () => {};
globalThis.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => noop, set: () => true }) }),
};
const { loadTierScenes, TIER_SCENES_RETRY_AFTER_MS } = await import('./models.js');

describe('loadTierScenes after a failed load (#4309)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('asks again after the retry pause, not on the very next call', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    const template = { templateId: 't-4309', modelUrl: 'http://models.test/retry-4309.glb' };

    const first = await loadTierScenes(template);
    expect(first).toEqual({ mid: null, far: null });
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await loadTierScenes(template);
    expect(fetchMock.mock.calls.length).toBe(afterFirst);

    await vi.advanceTimersByTimeAsync(TIER_SCENES_RETRY_AFTER_MS + 1);
    await loadTierScenes(template);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
    vi.unstubAllGlobals();
  });
});
