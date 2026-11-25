import { describe, it, expect } from 'vitest';
import { duplicateName, PRODUCT_NAME_MAX_CHARS } from './duplicateName.js';

describe('duplicateName (#4344)', () => {
  it('adds (copy) to a short name', () => {
    expect(duplicateName('Brick')).toBe('Brick (copy)');
  });
  it('keeps a name that still fits whole', () => {
    const name = 'a'.repeat(PRODUCT_NAME_MAX_CHARS - ' (copy)'.length);
    expect(duplicateName(name)).toBe(`${name} (copy)`);
    expect(duplicateName(name).length).toBe(PRODUCT_NAME_MAX_CHARS);
  });
  it('trims a name of 94 to 100 characters so the copy is at most 100', () => {
    for (let length = 94; length <= 100; length += 1) {
      const copy = duplicateName('b'.repeat(length));
      expect(copy.length).toBeLessThanOrEqual(PRODUCT_NAME_MAX_CHARS);
      expect(copy.endsWith(' (copy)')).toBe(true);
    }
  });
  it('does not leave a space before the suffix when it trims at one', () => {
    const name = `${'c'.repeat(92)} ${'d'.repeat(7)}`; // the cut falls on the space
    expect(duplicateName(name)).toBe(`${'c'.repeat(92)} (copy)`);
  });
});
