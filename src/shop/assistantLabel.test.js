import { describe, expect, it } from 'vitest';
import { assistantNameFrom, assistantSpeakerLabel, assistantTagLines, ASSISTANT_NAME_MAX_CHARS } from './assistantLabel.js';

describe('assistantNameFrom', () => {
  it('is the trimmed name for a fleet avatar', () => {
    expect(assistantNameFrom({ name: '  Sky ' })).toBe('Sky');
  });
  it('is null for an ordinary shopper or anything malformed', () => {
    for (const raw of [undefined, null, true, 'Sky', {}, { name: '' }, { name: '   ' }, { name: 7 }]) {
      expect(assistantNameFrom(raw)).toBeNull();
    }
  });
});

describe('assistantTagLines', () => {
  it('shows the name, then the plain word assistant', () => {
    expect(assistantTagLines('Sky')).toEqual(['Sky', 'assistant']);
  });
  it('shortens a very long name with an ellipsis', () => {
    const [name] = assistantTagLines('x'.repeat(100));
    expect(name).toHaveLength(ASSISTANT_NAME_MAX_CHARS);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('assistantTagLines busy state (#3449)', () => {
  it('says busy only when the assistant is helping someone', () => {
    expect(assistantTagLines('Fig')[1]).toBe('assistant');
    expect(assistantTagLines('Fig', true)[1]).toBe('assistant · busy');
  });
});

describe('assistantSpeakerLabel', () => {
  it('is one line, the name then the plain word assistant', () => {
    expect(assistantSpeakerLabel('Juniper')).toBe('Juniper \u00b7 assistant');
  });
  it('shortens a very long name exactly as the avatar tag does', () => {
    const label = assistantSpeakerLabel('x'.repeat(100));
    expect(label).toBe(`${assistantTagLines('x'.repeat(100))[0]} \u00b7 assistant`);
  });
});
