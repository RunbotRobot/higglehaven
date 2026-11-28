// #4574: what a screen reader says for the Build item card's number fields. A field is named by what it is, and a
// field that shows a word on screen keeps that word in its name, so someone saying "tilt red" to a voice control can
// reach it (WCAG 2.5.3 label in name). Read from index.html, where the card's markup lives.
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';

describe('the item card\'s fields are named for a screen reader (#4574)', () => {
  it('names each Trim field Width, Depth or Height, with its unit as the description', () => {
    const names = { x: 'Width', y: 'Depth', z: 'Height' };
    for (const [axis, name] of Object.entries(names)) {
      const input = indexHtml.match(new RegExp(`<input class="trim-length-input" data-trim-axis="${axis}"[^>]*>`))?.[0];
      expect(input, axis).toBeTruthy();
      expect(input).toContain(`aria-label="${name}"`);
      expect(input).toContain(`aria-describedby="trim-unit-${axis}"`);
      expect(indexHtml).toContain(`id="trim-unit-${axis}"`);
    }
  });

  it('keeps the word shown beside each angle field inside its accessible name', () => {
    const fields = [...indexHtml.matchAll(/<label class="item-card-angle-field">([^<]+)<input[^>]*aria-label="([^"]+)"/g)];
    expect(fields.map((f) => f[1])).toEqual(['Turn', 'Tilt red', 'Tilt green']);
    for (const [, visible, name] of fields) expect(name.startsWith(visible), `${visible} / ${name}`).toBe(true);
  });
});
