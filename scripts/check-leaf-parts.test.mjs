// The real stylesheet against its baseline is checked by scripts/check-leaf-parts.mjs from
// pretest, because this runner has no access to the repository's files.
import { describe, expect, it } from 'vitest';
import { looks } from './check-leaf-parts.mjs';

describe('check-leaf-parts (#3942)', () => {
  it('counts one look however many rules share it, and skips states and comments', () => {
    const css = `
      /* .x-btn { border-radius: 9px; } */
      .a-btn { padding: 4px; border: 1px solid red; background: none; border-radius: 99px; color: #000; }
      .b-btn { padding: 4px; border: 1px solid red; background: none; border-radius: 99px; color: #000; }
      .b-btn:disabled { border-radius: 1px; }
      @media (max-width: 400px) { .c-btn { padding: 8px; border-radius: 99px; } }
      .f input { padding: 2px; border: 1px solid blue; }
    `;
    expect(looks(css)).toEqual({ buttons: 2, fields: 1, rows: 0 });
  });

  it('counts a list row look once however many row classes share it (#3939)', () => {
    const css = `
      .a-row, .b-row { padding: 8px; background: #eee; border-radius: 6px; }
      .c-row { padding: 4px; background: #ddd; border-radius: 6px; }
      .c-row-info { padding: 1px; background: #ccc; border-radius: 2px; }
      .c-row:hover { padding: 9px; background: #000; border-radius: 1px; }
      .d-row { display: flex; }
    `;
    expect(looks(css).rows).toBe(2);
  });
});
