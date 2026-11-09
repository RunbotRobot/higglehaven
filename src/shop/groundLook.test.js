import { describe, expect, it } from 'vitest';
import { shopGroundUsesBiomeTexture } from './groundLook.js';

// #3262: Shop mode shows the same biome ground on a claimed lándlet that Build
// mode does; only land nobody has built on keeps a flat status colour.
describe('shopGroundUsesBiomeTexture (#3262)', () => {
  it('textures unclaimed and claimed land', () => {
    expect(shopGroundUsesBiomeTexture('greenbelt')).toBe(true);
    expect(shopGroundUsesBiomeTexture('claimed')).toBe(true);
  });

  it('keeps a status fill for plots being generated and for water', () => {
    expect(shopGroundUsesBiomeTexture('generating')).toBe(false);
    expect(shopGroundUsesBiomeTexture('water')).toBe(false);
  });

  it('falls back to a flat fill for an unknown status instead of guessing a texture', () => {
    expect(shopGroundUsesBiomeTexture('something-new')).toBe(false);
    expect(shopGroundUsesBiomeTexture(undefined)).toBe(false);
  });
});
