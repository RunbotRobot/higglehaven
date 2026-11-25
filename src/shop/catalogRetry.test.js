import { describe, it, expect } from 'vitest';
import { retryCatalogLater, CATALOG_RETRY_DELAYS_MS } from './catalogRetry.js';

function fakeTimers() {
  const pending = [];
  return {
    schedule: (fn, ms) => { const timer = { fn, ms }; pending.push(timer); return timer; },
    clear: (timer) => { const at = pending.indexOf(timer); if (at >= 0) pending.splice(at, 1); },
    pending,
    async fire() { const timer = pending.shift(); await timer.fn(); await Promise.resolve(); },
  };
}

describe('retryCatalogLater (#4295)', () => {
  it('asks again after the first wait and hands the catalog over when it arrives', async () => {
    const t = fakeTimers();
    const calls = [];
    const got = [];
    let fail = 2;
    retryCatalogLater({
      fetchCatalog: async () => { calls.push(1); if (fail-- > 0) throw new Error('down'); return [{ templateId: 'a' }]; },
      onCatalog: (catalog) => got.push(catalog),
      schedule: t.schedule, clear: t.clear,
    });
    expect(t.pending.map((x) => x.ms)).toEqual([CATALOG_RETRY_DELAYS_MS[0]]);
    await t.fire(); // fails
    expect(t.pending.map((x) => x.ms)).toEqual([CATALOG_RETRY_DELAYS_MS[1]]);
    await t.fire(); // fails
    expect(got).toEqual([]);
    await t.fire(); // arrives
    expect(got).toEqual([[{ templateId: 'a' }]]);
    expect(t.pending).toHaveLength(0);
    expect(calls).toHaveLength(3);
  });

  it('stops after the last wait and never asks again', async () => {
    const t = fakeTimers();
    let calls = 0;
    retryCatalogLater({ fetchCatalog: async () => { calls += 1; throw new Error('down'); }, onCatalog: () => {}, schedule: t.schedule, clear: t.clear });
    for (let i = 0; i < CATALOG_RETRY_DELAYS_MS.length; i += 1) await t.fire();
    expect(t.pending).toHaveLength(0);
    expect(calls).toBe(CATALOG_RETRY_DELAYS_MS.length);
  });

  it('cancel stops the pending ask and a late answer is dropped', async () => {
    const t = fakeTimers();
    const got = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const retry = retryCatalogLater({ fetchCatalog: () => gate.then(() => [1]), onCatalog: (c) => got.push(c), schedule: t.schedule, clear: t.clear });
    const firing = t.fire();
    retry.cancel();
    release();
    await firing;
    expect(got).toEqual([]);
    const t2 = fakeTimers();
    const r2 = retryCatalogLater({ fetchCatalog: async () => [1], onCatalog: () => {}, schedule: t2.schedule, clear: t2.clear });
    r2.cancel();
    expect(t2.pending).toHaveLength(0);
  });
});
