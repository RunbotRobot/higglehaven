// #4498: every notification `kind` the Worker sets has a place for a tap to go in the Notices leaf.
import { describe, expect, it } from 'vitest';
import menuSource from './menu.js?raw';
import notificationsSource from '../../worker/lib/notifications.js?raw';
import socialSource from '../../worker/lib/social.js?raw';
import lifecycleSource from '../../worker/lib/purchase-lifecycle.js?raw';
import assistantSource from '../../worker/lib/assistant-chat.js?raw';

const KINDS = new Set();
for (const source of [socialSource, lifecycleSource, assistantSource]) {
  for (const match of source.matchAll(/null, '([a-z]+)'\)/g)) KINDS.add(match[1]);
}

describe('notice destinations (#4498)', () => {
  it('finds the kinds the Worker sets', () => {
    expect([...KINDS].sort()).toEqual(['assistant', 'friends', 'messages', 'purchases']);
    expect(notificationsSource).toContain('kind = null');
  });

  for (const kind of ['assistant', 'friends', 'messages', 'purchases']) {
    it(`the Notices leaf opens something for kind ${kind}`, () => {
      expect(menuSource).toMatch(new RegExp(`^\\s*${kind}: `, 'm'));
    });
  }
});
