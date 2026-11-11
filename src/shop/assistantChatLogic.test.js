import { describe, expect, it } from 'vitest';
import { mergeMessages, replyState, endedNotice, readingNotice, slowNotice, offShiftNotice, disclosureText } from './assistantChatLogic.js';

const msg = (seq, sender, createdAt = '2026-11-11T10:00:00.000Z') => ({ seq, sender, text: `m${seq}`, createdAt });

describe('mergeMessages', () => {
  it('shows a message that arrives twice once, in order', () => {
    const merged = mergeMessages([msg(1, 'shopper'), msg(3, 'shopper')], [msg(2, 'assistant'), msg(3, 'shopper')]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
  it('starts from nothing', () => {
    expect(mergeMessages([], [msg(5, 'assistant')]).map((m) => m.seq)).toEqual([5]);
  });
});

describe('replyState', () => {
  const at = (iso) => Date.parse(iso);
  it('is none before anything is asked and once the assistant answered', () => {
    expect(replyState({ messages: [], nowMs: 0, replyWaitSeconds: 90 })).toBe('none');
    expect(replyState({ messages: [msg(1, 'shopper'), msg(2, 'assistant')], nowMs: at('2026-11-11T10:09:00.000Z'), replyWaitSeconds: 90 })).toBe('none');
  });
  it('is reading, then slow once the stated time has passed', () => {
    const messages = [msg(1, 'shopper', '2026-11-11T10:00:00.000Z')];
    expect(replyState({ messages, nowMs: at('2026-11-11T10:01:29.000Z'), replyWaitSeconds: 90 })).toBe('reading');
    expect(replyState({ messages, nowMs: at('2026-11-11T10:01:30.000Z'), replyWaitSeconds: 90 })).toBe('slow');
  });
  it('uses the number it is given, never its own', () => {
    const messages = [msg(1, 'shopper', '2026-11-11T10:00:00.000Z')];
    expect(replyState({ messages, nowMs: at('2026-11-11T10:00:20.000Z'), replyWaitSeconds: 10 })).toBe('slow');
  });
  it('counts the latest question, not an earlier one', () => {
    const messages = [msg(1, 'shopper', '2026-11-11T10:00:00.000Z'), msg(2, 'assistant', '2026-11-11T10:00:10.000Z'), msg(3, 'shopper', '2026-11-11T10:05:00.000Z')];
    expect(replyState({ messages, nowMs: at('2026-11-11T10:05:30.000Z'), replyWaitSeconds: 90 })).toBe('reading');
  });
});

describe('notices', () => {
  it('says who ended the conversation', () => {
    expect(endedNotice({ endedBy: 'assistant' }, 'Juniper')).toBe('Juniper ended the conversation.');
    expect(endedNotice({ endedBy: 'timeout' }, 'Juniper')).toMatch(/timed out/);
    expect(endedNotice({ endedBy: 'shopper' }, 'Juniper')).toBe('This conversation has ended.');
  });
  it('names the assistant and carries no internals', () => {
    for (const text of [readingNotice('Fig'), slowNotice('Fig'), offShiftNotice('Fig'), disclosureText('Fig')]) {
      expect(text).toContain('Fig');
      expect(text).not.toMatch(/#\d|docs\/|API|issue/i);
    }
    expect(disclosureText('Fig')).toContain('AI assistant');
  });
});
