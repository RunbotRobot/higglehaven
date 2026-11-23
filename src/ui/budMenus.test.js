// #3760, reshaped by #4025 (part of #3759): three menus, one per place, and one row the same everywhere.
import { describe, it, expect } from 'vitest';
import { BUD_MENUS, BUD_ROW, budMenuProblem } from './budMenuRules.js';

describe('the bud\'s menus (#4025)', () => {
  it('are one per place, and there is no general menu', () => {
    expect(BUD_MENUS).toEqual(['shop', 'build', 'sell']);
  });

  it('refuses a mode\'s tool in the top row, and says what to do instead', () => {
    for (const id of ['add-item', 'levels', 'tools', 'undo-redo', 'my-products', 'add-product', 'my-lands', 'friends-btn', 'my-purchases-btn']) {
      const problem = budMenuProblem(BUD_ROW, { id });
      expect(problem, id).toMatch(/not a member of the top row/);
      expect(problem).toMatch(/own menu/);
    }
  });

  it('accepts the row\'s own members, by id or by the id of the button it adopts', () => {
    expect(budMenuProblem(BUD_ROW, { id: 'help', label: '?' })).toBeNull();
    expect(budMenuProblem(BUD_ROW, { id: 'settings', domId: 'settings-btn' })).toBeNull();
    for (const domId of ['account-auth-btn', 'notifications-btn', 'assistant-menu-btn']) {
      expect(budMenuProblem(BUD_ROW, { id: 'row', domId })).toBeNull();
    }
  });

  it('accepts any tool in a place\'s own menu, and refuses a petal that names another menu', () => {
    expect(budMenuProblem('shop', { id: 'friends', domId: 'friends-btn' })).toBeNull();
    expect(budMenuProblem('build', { id: 'levels' })).toBeNull();
    expect(budMenuProblem('sell', { id: 'my-products', menu: 'sell' })).toBeNull();
    expect(budMenuProblem('build', { id: 'levels', menu: 'sell' })).toMatch(/sell menu but is registered under build/);
    expect(budMenuProblem('general', { id: 'x' })).toMatch(/unknown menu/);
    expect(budMenuProblem('lobby', { id: 'x' })).toMatch(/unknown menu/);
  });
});
