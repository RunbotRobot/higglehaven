// #3760 (part of #3759): four menus, and the general one is the same in every mode.
import { describe, it, expect } from 'vitest';
import { BUD_MENUS, budMenuProblem } from './budMenuRules.js';

describe('the bud\'s menus (#3760)', () => {
  it('are the general menu and one per place', () => {
    expect(BUD_MENUS).toEqual(['general', 'shop', 'build', 'sell']);
  });

  it('refuses a mode\'s tool in the general menu, and says what to do instead', () => {
    for (const id of ['add-item', 'levels', 'tools', 'undo-redo', 'my-products', 'add-product', 'my-lands']) {
      const problem = budMenuProblem('general', { id });
      expect(problem, id).toMatch(/not a member of the general menu/);
      expect(problem).toMatch(/own menu/);
    }
  });

  it('accepts the general menu\'s own members, by id or by the id of the row it adopts', () => {
    expect(budMenuProblem('general', { id: 'help', label: '?' })).toBeNull();
    expect(budMenuProblem('general', { id: 'settings', domId: 'settings-btn' })).toBeNull();
    for (const domId of ['account-auth-btn', 'notifications-btn', 'friends-btn', 'assistant-menu-btn', 'my-purchases-btn']) {
      expect(budMenuProblem('general', { id: 'row', domId })).toBeNull();
    }
  });

  it('accepts any tool in a place\'s own menu, and refuses a petal that names another menu', () => {
    expect(budMenuProblem('build', { id: 'levels' })).toBeNull();
    expect(budMenuProblem('sell', { id: 'my-products', menu: 'sell' })).toBeNull();
    expect(budMenuProblem('build', { id: 'levels', menu: 'general' })).toMatch(/general menu but is registered under build/);
    expect(budMenuProblem('lobby', { id: 'x' })).toMatch(/unknown menu/);
  });
});
