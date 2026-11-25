import { describe, it, expect } from 'vitest';
import { shouldNoteRemoved } from './removedNote.js';

describe('shouldNoteRemoved', () => {
  it('notes the first removal, and any removal beyond what was looked at', () => {
    expect(shouldNoteRemoved(1, 0)).toBe(true);
    expect(shouldNoteRemoved(3, 2)).toBe(true);
  });
  it('stays quiet when nothing is removed or the list has been seen', () => {
    expect(shouldNoteRemoved(0, 0)).toBe(false);
    expect(shouldNoteRemoved(2, 2)).toBe(false);
    expect(shouldNoteRemoved(1, 5)).toBe(false);
  });
  it('treats a bad seen count as none seen', () => {
    expect(shouldNoteRemoved(1, NaN)).toBe(true);
  });
});
