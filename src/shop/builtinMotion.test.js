// #3777: the built-in motion of a clip-less custom avatar.
import { describe, expect, it } from 'vitest';
import { createBuiltinMotion, stepBuiltinMotion } from './builtinMotion.js';

function run(state, mag, seconds, scaleM = 1.7, motion = createBuiltinMotion()) {
  const samples = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const p = stepBuiltinMotion(motion, 1 / 60, state, mag, scaleM);
    samples.push({ bobM: p.bobM, leanRad: p.leanRad, swayRad: p.swayRad });
  }
  return { samples, motion };
}
const range = (xs) => Math.max(...xs) - Math.min(...xs);

describe('builtin avatar motion', () => {
  it('breathes when standing: a small, steady bob and sway, nothing like a walk', () => {
    const { samples } = run('idle', 0, 6);
    expect(range(samples.map((s) => s.bobM))).toBeGreaterThan(0.003);
    expect(range(samples.map((s) => s.bobM))).toBeLessThan(0.02);
    expect(Math.max(...samples.map((s) => Math.abs(s.leanRad)))).toBe(0);
  });

  it('walks with a bob of a few centimetres, a forward lean and a side sway', () => {
    const { samples } = run('walk', 1, 3);
    const late = samples.slice(60); // after the blend has settled
    expect(range(late.map((s) => s.bobM))).toBeGreaterThan(0.02);
    expect(Math.max(...late.map((s) => s.bobM))).toBeLessThan(0.06);
    expect(Math.max(...late.map((s) => s.leanRad))).toBeLessThan(0); // forward is negative
    expect(range(late.map((s) => s.swayRad))).toBeGreaterThan(0.05);
    expect(Math.max(...late.map((s) => Math.abs(s.swayRad)))).toBeLessThan(0.1);
  });

  it('bobs harder and cycles faster at a full run than at a slow walk', () => {
    const slow = run('walk', 0.3, 3).samples.slice(60);
    const fast = run('walk', 1, 3).samples.slice(60);
    expect(range(fast.map((s) => s.bobM))).toBeGreaterThan(range(slow.map((s) => s.bobM)));
    const crossings = (xs) => xs.slice(1).filter((x, i) => (xs[i] < 0) !== (x < 0)).length;
    expect(crossings(fast.map((s) => s.swayRad))).toBeGreaterThan(crossings(slow.map((s) => s.swayRad)));
  });

  it('flies differently from both: a slow drift and bank, no lean', () => {
    const { samples } = run('fly', 0, 8);
    const late = samples.slice(60);
    expect(Math.max(...late.map((s) => Math.abs(s.leanRad)))).toBeLessThan(0.01);
    expect(range(late.map((s) => s.swayRad))).toBeGreaterThan(0.03);
    const walk = run('walk', 1, 3).samples.slice(60);
    expect(range(late.map((s) => s.bobM))).not.toBeCloseTo(range(walk.map((s) => s.bobM)), 2);
  });

  it('eases to rest instead of snapping when the walk stops', () => {
    const motion = createBuiltinMotion();
    run('walk', 1, 2, 1.7, motion);
    const first = stepBuiltinMotion(motion, 1 / 60, 'idle', 0, 1.7).leanRad;
    expect(first).toBeLessThan(0); // still leaning a frame after stopping
    expect(Math.abs(first)).toBeGreaterThan(0.01);
    const { samples } = run('idle', 0, 2, 1.7, motion);
    expect(Math.abs(samples[samples.length - 1].leanRad)).toBeLessThan(0.001);
  });

  it('is deterministic from the sequence of steps and never allocates a new pose', () => {
    const a = run('walk', 0.8, 2);
    const b = run('walk', 0.8, 2);
    expect(a.samples).toEqual(b.samples);
    const motion = createBuiltinMotion();
    const p1 = stepBuiltinMotion(motion, 1 / 60, 'walk', 1, 1.7);
    const p2 = stepBuiltinMotion(motion, 1 / 60, 'walk', 1, 1.7);
    expect(p1).toBe(p2);
  });

  it('scales with the avatar and survives odd input', () => {
    const small = run('walk', 1, 3, 0.5).samples.slice(60);
    const tall = run('walk', 1, 3, 2.5).samples.slice(60);
    expect(range(tall.map((s) => s.bobM))).toBeGreaterThan(range(small.map((s) => s.bobM)));
    const motion = createBuiltinMotion();
    const p = stepBuiltinMotion(motion, NaN, 'walk', undefined, -3);
    expect(Number.isFinite(p.bobM) && Number.isFinite(p.leanRad) && Number.isFinite(p.swayRad)).toBe(true);
    const big = stepBuiltinMotion(motion, 5, 'walk', 9, 1.7); // a long hitch is clamped
    expect(Number.isFinite(big.bobM)).toBe(true);
  });
});
