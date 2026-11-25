// #4201: when the head should wear a note about removed items. Only when there are more of them than the builder has
// already looked at, so an old list that has been seen never nags again, and a newly removed item does. The builder's
// own count is kept on this device (a note, not a record: the list itself is the server's).
export function shouldNoteRemoved(count, seenCount) {
  return Number.isFinite(count) && count > 0 && count > (Number.isFinite(seenCount) ? seenCount : 0);
}
