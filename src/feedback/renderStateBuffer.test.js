import { beforeEach, describe, expect, it } from 'vitest';
import { clearRenderStateBuffer, getRenderStateBuffer, recordRenderStateSample } from './renderStateBuffer.js';

// Module-level buffer state, so every test starts from a clean slate --
// same reasoning layoutStorage.test.js's own afterEach(vi.unstubAllGlobals)
// comment gives for not letting one test's state leak into the next.
beforeEach(() => {
  clearRenderStateBuffer();
});

describe('getRenderStateBuffer', () => {
  it('starts empty', () => {
    expect(getRenderStateBuffer()).toEqual([]);
  });

  it('returns a recorded sample with its timestamp merged in', () => {
    recordRenderStateSample(1000, { uTime: 4.2 });
    expect(getRenderStateBuffer()).toEqual([{ timestampMs: 1000, uTime: 4.2 }]);
  });

  it('returns samples oldest first, in recorded order', () => {
    recordRenderStateSample(1000, { uTime: 1 });
    recordRenderStateSample(2000, { uTime: 2 });
    recordRenderStateSample(3000, { uTime: 3 });
    expect(getRenderStateBuffer().map((s) => s.uTime)).toEqual([1, 2, 3]);
  });

  it('returns a copy -- mutating the result never corrupts the internal buffer', () => {
    recordRenderStateSample(1000, { uTime: 1 });
    const first = getRenderStateBuffer();
    first[0].uTime = 999;
    first.push({ timestampMs: 2000, uTime: 2 });
    expect(getRenderStateBuffer()).toEqual([{ timestampMs: 1000, uTime: 1 }]);
  });
});

describe('recordRenderStateSample', () => {
  it('throttles to ~1Hz -- a second call inside the same 1000ms window is dropped', () => {
    recordRenderStateSample(1000, { uTime: 1 });
    recordRenderStateSample(1500, { uTime: 2 }); // < 1000ms after the last accepted sample
    expect(getRenderStateBuffer().map((s) => s.uTime)).toEqual([1]);
  });

  it('accepts a sample exactly 1000ms after the last one', () => {
    recordRenderStateSample(1000, { uTime: 1 });
    recordRenderStateSample(2000, { uTime: 2 });
    expect(getRenderStateBuffer().map((s) => s.uTime)).toEqual([1, 2]);
  });

  it('trims samples older than the ~60s window as new ones come in', () => {
    recordRenderStateSample(0, { uTime: 0 });
    recordRenderStateSample(1000, { uTime: 1 });
    recordRenderStateSample(61000, { uTime: 61 }); // 61s after the first -- it should fall out
    expect(getRenderStateBuffer().map((s) => s.uTime)).toEqual([1, 61]);
  });

  it('never grows past what the ~60s window at ~1Hz implies, even over a long run', () => {
    for (let t = 0; t <= 600000; t += 1000) {
      recordRenderStateSample(t, { t });
    }
    const buffer = getRenderStateBuffer();
    expect(buffer.length).toBeLessThanOrEqual(61);
    expect(buffer[buffer.length - 1].timestampMs - buffer[0].timestampMs).toBeLessThanOrEqual(60000);
  });
});

describe('clearRenderStateBuffer', () => {
  it('empties the buffer', () => {
    recordRenderStateSample(1000, { uTime: 1 });
    clearRenderStateBuffer();
    expect(getRenderStateBuffer()).toEqual([]);
  });

  it('re-arms the throttle so the next sample is always accepted regardless of timing', () => {
    recordRenderStateSample(1000, { uTime: 1 });
    recordRenderStateSample(1100, { uTime: 2 }); // dropped, throttled
    clearRenderStateBuffer();
    recordRenderStateSample(1150, { uTime: 3 }); // would be dropped if the throttle weren't reset
    expect(getRenderStateBuffer().map((s) => s.uTime)).toEqual([3]);
  });
});
