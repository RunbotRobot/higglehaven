// #3128: DOM-free coverage for the persisted voice / nearby-chat mute sets.
import { describe, expect, it } from 'vitest';
import { createPersistentMuteSet } from './mutePersistence.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('createPersistentMuteSet', () => {
  it('keeps a mute across a fresh set for the same account (reload)', () => {
    const storage = fakeStorage();
    const first = createPersistentMuteSet('voice', () => 'user-a', storage);
    first.add('builder-1');
    const afterReload = createPersistentMuteSet('voice', () => 'user-a', storage);
    expect(afterReload.has('builder-1')).toBe(true);
    expect(afterReload.size).toBe(1);
  });

  it('delete is persisted, and an empty set leaves no key behind', () => {
    const storage = fakeStorage();
    const set = createPersistentMuteSet('voice', () => 'user-a', storage);
    set.add('builder-1');
    expect(set.delete('builder-1')).toBe(true);
    expect(createPersistentMuteSet('voice', () => 'user-a', storage).has('builder-1')).toBe(false);
    expect(Object.keys(storage.data)).toEqual([]);
  });

  it('keeps voice and nearby-chat mutes apart, and different accounts apart', () => {
    const storage = fakeStorage();
    let account = 'user-a';
    const voice = createPersistentMuteSet('voice', () => account, storage);
    const chat = createPersistentMuteSet('nearby-chat', () => account, storage);
    voice.add('builder-1');
    expect(chat.has('builder-1')).toBe(false);
    account = 'user-b';
    expect(voice.has('builder-1')).toBe(false);
    voice.add('builder-2');
    account = 'user-a';
    expect(voice.values()).toEqual(['builder-1']);
  });

  it('a signed-out viewer gets an in-memory set that is never written', () => {
    const storage = fakeStorage();
    const set = createPersistentMuteSet('voice', () => null, storage);
    set.add('builder-1');
    expect(set.has('builder-1')).toBe(true);
    expect(Object.keys(storage.data)).toEqual([]);
  });

  it('survives unavailable or throwing storage', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    const set = createPersistentMuteSet('voice', () => 'user-a', throwing);
    set.add('builder-1');
    expect(set.has('builder-1')).toBe(true);
    expect(createPersistentMuteSet('voice', () => 'user-a', null).size).toBe(0);
  });

  it('ignores a corrupt stored value', () => {
    const storage = fakeStorage({ 'hh-muted:voice:user-a': '{not json' });
    expect(createPersistentMuteSet('voice', () => 'user-a', storage).size).toBe(0);
    const wrongShape = fakeStorage({ 'hh-muted:voice:user-a': JSON.stringify({ a: 1 }) });
    expect(createPersistentMuteSet('voice', () => 'user-a', wrongShape).size).toBe(0);
  });
});
