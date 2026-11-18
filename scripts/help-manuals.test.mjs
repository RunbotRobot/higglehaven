import { describe, expect, it } from 'vitest';
import handbook from '../docs/assistant-handbook.md?raw';
import { parseHandbook } from './assistant-handbook-lib.mjs';
import { MANUALS, buildManuals, readEntry } from '../src/ui/helpManuals.js';

// #3762: the "?" pages are the handbook's own entries, so these checks keep what a person reads
// there honest: every listed entry exists, is shown whole, and speaks to the person ("you"), not
// to the assistant.
const entries = parseHandbook(handbook);
const pages = buildManuals(entries);

describe('the "?" pages', () => {
  it('has the five pages the owner asked for, in order', () => {
    expect(pages.map((page) => page.title)).toEqual(['How to move', 'How higglehaven works', 'Shopping', 'Building', 'Selling']);
  });

  it('every entry a page lists is in the handbook', () => {
    const titles = new Set(entries.map((entry) => entry.title));
    const missing = MANUALS.flatMap((manual) => manual.entries.filter((title) => !titles.has(title)));
    expect(missing).toEqual([]);
  });

  it('no entry is listed on two pages', () => {
    const all = MANUALS.flatMap((manual) => manual.entries);
    expect(new Set(all).size).toBe(all.length);
  });

  for (const page of pages) {
    describe(page.title, () => {
      it('has entries, each with steps and what you will see', () => {
        expect(page.entries.length).toBeGreaterThan(0);
        for (const entry of page.entries) {
          expect(entry.steps.length, entry.title).toBeGreaterThan(0);
          expect(entry.see.length, entry.title).toBeGreaterThan(0);
        }
      });

      it('speaks to the person and never to the assistant', () => {
        for (const entry of page.entries) {
          const text = [...entry.steps, entry.see].join('\n');
          expect(text, entry.title).not.toMatch(/\b(?:runbook|hand-off|offer to|read (?:it|them|the \w+) (?:back|out)|the person|a person|people who ask)\b/i);
          expect(text, entry.title).not.toMatch(/[*`#]/);
        }
      });
    });
  }
});

describe('readEntry', () => {
  it('joins a step that runs over several lines and leaves out the trouble-shooting part', () => {
    const [entry] = parseHandbook('## A\n\n### Q?\n\n1. First\n   goes on.\n2. Second.\n\n**You will see:** it **work**.\n\n**If something goes wrong:**\n- Ask.\n\n```controls any\n#x | y\n```\n');
    expect(readEntry(entry)).toEqual({ title: 'Q?', steps: ['First goes on.', 'Second.'], see: 'it work.' });
  });
});
