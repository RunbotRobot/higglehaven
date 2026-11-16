import { describe, expect, it } from 'vitest';
import { mergeMessages, replyState, endedNotice, readingNotice, slowNotice, offShiftNotice, disclosureText, freeAssistantOffer, offerLabel, canLeaveQuestion, questionNotice, questionInLine, handoverNotice, pillLabel, hasNewAssistantMessage, chatPollIntervalMs, WAITING_POLL_MS, IDLE_POLL_MS,
  keyboardInset,
} from './assistantChatLogic.js';

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

describe('free assistant offer (#3448)', () => {
  it('offers the assistant the server named, and nobody otherwise', () => {
    expect(freeAssistantOffer({ freeAssistant: { userId: 'u-1', name: 'Clover' } })).toEqual({ userId: 'u-1', name: 'Clover' });
    expect(freeAssistantOffer({ freeAssistant: null })).toBeNull();
    expect(freeAssistantOffer({})).toBeNull();
    expect(freeAssistantOffer(null)).toBeNull();
    expect(freeAssistantOffer({ freeAssistant: { userId: 3, name: 'Clover' } })).toBeNull();
    expect(freeAssistantOffer({ freeAssistant: { userId: 'u-1', name: '' } })).toBeNull();
  });
  it('words the offer with the name and no internals', () => {
    expect(offerLabel('Clover')).toBe('Clover is free. Talk to Clover instead');
  });
});

describe('left questions (#3448)', () => {
  it('offers to leave a question only after a busy or off-shift refusal', () => {
    expect(canLeaveQuestion({ assistantBusy: true })).toBe(true);
    expect(canLeaveQuestion({ assistantOnShift: false })).toBe(true);
    expect(canLeaveQuestion({ idVerificationRequired: true })).toBe(false);
    expect(canLeaveQuestion({ limit: 60 })).toBe(false);
    expect(canLeaveQuestion(null)).toBe(false);
  });

  it('states the place in line, that closing keeps it, and how long it is kept, from the server numbers', () => {
    const text = questionNotice({ status: 'waiting', position: 3 }, { keptDays: 7, assistantsOnShift: 2 });
    expect(text).toContain("You're number 3 in line.");
    expect(text).toContain('your place is kept');
    expect(text).toContain('7 days');
    expect(text).not.toContain('No assistant is on the floor');
  });

  it('says so plainly when nobody is on the floor, and when an assistant is reading it', () => {
    expect(questionNotice({ status: 'waiting', position: 1 }, { keptDays: 7, assistantsOnShift: 0 })).toContain('No assistant is on the floor right now');
    expect(questionNotice({ status: 'claimed', position: 1 }, { keptDays: 7, assistantsOnShift: 1 })).toContain('An assistant is reading your question.');
  });

  it('tells a shopper whose question went unanswered, and says nothing once it is answered', () => {
    expect(questionNotice({ status: 'expired' }, { keptDays: 7, assistantsOnShift: 1 })).toBe('Nobody answered your question within 7 days. You can ask again.');
    expect(questionNotice({ status: 'answered' }, { keptDays: 7, assistantsOnShift: 1 })).toBe('');
    expect(questionInLine({ status: 'waiting' })).toBe(true);
    expect(questionInLine({ status: 'answered' })).toBe(false);
  });
});

describe('handoverNotice (#3448)', () => {
  it('says who passed the conversation to whom, and that nothing needs repeating', () => {
    expect(handoverNotice({ assistant: { name: 'Clover' }, handedOver: { at: 'x', fromName: 'Juniper' } }))
      .toBe('Juniper passed your conversation to Clover, who can see everything you wrote.');
  });
  it('still says it when the first assistant is no longer known', () => {
    expect(handoverNotice({ assistant: { name: 'Clover' }, handedOver: { at: 'x', fromName: null } }))
      .toBe('Your conversation was passed to Clover, who can see everything you wrote.');
  });
  it('is null for a conversation that was never handed over', () => {
    expect(handoverNotice({ assistant: { name: 'Clover' }, handedOver: null })).toBeNull();
    expect(handoverNotice(null)).toBeNull();
  });
});

describe('chatPollIntervalMs (#3532)', () => {
  it('asks every second while the shopper waits for a reply, every two otherwise', () => {
    expect(WAITING_POLL_MS).toBe(1000);
    expect(IDLE_POLL_MS).toBe(2000);
    expect(chatPollIntervalMs([])).toBe(IDLE_POLL_MS);
    expect(chatPollIntervalMs([msg(1, 'shopper')])).toBe(WAITING_POLL_MS);
    expect(chatPollIntervalMs([msg(1, 'shopper'), msg(2, 'assistant')])).toBe(IDLE_POLL_MS);
    expect(chatPollIntervalMs([msg(1, 'shopper'), msg(2, 'assistant'), msg(3, 'shopper')])).toBe(WAITING_POLL_MS);
  });
});

describe('minimised panel (#3529)', () => {
  it('labels the pill with the assistant, and says when a reply came in', () => {
    expect(pillLabel('Juniper', false)).toBe('Juniper');
    expect(pillLabel('Juniper', true)).toBe('Juniper replied');
    expect(pillLabel(null, false)).toBe('Assistants');
  });
  it('sees a new assistant message, and nothing else', () => {
    const before = [msg(1, 'shopper')];
    expect(hasNewAssistantMessage(before, before)).toBe(false);
    expect(hasNewAssistantMessage(before, [...before, msg(2, 'shopper')])).toBe(false);
    expect(hasNewAssistantMessage(before, [...before, msg(2, 'assistant')])).toBe(true);
    expect(hasNewAssistantMessage([...before, msg(2, 'assistant')], [...before, msg(2, 'assistant')])).toBe(false);
  });
});

describe('keyboardInset (#3608)', () => {
  it('is how much of the layout viewport the keyboard covers', () => {
    expect(keyboardInset({ innerHeight: 844, visualHeight: 520, visualOffsetTop: 0 })).toBe(324);
    // the visible area scrolled down inside the layout viewport
    expect(keyboardInset({ innerHeight: 844, visualHeight: 520, visualOffsetTop: 100 })).toBe(224);
  });
  it('is 0 when nothing covers the page, or when the browser resized the layout viewport itself', () => {
    expect(keyboardInset({ innerHeight: 844, visualHeight: 844, visualOffsetTop: 0 })).toBe(0);
    expect(keyboardInset({ innerHeight: 520, visualHeight: 520, visualOffsetTop: 0 })).toBe(0);
  });
  it('is never negative and ignores numbers that are not', () => {
    expect(keyboardInset({ innerHeight: 500, visualHeight: 520, visualOffsetTop: 0 })).toBe(0);
    expect(keyboardInset({ innerHeight: 844, visualHeight: undefined, visualOffsetTop: 0 })).toBe(0);
  });
});
