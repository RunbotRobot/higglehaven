// #3140 (sub-issue of #3124): the one confirm-and-block flow every surface
// with a Block control shares (nearby chat, proximity voice, the friends
// list), so the wording and the failure handling are identical everywhere.
// Copy describes only what the person using it sees -- never whether or how
// the other person finds out (a block is silent).
import { blockPerson } from './api.js';

export async function confirmAndBlockPerson(builderId) {
  if (!window.confirm("Block this person? You won't see them and they can't message you.")) return false;
  try {
    await blockPerson({ builderId });
    window.alert('Blocked. You can unblock them from Blocked people in your friends list.');
    return true;
  } catch {
    window.alert('Could not block this person -- please try again.');
    return false;
  }
}
