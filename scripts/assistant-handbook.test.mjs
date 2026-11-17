import { describe, expect, it } from 'vitest';
import handbook from '../docs/assistant-handbook.md?raw';
import { parseHandbook, validateHandbook, controlMatches, NO_WORDS, SECTION_SEE, SECTION_WRONG } from './assistant-handbook-lib.mjs';

// #3615 (part of #3614): the handbook assistants answer from stays in its format.
// The format's rules live in scripts/assistant-handbook-lib.mjs; the walk against
// the real app is e2e/assistant-handbook-controls.test.mjs.
describe('docs/assistant-handbook.md', () => {
  const entries = parseHandbook(handbook);

  it('is in the format: question titles, steps, what you will see, what goes wrong, listed controls', () => {
    expect(validateHandbook(entries)).toEqual([]);
  });

  it('has the Build chapter with each task a builder asks about', () => {
    const titles = entries.filter((entry) => entry.chapter === 'Build').map((entry) => entry.title);
    for (const wanted of ['get my own', 'add an item', 'move an item', 'turn an item', 'remove an item', 'undo', 'several items', 'bundle', 'level', 'measure']) {
      expect(titles.some((title) => title.toLowerCase().includes(wanted)), wanted).toBe(true);
    }
  });

  it('says how to keep it true when the interface changes', () => {
    expect(handbook).toContain('**When you change the interface:**');
    expect(handbook).toContain('e2e/assistant-handbook-controls.test.mjs');
  });
});

const entry = (overrides = '') => `# Handbook\n\n## Build\n\n### How do I do it?\n\n1. Tap "Go".\n\n${SECTION_SEE} it.\n\n${SECTION_WRONG}\n- Nothing.\n\n${overrides || '```controls build\n#go | Go\n```'}\n`;

describe('validateHandbook', () => {
  it('accepts a well-formed entry', () => {
    expect(validateHandbook(parseHandbook(entry()))).toEqual([]);
  });

  it('finds the controls with their mode, selector and words', () => {
    const [parsed] = parseHandbook(entry('```controls sell\n#a | Alpha\n.b[data-x="1"] | Beta words\n```'));
    expect(parsed.controls).toEqual([
      { selector: '#a', words: 'Alpha', mode: 'sell', line: expect.any(Number) },
      { selector: '.b[data-x="1"]', words: 'Beta words', mode: 'sell', line: expect.any(Number) },
    ]);
  });

  it('refuses a title that is not a question, an entry with no steps or no sections', () => {
    const text = '## Build\n\n### Do the thing\n\nNothing here.\n\n```controls build\n#go | Go\n```\n';
    const problems = validateHandbook(parseHandbook(text)).join('\n');
    expect(problems).toContain('question mark');
    expect(problems).toContain('no numbered steps');
    expect(problems).toContain(SECTION_SEE);
    expect(problems).toContain(SECTION_WRONG);
  });

  it('refuses an entry with no controls, a bad mode, or words its steps never name', () => {
    expect(validateHandbook(parseHandbook(entry('')).map((e) => ({ ...e, controls: [], controlBlocks: 0 }))).join('\n')).toContain('lists no controls');
    expect(validateHandbook(parseHandbook(entry('```controls moon\n#go | Go\n```'))).join('\n')).toContain('mode "moon"');
    expect(validateHandbook(parseHandbook(entry('```controls build\n#go | Stop\n```'))).join('\n')).toContain('never name "Stop"');
    expect(validateHandbook(parseHandbook(entry('```controls build\n#go\n```'))).join('\n')).toContain('no words after the bar');
  });

  it('refuses the unaccented word, internal words and issue numbers in what an assistant says', () => {
    const bad = entry().replace('Tap "Go".', 'Tap "Go" on your land, see #123 or src/app.css.');
    const problems = validateHandbook(parseHandbook(bad)).join('\n');
    expect(problems).toContain('"land"');
    expect(problems).toContain('#123');
    expect(problems).toContain('src/');
    // The accented word is the right one.
    expect(validateHandbook(parseHandbook(entry().replace('Tap "Go".', 'Tap "Go" on your lándlet.')))).toEqual([]);
  });

  it('refuses two entries with the same title and an unclosed controls block', () => {
    expect(validateHandbook([...parseHandbook(entry()), ...parseHandbook(entry())]).join('\n')).toContain('two entries have this title');
    expect(() => parseHandbook('## Build\n\n### Q?\n\n```controls build\n#go | Go\n')).toThrow('never closed');
  });
});

describe('a control with no words on it', () => {
  it('needs only to be on the page, and its entry need not name any words', () => {
    expect(validateHandbook(parseHandbook(entry(`\`\`\`controls shop\n#pad | ${NO_WORDS}\n\`\`\``)))).toEqual([]);
    expect(controlMatches({ exists: true, text: '' }, NO_WORDS)).toBe(true);
    expect(controlMatches({ exists: false }, NO_WORDS)).toBe(false);
  });
});

describe('controlMatches', () => {
  it('needs the element and the words on something a person reads, ignoring case and spacing', () => {
    expect(controlMatches({ exists: true, text: '+ Add   Item' }, 'add item')).toBe(true);
    expect(controlMatches({ exists: true, text: '', ariaLabel: 'Level up' }, 'Level up')).toBe(true);
    expect(controlMatches({ exists: true, placeholder: 'Search products' }, 'Search')).toBe(true);
    expect(controlMatches({ exists: true, text: 'Remove' }, 'Add Item')).toBe(false);
    expect(controlMatches({ exists: false }, 'Add Item')).toBe(false);
    expect(controlMatches(null, 'Add Item')).toBe(false);
  });
});
