// #3875: the sentences an empty leaf shows are written once (EMPTY_COPY). The page's static text and the
// assistants' handbook must say the same words, so the three cannot drift.
import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import handbook from '../../docs/assistant-handbook.md?raw';
import { EMPTY_COPY } from './emptyState.js';

const text = (id) => {
  const m = html.match(new RegExp(`<div id="${id}"[^>]*>([^<]*)</div>`));
  return m ? m[1].trim() : null;
};

describe('empty leaves', () => {
  it('index.html says the same sentence the code resets to', () => {
    expect(text('notifications-empty')).toBe(EMPTY_COPY.notices);
    expect(text('friends-panel-empty')).toBe(EMPTY_COPY.friends);
    expect(text('my-purchases-empty')).toBe(EMPTY_COPY.purchases);
    expect(text('my-lands-empty')).toBe(EMPTY_COPY.lands);
    expect(text('shop-nearby-chat-empty')).toBe(EMPTY_COPY.chat);
    // The Build search leaf names the query in the middle, so only its first-step sentence is compared.
    expect(html).toMatch(new RegExp(`<div id="catalog-picker-empty" class="empty-state" hidden>[^<]*<span id="catalog-picker-empty-query"></span>"\\. ${EMPTY_COPY.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</div>`));
  });

  it('wears the one shared look', () => {
    for (const id of ['notifications-empty', 'friends-panel-empty', 'my-purchases-empty', 'my-lands-empty', 'shop-nearby-chat-empty']) {
      expect(html).toMatch(new RegExp(`<div id="${id}" class="empty-state"`));
    }
  });

  it('the handbook quotes every sentence', () => {
    for (const sentence of Object.values(EMPTY_COPY)) expect(handbook).toContain(sentence);
  });

  it('says "lándlet" with the accent and no internals', () => {
    for (const sentence of Object.values(EMPTY_COPY)) {
      expect(sentence).not.toMatch(/\bland(let)?\b/i);
      expect(sentence).not.toMatch(/#\d+|docs\/|API/);
    }
  });
});
