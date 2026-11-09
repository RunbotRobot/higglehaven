import { describe, expect, it } from 'vitest';
import { describeAvatarClips, describeNoAnimationsForAvatar, AVATAR_CLIP_NAMES } from './avatarClipNames.js';

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
    const text = describeAvatarClips(['Walking', 'Armature|Idle']);
    expect(text).toContain('2 animation clips (Walking, Armature|Idle)');
    expect(text).toContain('none named idle, walk or fly');
    expect(text).toContain('Rename them in your 3D tool');
  });

  it('matches case-sensitively, exactly like THREE.AnimationClip.findByName', () => {
    expect(describeAvatarClips(['Walk', 'IDLE'])).toContain('none named idle, walk or fly');
  });

  it('uses the singular for one clip', () => {
    expect(describeAvatarClips(['mixamo.com'])).toContain('1 animation clip (mixamo.com)');
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

describe('describeNoAnimationsForAvatar (#2744)', () => {
  it('says so plainly when a clip-less model is listed as an avatar', () => {
    const text = describeNoAnimationsForAvatar(0, true);
    expect(text).toContain('no animations');
    expect(text).toContain('slide around without walking');
    expect(text).toContain('applies an animation');
  });

  it('stays quiet for an ordinary product that is not listed as an avatar', () => {
    expect(describeNoAnimationsForAvatar(0, false)).toBeNull();
  });

  it('stays quiet while the file\'s clips are not known yet', () => {
    expect(describeNoAnimationsForAvatar(null, true)).toBeNull();
    expect(describeNoAnimationsForAvatar(undefined, true)).toBeNull();
  });

  it('stays quiet when the model has clips (describeAvatarClips speaks for those)', () => {
    expect(describeNoAnimationsForAvatar(1, true)).toBeNull();
    expect(describeNoAnimationsForAvatar(5, true)).toBeNull();
  });

  it('never leaks internals into the text', () => {
    expect(describeNoAnimationsForAvatar(0, true)).not.toMatch(/#\d|SPEC|API\.md|findByName/);
  });
});
