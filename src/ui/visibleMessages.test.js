import { beforeEach, describe, expect, it } from 'vitest';
import { clearRecentVisibleMessages, getRecentVisibleMessages, recordVisibleMessage } from './visibleMessages.js';

beforeEach(() => clearRecentVisibleMessages());

describe('visible message log (#3303)', () => {
  it('records what the person was shown, oldest first, with a timestamp', () => {
    recordVisibleMessage("Couldn't bundle these items.");
    recordVisibleMessage('Still saving your items.');
    const messages = getRecentVisibleMessages();
    expect(messages.map((m) => m.text)).toEqual(["Couldn't bundle these items.", 'Still saving your items.']);
    expect(Number.isNaN(Date.parse(messages[0].shownAt))).toBe(false);
  });

  it('ignores empty text and a repeat of the message just shown', () => {
    recordVisibleMessage('');
    recordVisibleMessage('   ');
    recordVisibleMessage(undefined);
    recordVisibleMessage('same');
    recordVisibleMessage('same');
    expect(getRecentVisibleMessages()).toHaveLength(1);
  });

  it('keeps only the last five and bounds each message', () => {
    for (let i = 0; i < 8; i += 1) recordVisibleMessage(`m${i}`);
    expect(getRecentVisibleMessages().map((m) => m.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    recordVisibleMessage('y'.repeat(900));
    expect(getRecentVisibleMessages().at(-1).text).toHaveLength(500);
  });

  it('returns copies, so a caller cannot edit the log', () => {
    recordVisibleMessage('a');
    getRecentVisibleMessages()[0].text = 'changed';
    expect(getRecentVisibleMessages()[0].text).toBe('a');
  });
});
