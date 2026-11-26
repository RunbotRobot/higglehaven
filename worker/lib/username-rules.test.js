import { describe, expect, it } from 'vitest';
import { normalizeUsername, usernameSkeleton, isReservedSkeleton, USERNAME_CHARACTER_MESSAGE, USERNAME_SPACES_MESSAGE } from './username-rules.js';

const refused = (value) => { try { normalizeUsername(value); return null; } catch (e) { return e.message; } };

describe('normalizeUsername', () => {
  it('trims and collapses runs of spaces to one', () => {
    expect(normalizeUsername('  Ada   Builder ', { allowSpaces: true })).toBe('Ada Builder');
  });
  it('turns odd spaces into a plain one', () => {
    expect(normalizeUsername('Ada Builder', { allowSpaces: true })).toBe('Ada Builder');
    expect(normalizeUsername('Ada　 Builder', { allowSpaces: true })).toBe('Ada Builder');
  });
  it('normalises to NFC', () => {
    expect(normalizeUsername('José')).toBe('José');
  });
  it('refuses zero-width, direction-override and control characters, with the reason', () => {
    for (const bad of ['Ad​a', 'Ada‮X', 'Ad⁠a', 'Ada\u0000', 'Ada\nBuilder', 'Ada\tBuilder', 'A b', 'Ab']) {
      expect(refused(bad)).toBe(USERNAME_CHARACTER_MESSAGE);
    }
  });
  it('refuses a lone surrogate', () => {
    expect(refused('Ada\ud800')).toBe(USERNAME_CHARACTER_MESSAGE);
    expect(refused('\udc00Ada')).toBe(USERNAME_CHARACTER_MESSAGE);
  });
  it('allows an emoji (a surrogate pair)', () => {
    expect(normalizeUsername('Ada 🌿', { allowSpaces: true })).toBe('Ada 🌿');
  });
  it('requires a name and caps it at 40 characters, counting characters not code units', () => {
    expect(refused('   ')).toBe('Enter a name.');
    expect(refused(undefined)).toBe('Enter a name.');
    expect(normalizeUsername('a'.repeat(40))).toBe('a'.repeat(40));
    expect(refused('a'.repeat(41))).toBe('A name can be at most 40 characters.');
    expect(normalizeUsername('🌿'.repeat(40))).toBe('🌿'.repeat(40));
  });
});

describe('a username has no spaces (#4407)', () => {
  it('refuses a name with a space, however it was typed, and says what to do', () => {
    for (const bad of ['Ada Builder', '  Ada   Builder ', 'Ada Builder', 'Ada 🌿']) {
      expect(refused(bad), bad).toBe(USERNAME_SPACES_MESSAGE);
    }
    expect(USERNAME_SPACES_MESSAGE).toBe("A name can't have spaces. Try BenjaminChae or Benjamin_Chae.");
  });
  it('allows everything else that can be shown', () => {
    for (const ok of ['Ada_Builder', 'ada-builder', 'Ada.B', 'José', '🌿Ada', 'Ada123']) expect(normalizeUsername(ok)).toBe(ok);
  });
});

describe('usernameSkeleton', () => {
  it('folds case, accents and spacing', () => {
    expect(usernameSkeleton('  José   Builder ')).toBe('jose builder');
  });
  it('maps Cyrillic and Greek look-alikes to Latin', () => {
    expect(usernameSkeleton('Junіper')).toBe('juniper');
    expect(usernameSkeleton('Hіgglehаven')).toBe('higgleh' + 'aven');
    expect(usernameSkeleton('Ρаul')).toBe('paul');
  });
  it('keeps names that really differ apart', () => {
    expect(usernameSkeleton('Ada')).not.toBe(usernameSkeleton('Adam'));
    expect(usernameSkeleton('Ada B')).not.toBe(usernameSkeleton('AdaB'));
  });
});

describe('isReservedSkeleton', () => {
  it('reserves the misleading names and every assistant, in folded form and ignoring spaces', () => {
    for (const name of ['Admin', 'ADMINISTRATOR', 'Support', 'Staff', 'Moderator', 'Higglehaven', 'Hig gle haven', 'Junіper', 'FIG']) {
      expect(isReservedSkeleton(usernameSkeleton(name))).toBe(true);
    }
  });
  it('does not reserve ordinary names or ones that merely contain one', () => {
    // #4383: 'higglehaven3' used to be here; a name that starts with higglehaven is now reserved (see
    // worker/username-rules.test.js), except on a local server.
    for (const name of ['Ada', 'Admiral', 'Figure', 'thehigglehaven3', 'Support Cat']) {
      expect(isReservedSkeleton(usernameSkeleton(name))).toBe(false);
    }
  });
});
