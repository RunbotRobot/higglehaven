// #4441 (owner, 2026-11-26): no "afk" note is hung on an avatar, anyone's. An idle person is shown by the
// avatar's own idle animation; the away state still travels in presence (#4390) but is never drawn as a label.
import { describe, expect, it } from 'vitest';
import avatarSource from './avatar.js?raw';
import presenceSource from './presenceAndContent.js?raw';
import flightSource from './flightMovement.js?raw';

describe('no afk label on an avatar', () => {
  for (const [file, source] of [['avatar.js', avatarSource], ['presenceAndContent.js', presenceSource], ['flightMovement.js', flightSource]]) {
    it(`${file} draws no afk sprite`, () => {
      expect(source).not.toMatch(/makeAfkBadgeSprite|afkSprite|afkMark/);
      expect(source).not.toMatch(/fillText\('afk'/);
    });
  }
});
