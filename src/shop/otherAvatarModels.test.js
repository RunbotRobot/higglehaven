import { describe, expect, it } from 'vitest';
import {
  MAX_DISTINCT_CUSTOM_AVATAR_MODELS,
  CUSTOM_AVATAR_RETRY_AFTER_MS,
  OTHER_AVATAR_WALK_SPEED_MPS,
  OTHER_AVATAR_STALE_LERP_T,
  normalizeEquippedAvatar,
  normalizeEquippedAnimation,
  animationForAvatar,
  locomotionStateFor,
  chooseAllowedTemplateIds,
  desiredAvatarFor,
} from './otherAvatarModels.js';

const eq = (id) => ({ templateId: id, modelUrl: `/uploads/${id}.glb` });

describe('normalizeEquippedAvatar (#2045)', () => {
  it('passes a well-formed server value through', () => {
    expect(normalizeEquippedAvatar({ templateId: 't1', modelUrl: '/m.glb', extra: 1 })).toEqual({ templateId: 't1', modelUrl: '/m.glb', skeletonSignature: null, clipRoles: null });
  });
  it('keeps the skeleton signature when the server sends one (#3230)', () => {
    expect(normalizeEquippedAvatar({ templateId: 't1', modelUrl: '/m.glb', skeletonSignature: 'sig' })).toEqual({ templateId: 't1', modelUrl: '/m.glb', skeletonSignature: 'sig', clipRoles: null });
    expect(normalizeEquippedAvatar({ templateId: 't1', modelUrl: '/m.glb', skeletonSignature: 7 }).skeletonSignature).toBeNull();
  });
  it('keeps the seller\'s chosen clip roles, and reads anything malformed as nobody having chosen (#3314)', () => {
    const base = { templateId: 't1', modelUrl: '/m.glb' };
    expect(normalizeEquippedAvatar({ ...base, clipRoles: { idle: null, walk: 'mixamo.com', fly: null } }).clipRoles)
      .toEqual({ idle: null, walk: 'mixamo.com', fly: null });
    for (const bad of [undefined, null, 'walk', 7, ['walk']]) {
      expect(normalizeEquippedAvatar({ ...base, clipRoles: bad }).clipRoles).toBeNull();
    }
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

describe('normalizeEquippedAnimation (#3230)', () => {
  it('passes a well-formed value through, signature included', () => {
    expect(normalizeEquippedAnimation({ templateId: 'a1', modelUrl: '/a.glb', skeletonSignature: 'sig', extra: 1 })).toEqual({ templateId: 'a1', modelUrl: '/a.glb', skeletonSignature: 'sig' });
  });
  it('treats a missing field (an older server) or anything malformed as nothing applied', () => {
    for (const bad of [undefined, null, 5, 'x', {}, { templateId: 'a1' }, { modelUrl: '/a.glb' }, { templateId: '', modelUrl: '/a.glb' }]) {
      expect(normalizeEquippedAnimation(bad)).toBeNull();
    }
  });
});

describe('animationForAvatar (#3230)', () => {
  const avatar = (sig) => ({ templateId: 'av', modelUrl: '/av.glb', skeletonSignature: sig });
  const anim = (sig) => ({ templateId: 'an', modelUrl: '/an.glb', skeletonSignature: sig });

  it('returns the animation only when both signatures are present and equal', () => {
    expect(animationForAvatar(avatar('s1'), anim('s1'))).toEqual(anim('s1'));
  });
  it('falls back to the avatar\'s own clips (null) when incompatible', () => {
    expect(animationForAvatar(avatar('s1'), anim('s2'))).toBeNull();
  });
  it('never matches a missing signature, even null === null', () => {
    expect(animationForAvatar(avatar(null), anim(null))).toBeNull();
    expect(animationForAvatar(avatar('s1'), anim(null))).toBeNull();
    expect(animationForAvatar(avatar(null), anim('s1'))).toBeNull();
  });
  it('is null with no avatar or no animation', () => {
    expect(animationForAvatar(null, anim('s1'))).toBeNull();
    expect(animationForAvatar(avatar('s1'), null)).toBeNull();
  });
});

describe('locomotionStateFor (#3230)', () => {
  it('walks when the avatar travelled faster than the threshold between snapshots', () => {
    // 3 m in 1 s
    expect(locomotionStateFor(0, 0, 3, 0, 1000, 0.5)).toBe('walk');
    // diagonal, still counts
    expect(locomotionStateFor(0, 0, 2, 2, 1000, 0.5)).toBe('walk');
  });
  it('idles when it barely moved (position jitter)', () => {
    expect(locomotionStateFor(5, 5, 5.05, 5, 1000, 0.5)).toBe('idle');
    expect(locomotionStateFor(0, 0, 0, 0, 1000, 0.5)).toBe('idle');
  });
  it('uses the real gap between snapshots, so a slow poll does not read as faster', () => {
    expect(locomotionStateFor(0, 0, 0.5, 0, 1000, 0.5)).toBe('walk'); // 0.5 m/s
    expect(locomotionStateFor(0, 0, 0.5, 0, 2000, 0.5)).toBe('idle'); // same 0.5 m over 2 s = 0.25 m/s
  });
  it('keeps walking while a snapshot is merely a little late (response latency)', () => {
    expect(locomotionStateFor(0, 0, 3, 0, 1000, 1)).toBe('walk');
    expect(locomotionStateFor(0, 0, 3, 0, 1000, 1.5)).toBe('walk');
  });
  it('idles once snapshots have stopped arriving for a whole extra interval (the avatar is gone quiet)', () => {
    expect(locomotionStateFor(0, 0, 3, 0, 1000, OTHER_AVATAR_STALE_LERP_T)).toBe('idle');
    expect(locomotionStateFor(0, 0, 3, 0, 1000, 5)).toBe('idle');
  });
  it('survives a zero duration', () => {
    expect(Number.isFinite(OTHER_AVATAR_WALK_SPEED_MPS)).toBe(true);
    expect(['idle', 'walk']).toContain(locomotionStateFor(0, 0, 1, 0, 0, 0));
  });
});
