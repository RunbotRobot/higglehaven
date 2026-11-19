// #3555 (interface week, #3539): offering friendship by tapping a person's
// avatar in the world, so meeting someone no longer means typing their exact
// name into a second popup. The typed name stays in the Friends leaf as the
// fallback for someone who is not nearby.
//
// Same shape as blocks.js's shared flow: one in-app confirmation (never a
// browser dialog), the request runs inside it so a failure shows where the
// person tapped, and the copy says only what the person using it sees.
//
// A block is silent (AGENTS.md, "A block is silent"): the server stores a
// request to someone who blocked the sender like any other and answers the same,
// and someone who is blocked is simply not drawn, so nothing here can tell the
// sender how a request was received. The success line says "sent", never
// "delivered" or "waiting for them to accept".
import { sendFriendRequest } from './api.js';
import { confirmDestructive } from './ui/confirmModal.js';
import { showFadingNote } from './ui/fadingNote.js';

export function friendOfferTitle(label) {
  return label ? `Offer friendship to ${label}?` : 'Offer friendship?';
}

export async function confirmAndOfferFriendship(builderId, label = null) {
  const sent = await confirmDestructive({
    title: friendOfferTitle(label),
    message: label ? `Send ${label} a friend request.` : 'Send them a friend request.',
    confirmLabel: 'Send request',
    cancelLabel: 'Not now',
    variant: 'primary',
    onConfirm: async () => {
      try {
        await sendFriendRequest(builderId);
      } catch (err) {
        // The server's own sentence says why (already friends or a request is
        // already open, a limit, an id check still to do); fall back to a plain
        // line only when it sent none.
        throw new Error(err?.message || 'Could not send the request -- please try again.');
      }
    },
  });
  // A success fades by itself (#3552); a failure stayed in the confirmation
  // above until dismissed, where the person tapped (#3303).
  if (sent) showFadingNote(label ? `Friend request sent to ${label}.` : 'Friend request sent.');
  return sent;
}
