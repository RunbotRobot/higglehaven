import { describe, it, expect } from 'vitest';
import { shouldCloseForNewPanel, BUD_PANEL_IDS } from './budPanels.js';

const el = (id) => ({ id });

describe('one bud panel at a time (#3843)', () => {
  it('opening a bud panel closes another bud panel that is up', () => {
    expect(shouldCloseForNewPanel(el('notifications-modal'), el('my-purchases-modal'))).toBe(true);
    expect(shouldCloseForNewPanel(el('settings-modal'), el('friends-modal'))).toBe(true);
    expect(shouldCloseForNewPanel(el('my-lands-modal'), el('notifications-modal'))).toBe(true);
  });
  it('does not close the panel being opened again, or nothing', () => {
    const friends = el('friends-modal');
    expect(shouldCloseForNewPanel(friends, friends)).toBe(false);
    expect(shouldCloseForNewPanel(null, el('friends-modal'))).toBe(false);
  });
  it('leaves dialogs opened from inside a panel stacking over it', () => {
    expect(shouldCloseForNewPanel(el('friends-modal'), el('dm-modal'))).toBe(false);
    expect(shouldCloseForNewPanel(el('settings-modal'), el('confirm-modal'))).toBe(false);
    expect(shouldCloseForNewPanel(el('dm-modal'), el('friends-modal'))).toBe(false);
  });
  it('names the five panels the flower opens', () => {
    expect([...BUD_PANEL_IDS].sort()).toEqual(
      ['friends-modal', 'my-lands-modal', 'my-purchases-modal', 'notifications-modal', 'settings-modal'],
    );
  });
});
