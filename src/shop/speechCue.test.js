import { describe, it, expect } from 'vitest';
import {
  speechCueLevels, announceNearbySpeech, setNearbySpeechHandler,
  SPEECH_CUE_IN_S, SPEECH_CUE_HOLD_S, SPEECH_CUE_OUT_S, SPEECH_CUE_RISE_M,
} from './speechCue.js';

describe('speechCueLevels (#3556)', () => {
  it('starts invisible, thins in, holds, then thins away and is done', () => {
    expect(speechCueLevels(0).opacity).toBe(0);
    const mid = speechCueLevels(SPEECH_CUE_IN_S / 2);
    expect(mid.opacity).toBeGreaterThan(0);
    expect(mid.opacity).toBeLessThan(0.9);
    const held = speechCueLevels(SPEECH_CUE_IN_S + SPEECH_CUE_HOLD_S / 2);
    expect(held.opacity).toBeCloseTo(0.9);
    expect(held.rise).toBeCloseTo(SPEECH_CUE_RISE_M);
    const out = speechCueLevels(SPEECH_CUE_IN_S + SPEECH_CUE_HOLD_S + SPEECH_CUE_OUT_S / 2);
    expect(out.opacity).toBeGreaterThan(0);
    expect(out.opacity).toBeLessThan(0.9);
    expect(out.done).toBe(false);
    expect(speechCueLevels(SPEECH_CUE_IN_S + SPEECH_CUE_HOLD_S + SPEECH_CUE_OUT_S).done).toBe(true);
  });

  it('never pops: opacity only ever changes smoothly and never exceeds 0.9', () => {
    let prev = 0;
    for (let t = 0; t <= 5; t += 0.05) {
      const { opacity } = speechCueLevels(t);
      expect(opacity).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(Math.abs(opacity - prev)).toBeLessThan(0.35);
      prev = opacity;
    }
  });

  it('reduced motion shows the mark plainly for the hold, with no drift', () => {
    expect(speechCueLevels(0.01, { reducedMotion: true }).opacity).toBeGreaterThan(0.5);
    expect(speechCueLevels(1, { reducedMotion: true }).rise).toBe(0);
    expect(speechCueLevels(SPEECH_CUE_IN_S + SPEECH_CUE_HOLD_S, { reducedMotion: true }).done).toBe(true);
  });

  it('tolerates a bad age', () => {
    expect(speechCueLevels(Number.NaN).opacity).toBe(0);
    expect(speechCueLevels(-3).opacity).toBe(0);
  });
});

describe('announceNearbySpeech (#3556)', () => {
  it('passes only the builder id to the handler, and does nothing with none set', () => {
    setNearbySpeechHandler(null);
    expect(() => announceNearbySpeech('b1')).not.toThrow();
    const seen = [];
    setNearbySpeechHandler((...args) => seen.push(args));
    announceNearbySpeech('b1');
    expect(seen).toEqual([['b1']]);
    setNearbySpeechHandler(null);
  });
});
