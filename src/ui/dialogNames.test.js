import { describe, it, expect } from 'vitest';
import html from '../../index.html?raw';

// #3818: a dialog a screen reader enters has to say what it is. aria-modal puts everything behind it
// out of reach, so without a name a person hears "dialog" and nothing else. Every role="dialog" in the
// page either carries aria-label or points aria-labelledby at a heading that exists.
describe('every dialog in index.html has an accessible name', () => {
  const dialogs = [...html.matchAll(/<(div|section)\b[^>]*\brole="dialog"[^>]*>/g)].map((m) => m[0]);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  it('finds the dialogs', () => {
    expect(dialogs.length).toBeGreaterThan(20);
  });

  it('names each one, by a label or by a heading that is there', () => {
    const unnamed = [];
    for (const tag of dialogs) {
      const id = tag.match(/\sid="([^"]+)"/)?.[1] ?? tag;
      const label = tag.match(/\saria-label="([^"]+)"/)?.[1];
      const by = tag.match(/\saria-labelledby="([^"]+)"/)?.[1];
      if (label) continue;
      if (by && ids.has(by)) continue;
      unnamed.push(id);
    }
    expect(unnamed).toEqual([]);
  });
});
