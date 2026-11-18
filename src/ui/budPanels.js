// #3843 (part of #3539): the flower is one menu or leaf at a time, and Settings, Notices, Friends,
// My Purchases and My Lándlets are the panels a person opens from it. Opening one of them while
// another is up closes the other, so two never stand on the world together. Dialogs that are
// opened from inside a panel on purpose (a confirm, a direct message, the friends map) are not in
// this set and still stack over it.
export const BUD_PANEL_IDS = new Set([
  'settings-modal', 'notifications-modal', 'my-purchases-modal', 'friends-modal', 'my-lands-modal',
]);

// True when opening `nextEl` should first close `currentEl`: both are bud panels and they differ.
export function shouldCloseForNewPanel(currentEl, nextEl) {
  return Boolean(currentEl && nextEl && currentEl !== nextEl
    && BUD_PANEL_IDS.has(currentEl.id) && BUD_PANEL_IDS.has(nextEl.id));
}
