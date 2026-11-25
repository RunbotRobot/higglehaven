import { describe, it, expect } from 'vitest';
import { readWornHint, writeWornHint, hintKindForEquipped, wornHintKey } from './wornHint.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

describe('worn avatar hint', () => {
  it('is read back per account after an equip writes it', () => {
    const s = memory();
    writeWornHint(s, 'u1', hintKindForEquipped({ modelUrl: '/m.glb' }));
    expect(readWornHint(s, 'u1')).toBe('custom');
    expect(readWornHint(s, 'u2')).toBe(null);
  });
  it('says default when the equipped answer has no model', () => {
    expect(hintKindForEquipped({ modelUrl: null })).toBe('default');
    expect(hintKindForEquipped(null)).toBe('default');
  });
  it('writes nothing without an account', () => {
    const s = memory();
    writeWornHint(s, null, 'custom');
    expect(s.getItem(wornHintKey(null))).toBe(null);
  });
  it('survives storage that throws', () => {
    const s = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    expect(readWornHint(s, 'u1')).toBe(null);
    expect(() => writeWornHint(s, 'u1', 'custom')).not.toThrow();
  });
});
