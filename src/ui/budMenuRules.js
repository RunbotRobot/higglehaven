// #3760, reshaped by #4025 (part of #3759, the flower): three menus, one per place (Shop, Build, Sell),
// and one row. The open menu is always the menu of the place a person is in, so it never changes with
// circumstance (the owner: "all menus always show the same options"). What belongs to no place (the
// account, Notices, Settings, Help) is the row of icons along the top, the same in every place. A petal
// belongs to the menu it is registered for; the row's members are fixed here, so putting a place's tool
// in the row is a deliberate edit of this list and of docs/DESIGN.md ("The bud"), never an accident of
// registration. Pure, so it is testable without a page.

export const BUD_MENUS = ['shop', 'build', 'sell'];
export const BUD_ROW = 'row';

export const ROW_IDS = new Set([
  'account-auth-btn', 'notifications-btn', 'assistant-menu-btn', 'settings-btn', 'help',
]);

// What is wrong with registering `petal` under `menu` (a place, or the row), or null. A tool of a place
// registered into the row is refused (an error in development and in tests, so it is caught the day it is written).
export function budMenuProblem(menu, petal) {
  if (menu !== BUD_ROW && !BUD_MENUS.includes(menu)) return `unknown menu "${menu}"`;
  if (petal.menu && petal.menu !== menu) return `petal "${petal.id}" says it is in the ${petal.menu} menu but is registered under ${menu}`;
  if (menu === BUD_ROW && !ROW_IDS.has(petal.domId ?? petal.id)) {
    return `"${petal.id}" is not a member of the top row; the row is the same in every place, so a tool of one place goes under that place's own menu (src/ui/budMenuRules.js, docs/DESIGN.md "The bud")`;
  }
  return null;
}
