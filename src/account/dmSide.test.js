import { describe, it, expect } from 'vitest';
import { isSentByMe } from './dmSide.js';

describe('isSentByMe', () => {
  it('is mine when addressed to the other person', () => {
    expect(isSentByMe({ senderBuilderId: 'me', recipientBuilderId: 'them' }, 'them')).toBe(true);
  });
  it('is theirs when addressed to me, even from an old builder id of theirs', () => {
    expect(isSentByMe({ senderBuilderId: 'their-old-id', recipientBuilderId: 'me' }, 'them')).toBe(false);
  });
  it('is never mine without a thread partner', () => {
    expect(isSentByMe({ recipientBuilderId: 'them' }, null)).toBe(false);
  });
});
