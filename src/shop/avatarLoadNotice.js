// #4067: when the avatar a person wears cannot be loaded they are drawn as the default body (a failure is
// not a stand-in), and are told so once in plain words: a short word beside the head that stays until its
// sentence has been opened and read (#3303: an error or refusal stays), never a console line alone.
import { sayAtHead } from '../ui/headSaying.js';

export const AVATAR_LOAD_KEY = 'avatar-load';
export const AVATAR_LOAD_MESSAGE = "Your avatar didn't load, so you're shown as the default body for now. Reload to try again.";

export function sayAvatarDidNotLoad() {
  sayAtHead(AVATAR_LOAD_KEY, { word: 'Avatar', title: "Your avatar didn't load", message: AVATAR_LOAD_MESSAGE, readOnce: true });
}
