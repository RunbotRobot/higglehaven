import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('startupMarks', () => {
  beforeEach(() => { vi.resetModules(); });

  it('records each stage once, in order, with whole-millisecond times', async () => {
    const entries = [];
    vi.stubGlobal('performance', {
      mark: (name) => entries.push({ name, startTime: 100.4 + entries.length * 10 }),
      getEntriesByType: () => [...entries, { name: 'other', startTime: 1 }],
    });
    const { markStartup, getStartupTimings } = await import('./startupMarks.js');
    markStartup('bootstrap-start');
    markStartup('catalog');
    markStartup('catalog'); // a later mode switch must not overwrite the first open
    expect(getStartupTimings()).toEqual({ 'bootstrap-start': 100, catalog: 110 });
    expect(Object.keys(getStartupTimings())).toEqual(['bootstrap-start', 'catalog']);
    vi.unstubAllGlobals();
  });

  it('never throws without the Performance API', async () => {
    vi.stubGlobal('performance', undefined);
    const { markStartup, getStartupTimings } = await import('./startupMarks.js');
    expect(() => markStartup('x')).not.toThrow();
    expect(getStartupTimings()).toEqual({});
    vi.unstubAllGlobals();
  });
});
