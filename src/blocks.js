// #3140 (sub-issue of #3124): the one confirm-and-block flow every surface
// with a Block control shares (nearby chat, proximity voice, the friends
// list), so the wording and the failure handling are identical everywhere.
// Copy describes only what the person using it sees -- never whether or how
// the other person finds out (a block is silent).
// #3278: the confirmation is the shared in-app modal (not window.confirm);
// the block runs inside it, so a failure is shown where they tapped. The
// optional restore* args re-arm the modal this was launched from (the
// friends list); the nearby-chat and voice panels are HUD panels, not modals.
import { blockPerson } from './api.js';
import { confirmDestructive } from './ui/confirmModal.js';

export async function confirmAndBlockPerson(builderId, { restoreModalEl = null, restoreCloseFn = null, returnFocusEl = null } = {}) {
  const blocked = await confirmDestructive({
    title: 'Block this person?',
    message: "Block this person? You won't see them and they can't message you.",
    confirmLabel: 'Block',
    restoreModalEl,
    restoreCloseFn,
    returnFocusEl,
    onConfirm: async () => {
      try {
        await blockPerson({ builderId });
      } catch {
        throw new Error('Could not block this person -- please try again.');
      }
    },
  });
  if (blocked) window.alert('Blocked. You can unblock them from Blocked people in your friends list.');
  return blocked;
}
