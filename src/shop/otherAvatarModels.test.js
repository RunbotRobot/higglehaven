import { describe, expect, it } from 'vitest';
import {
  MAX_DISTINCT_CUSTOM_AVATAR_MODELS,
  CUSTOM_AVATAR_RETRY_AFTER_MS,
  normalizeEquippedAvatar,
  chooseAllowedTemplateIds,
  desiredAvatarFor,
} from './otherAvatarModels.js';

const eq = (id) => ({ templateId: id, modelUrl: `/uploads/${id}.glb` });

describe('normalizeEquippedAvatar (#2045)', () => {
  it('passes a well-formed server value through', () => {
    expect(normalizeEquippedAvatar({ templateId: 't1', modelUrl: '/m.glb', extra: 1 })).toEqual({ templateId: 't1', modelUrl: '/m.glb' });
  });
  it('treats a missing or malformed value as the default body', () => {
    for (const bad of [undefined, null, 5, 'x', {}, { templateId: 't1' }, { modelUrl: '/m.glb' }, { templateId: '', modelUrl: '/m.glb' }, { templateId: 1, modelUrl: '/m.glb' }]) {
      expect(normalizeEquippedAvatar(bad)).toBeNull();
    }
  });
});

describe('chooseAllowedTemplateIds (#2045)', () => {
  const none = new Map();

  it('allows every distinct model up to the cap and no more', () => {
    const wanted = new Map();
    for (let i = 0; i < 10; i++) wanted.set(`b${i}`, eq(`t${i}`));
    const allowed = chooseAllowedTemplateIds(wanted, new Set(), none, 0);
    expect(allowed.size).toBe(MAX_DISTINCT_CUSTOM_AVATAR_MODELS);
    expect([...allowed]).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
  });

  it('counts distinct models, not avatars: many builders sharing one model cost one slot', () => {
    const wanted = new Map();
    for (let i = 0; i < 20; i++) wanted.set(`b${i}`, eq('same'));
    wanted.set('other', eq('different'));
    expect(chooseAllowedTemplateIds(wanted, new Set(), none, 0).size).toBe(2);
  });

  it('keeps already-drawn models first, so a new arrival never bumps one that is on screen', () => {
    const wanted = new Map();
    for (let i = 0; i < 6; i++) wanted.set(`old${i}`, eq(`old${i}`));
    // A new arrival listed FIRST by the server must still not take an old slot.
    const reordered = new Map([['new', eq('newcomer')], ...wanted]);
    const shown = new Set(['old0', 'old1', 'old2', 'old3', 'old4', 'old5']);
    const allowed = chooseAllowedTemplateIds(reordered, shown, none, 0);
    expect(allowed.has('newcomer')).toBe(false);
    expect(allowed.size).toBe(6);
  });

  it('frees a slot once its builder is gone or stops wanting it', () => {
    const wanted = new Map([['a', eq('t1')], ['n', eq('newcomer')]]);
    const shown = new Set(['t1', 'gone']);
    const allowed = chooseAllowedTemplateIds(wanted, shown, none, 0, 2);
    expect([...allowed].sort()).toEqual(['newcomer', 't1']);
  });

  it('skips a model that recently failed to load, and retries it after the cool-down', () => {
    const wanted = new Map([['a', eq('broken')], ['b', eq('fine')]]);
    const failedAt = new Map([['broken', 1000]]);
    expect([...chooseAllowedTemplateIds(wanted, new Set(), failedAt, 1000 + CUSTOM_AVATAR_RETRY_AFTER_MS - 1)]).toEqual(['fine']);
    expect(chooseAllowedTemplateIds(wanted, new Set(), failedAt, 1000 + CUSTOM_AVATAR_RETRY_AFTER_MS).has('broken')).toBe(true);
  });

  it('ignores builders with no equipped custom avatar', () => {
    const wanted = new Map([['a', null], ['b', eq('t1')]]);
    expect([...chooseAllowedTemplateIds(wanted, new Set(), none, 0)]).toEqual(['t1']);
  });
});

describe('desiredAvatarFor (#2045)', () => {
  it('returns the model only when it is allowed, otherwise the default body (null)', () => {
    const allowed = new Set(['t1']);
    expect(desiredAvatarFor(eq('t1'), allowed)).toEqual(eq('t1'));
    expect(desiredAvatarFor(eq('t2'), allowed)).toBeNull();
    expect(desiredAvatarFor(null, allowed)).toBeNull();
  });
});
