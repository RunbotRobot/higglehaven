import { describe, it, expect } from 'vitest';
import { worldCanvasName, WORLD_CANVAS_NAMES } from './canvasName.js';

describe('worldCanvasName (#4591)', () => {
  it('names the world for the mode it is in, and only Build speaks of placing', () => {
    expect(worldCanvasName('build')).toMatch(/place it/);
    expect(worldCanvasName('shop')).not.toMatch(/Build|place it/);
    expect(worldCanvasName('sell')).not.toMatch(/Build|place it/);
    expect(worldCanvasName('shop')).toMatch(/press N for the nearest product/);
  });
  it('falls back to the Shop name for an unknown mode', () => {
    expect(worldCanvasName('nowhere')).toBe(WORLD_CANVAS_NAMES.shop);
  });
});
