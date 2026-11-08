import { describe, expect, it } from 'vitest';
import { describeAvatarClips, matchAvatarClips, pickAvatarClips, AVATAR_CLIP_NAMES } from './avatarClipNames.js';

describe('describeAvatarClips (#2744)', () => {
  it('says nothing for a model with no clips (an ordinary product)', () => {
    expect(describeAvatarClips([])).toBeNull();
    expect(describeAvatarClips(undefined)).toBeNull();
  });

  it('confirms the clips that matched, in the convention\'s own order', () => {
    expect(describeAvatarClips(['walk', 'idle', 'dance'])).toBe(
      'Avatar animations detected: idle, walk — these play automatically if this is equipped as an avatar.',
    );
    expect(AVATAR_CLIP_NAMES).toEqual(['idle', 'walk', 'fly']);
  });

  it('names the clips it found when none match, so the seller can see why', () => {
    const text = describeAvatarClips(['Dance', 'Armature|Wave']);
    expect(text).toContain('2 animation clips (Dance, Armature|Wave)');
    expect(text).toContain('none that look like idle, walk or fly');
    expect(text).toContain('Rename them in your 3D tool');
  });

  it('recognises the usual download-site names and says which clip each role came from (#3287)', () => {
    expect(describeAvatarClips(['Walk', 'IDLE'])).toBe(
      'Avatar animations detected: idle (from IDLE), walk (from Walk) — these play automatically if this is equipped as an avatar.',
    );
    expect(describeAvatarClips(['Armature|Walking'])).toContain('walk (from Armature|Walking)');
  });

  it('uses the singular for one clip', () => {
    expect(describeAvatarClips(['Dance'])).toContain('1 animation clip (Dance)');
  });

  it('caps how many names it lists and how long each is', () => {
    const names = Array.from({ length: 9 }, (_, i) => `clip${i}`);
    const text = describeAvatarClips(names);
    expect(text).toContain('9 animation clips (clip0, clip1, clip2, clip3, clip4 and 4 more)');
    expect(describeAvatarClips(['x'.repeat(80)])).toContain(`${'x'.repeat(31)}…`);
  });

  it('labels an unnamed clip rather than printing a blank', () => {
    expect(describeAvatarClips([''])).toContain('(unnamed)');
  });

  it('never leaks internals into the user-facing text', () => {
    const text = describeAvatarClips(['a']);
    expect(text).not.toMatch(/#\d|SPEC|API\.md|findByName/);
  });
});

describe('matchAvatarClips (#3287)', () => {
  it('matches the plain role names, case-insensitively', () => {
    expect(matchAvatarClips(['idle', 'walk', 'fly'])).toEqual({ idle: 0, walk: 1, fly: 2 });
    expect(matchAvatarClips(['IDLE', 'Walk', 'FLY'])).toEqual({ idle: 0, walk: 1, fly: 2 });
  });

  it('accepts the listed aliases', () => {
    expect(matchAvatarClips(['Standing', 'Walking', 'Flying'])).toEqual({ idle: 0, walk: 1, fly: 2 });
    expect(matchAvatarClips(['Breathing Idle', 'Walk Cycle'])).toEqual({ idle: 0, walk: 1, fly: null });
  });

  it('falls back to any name containing the role word', () => {
    expect(matchAvatarClips(['Rig_Idle_Loop', 'Fast Walk 02', 'HoverFly'])).toEqual({ idle: 0, walk: 1, fly: 2 });
  });

  it('prefers an exact name over an alias over a substring, wherever they sit in the file', () => {
    expect(matchAvatarClips(['Idle_Long', 'Standing', 'Idle'])).toEqual({ idle: 2, walk: null, fly: null });
    expect(matchAvatarClips(['Idle_Long', 'Standing'])).toEqual({ idle: 1, walk: null, fly: null });
    expect(matchAvatarClips(['Walk_Fast', 'Walk_Slow'])).toEqual({ idle: null, walk: 0, fly: null });
  });

  it('matches an armature-prefixed name on the part after the last bar', () => {
    expect(matchAvatarClips(['Armature|Walk', 'Rig|Armature|Idle'])).toEqual({ idle: 1, walk: 0, fly: null });
    // The prefix itself never counts: an armature called "Idle_Rig" is not an idle clip.
    expect(matchAvatarClips(['Idle_Rig|Dance'])).toEqual({ idle: null, walk: null, fly: null });
  });

  it('treats a lone mixamo.com clip as idle, but only when it is the only clip', () => {
    expect(matchAvatarClips(['mixamo.com'])).toEqual({ idle: 0, walk: null, fly: null });
    expect(matchAvatarClips(['Armature|mixamo.com'])).toEqual({ idle: 0, walk: null, fly: null });
    expect(matchAvatarClips(['mixamo.com', 'mixamo.com'])).toEqual({ idle: null, walk: null, fly: null });
    expect(matchAvatarClips(['mixamo.com', 'Walk'])).toEqual({ idle: null, walk: 1, fly: null });
  });

  it('gives a clip matching two roles to only one of them', () => {
    const only = matchAvatarClips(['walk_idle']);
    expect(Object.values(only).filter((i) => i !== null)).toEqual([0]);
    // With a better home for each role, neither steals the other's clip.
    expect(matchAvatarClips(['walk_idle', 'Walk', 'Idle'])).toEqual({ idle: 2, walk: 1, fly: null });
  });

  it('only fills the roles the caller can use', () => {
    expect(matchAvatarClips(['Idle', 'Walk', 'Fly'], ['idle', 'walk'])).toEqual({ idle: 0, walk: 1, fly: null });
    expect(matchAvatarClips(['mixamo.com'], ['walk'])).toEqual({ idle: null, walk: null, fly: null });
  });

  it('copes with nothing to match', () => {
    expect(matchAvatarClips([])).toEqual({ idle: null, walk: null, fly: null });
    expect(matchAvatarClips(undefined)).toEqual({ idle: null, walk: null, fly: null });
    expect(matchAvatarClips([undefined, null, ''])).toEqual({ idle: null, walk: null, fly: null });
  });
});

describe('pickAvatarClips (#3287)', () => {
  it('returns the clip objects themselves, null for a role with none', () => {
    const idle = { name: 'Standing' };
    const walk = { name: 'Armature|Walking' };
    const picked = pickAvatarClips([walk, idle]);
    expect(picked.idle).toBe(idle);
    expect(picked.walk).toBe(walk);
    expect(picked.fly).toBeNull();
  });

  it('copes with no clips', () => {
    expect(pickAvatarClips([])).toEqual({ idle: null, walk: null, fly: null });
    expect(pickAvatarClips(undefined)).toEqual({ idle: null, walk: null, fly: null });
  });
});
