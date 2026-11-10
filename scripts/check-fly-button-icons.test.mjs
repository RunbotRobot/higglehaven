import { describe, expect, it } from 'vitest';
import { BUTTON_PX, measureIcon, problemsWith } from './check-fly-button-icons.mjs';

// An RGBA image whose pixels are opaque where `inside(x, y)` is true.
function image(size, inside) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inside(x + 0.5, y + 0.5)) data[(y * size + x) * 4 + 3] = 255;
  return { data, width: size, height: size };
}
const disc = (size, radiusShare) => image(size, (x, y) => Math.hypot(x - size / 2, y - size / 2) <= (size / 2) * radiusShare);

describe('measureIcon / problemsWith (#3369)', () => {
  it('accepts a bird that fills most of the circle with a margin', () => {
    expect(problemsWith('ok', measureIcon(disc(100, 0.85)))).toEqual([]);
  });

  it('measures the farthest visible pixel in button pixels', () => {
    const { farthest } = measureIcon(disc(200, 0.9));
    expect(farthest).toBeGreaterThan(BUTTON_PX / 2 * 0.88);
    expect(farthest).toBeLessThan(BUTTON_PX / 2 * 0.92);
  });

  it('rejects a bird that reaches the circle edge (the clipped-bird case)', () => {
    const problems = problemsWith('clipped', measureIcon(disc(100, 1.0)));
    expect(problems.join(' ')).toMatch(/past the/);
  });

  it('rejects an icon that still carries an opaque card or ring', () => {
    const problems = problemsWith('card', measureIcon(image(100, () => true)));
    expect(problems.join(' ')).toMatch(/opaque corners/);
  });

  it('rejects a bird shrunk to a speck', () => {
    expect(problemsWith('tiny', measureIcon(disc(100, 0.3))).join(' ')).toMatch(/speck/);
  });

  it('rejects a non-square image', () => {
    const data = new Uint8Array(100 * 50 * 4);
    expect(problemsWith('wide', measureIcon({ data, width: 100, height: 50 })).join(' ')).toMatch(/not square/);
  });
});
