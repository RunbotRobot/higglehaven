// #3760 (part of #3759, the flower): four menus, one open at a time. The general menu is the same
// in every mode (the owner: "all menus always show the same options"); each place's own tools live
// under that place's petal. A petal belongs to the menu it is registered for. The general menu's
// members are fixed here, so putting a place's tool in it is a deliberate edit of this list and of
// docs/DESIGN.md ("The bud"), never an accident of registration. Pure, so it is testable without a page.

export const BUD_MENUS = ['general', 'shop', 'build', 'sell'];

export const GENERAL_IDS = new Set([
  'account-auth-btn', 'notifications-btn', 'friends-btn', 'assistant-menu-btn', 'my-purchases-btn', 'settings-btn', 'help',
]);

// What is wrong with registering `petal` under `menu`, or null. A tool of a place registered into the
// general menu is refused (an error in development and in tests, so it is caught the day it is written).
export function budMenuProblem(menu, petal) {
  if (!BUD_MENUS.includes(menu)) return `unknown menu "${menu}"`;
  if (petal.menu && petal.menu !== menu) return `petal "${petal.id}" says it is in the ${petal.menu} menu but is registered under ${menu}`;
  if (menu === 'general' && !GENERAL_IDS.has(petal.domId ?? petal.id)) {
    return `"${petal.id}" is not a member of the general menu; the general menu is the same in every mode, so a tool of one place goes under that place's own menu (src/ui/budMenuRules.js, docs/DESIGN.md "The bud")`;
  }
  return null;
}
