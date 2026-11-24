import { describe, it, expect, vi } from 'vitest';
import { createAvatarArrival } from './avatarArrival.js';

function make(extra = {}) {
  const store = new Map();
  const fogs = [];
  const mk = (kind) => vi.fn(() => {
    const fog = { kind, released: false, cancelled: 0, steps: 0, cancel() { this.cancelled += 1; }, step() { this.steps += 1; return this.finished === true; } };
    fogs.push(fog);
    return fog;
  });
  const beginSwap = mk('swap');
  const beginHold = mk('hold');
  const arrival = createAvatarArrival({
    getScene: () => ({}), getPosition: () => ({}), getUserId: () => 'u1', reducedMotion: () => false,
    beginSwap, beginHold, makeFog: () => ({}), now: () => 5,
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }),
    ...extra,
  });
  return { arrival, beginSwap, beginHold, fogs, store };
}

describe('createAvatarArrival', () => {
  it('remembers the worn kind per account', () => {
    const { arrival, store } = make();
    expect(arrival.deps.readWornHint()).toBeNull();
    arrival.deps.writeWornHint('custom');
    expect(store.get('hh-worn-avatar:u1')).toBe('custom');
    expect(arrival.deps.readWornHint()).toBe('custom');
  });
  it('writes no hint when nobody is signed in', () => {
    const { arrival, store } = make({ getUserId: () => null });
    arrival.deps.writeWornHint('custom');
    expect(store.size).toBe(0);
  });
  it('keeps one fog: a new one cancels the last, and step drops a finished one', () => {
    const { arrival, fogs } = make();
    arrival.deps.beginAvatarFogHold();
    arrival.deps.beginAvatarSwap(() => {});
    expect(fogs[0].cancelled).toBe(1);
    arrival.step(1);
    expect(fogs[1].steps).toBe(1);
    fogs[1].finished = true;
    arrival.step(2);
    arrival.step(3);
    expect(fogs[1].steps).toBe(2); // dropped after it finished
  });
  it('cancelAvatarSwap and cancel stop the active fog', () => {
    const { arrival, fogs } = make();
    arrival.deps.beginAvatarFogHold();
    arrival.deps.cancelAvatarSwap();
    expect(fogs[0].cancelled).toBe(1);
    arrival.deps.beginAvatarFogHold();
    arrival.cancel();
    expect(fogs[1].cancelled).toBe(1);
  });
});
