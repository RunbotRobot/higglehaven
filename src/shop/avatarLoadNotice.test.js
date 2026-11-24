import { describe, expect, it, vi } from 'vitest';

const sayAtHead = vi.fn();
// The flower's code touches the page when it loads; only what is said to it matters here.
vi.mock('../ui/headSaying.js', () => ({ sayAtHead }));
const { AVATAR_LOAD_KEY, AVATAR_LOAD_MESSAGE, sayAvatarDidNotLoad } = await import('./avatarLoadNotice.js');

describe('avatarLoadNotice', () => {
  it('says what happened and what to do, in plain words with no internals', () => {
    expect(AVATAR_LOAD_MESSAGE).toContain("didn't load");
    expect(AVATAR_LOAD_MESSAGE).toContain('default body');
    expect(AVATAR_LOAD_MESSAGE).toContain('Reload');
    expect(AVATAR_LOAD_MESSAGE).not.toMatch(/please|#\d|model|error|exception/i);
  });

  it('is said at the head as a word that stays until its sentence has been read', () => {
    sayAvatarDidNotLoad();
    expect(sayAtHead).toHaveBeenCalledWith(AVATAR_LOAD_KEY, expect.objectContaining({ message: AVATAR_LOAD_MESSAGE, readOnce: true }));
  });
});
