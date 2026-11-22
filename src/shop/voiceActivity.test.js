import { describe, it, expect, vi } from 'vitest';
import { rmsOfByteSamples, createSpeakingDetector, watchVoiceActivity, VOICE_HOLD_MS } from './voiceActivity.js';

describe('rmsOfByteSamples', () => {
  it('is 0 for silence and for nothing', () => {
    expect(rmsOfByteSamples(new Uint8Array(64).fill(128))).toBe(0);
    expect(rmsOfByteSamples(new Uint8Array(0))).toBe(0);
  });
  it('reads a loud square wave near its amplitude', () => {
    const b = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) b[i] = i % 2 ? 192 : 64;
    expect(rmsOfByteSamples(b)).toBeCloseTo(0.5, 2);
  });
});

describe('createSpeakingDetector', () => {
  it('starts speaking at the on level and keeps through a short pause', () => {
    const d = createSpeakingDetector();
    expect(d.update(0.005, 0)).toBe(false);
    expect(d.update(0.05, 100)).toBe(true);
    expect(d.update(0.001, 100 + VOICE_HOLD_MS - 10)).toBe(true);
    expect(d.update(0.001, 100 + VOICE_HOLD_MS + 50)).toBe(false);
  });
  it('a level between off and on keeps it going but does not start it', () => {
    const d = createSpeakingDetector();
    expect(d.update(0.015, 0)).toBe(false);
    d.update(0.05, 10);
    expect(d.update(0.015, 200)).toBe(true);
    expect(d.update(0.015, 500)).toBe(true);
  });
});

describe('watchVoiceActivity', () => {
  function fake(level) {
    const analyser = {
      fftSize: 32,
      getByteTimeDomainData(b) { for (let i = 0; i < b.length; i += 1) b[i] = i % 2 ? 128 + level * 128 : 128 - level * 128; },
    };
    let tick = null;
    const setIntervalFn = (fn) => { tick = fn; return 1; };
    return { analyser, setIntervalFn, clearIntervalFn: vi.fn(), run: () => tick() };
  }
  it('announces while speaking and audible, never when not audible', () => {
    const f = fake(0.3);
    const onSpeaking = vi.fn();
    let audible = true;
    let t = 0;
    watchVoiceActivity(f.analyser, { isAudible: () => audible, onSpeaking, now: () => (t += 120), setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn });
    f.run();
    expect(onSpeaking).toHaveBeenCalledTimes(1);
    audible = false;
    f.run();
    expect(onSpeaking).toHaveBeenCalledTimes(1);
  });
  it('stop clears the timer', () => {
    const f = fake(0);
    const stop = watchVoiceActivity(f.analyser, { onSpeaking: vi.fn(), setIntervalFn: f.setIntervalFn, clearIntervalFn: f.clearIntervalFn });
    stop();
    expect(f.clearIntervalFn).toHaveBeenCalledWith(1);
  });
});
