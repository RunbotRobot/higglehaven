// The remembered "which body does this account wear" hint (#3905, #4106). Arriving in Shop shows the fog until the
// real avatar is ready only when this says `custom`; the hint used to be written only while mounting the avatar, so
// someone who equipped a model in Settings and then reloaded was shown the standard body first (#4067). It is now
// also written right after a successful equip, so the next arrival already knows. The server's equipped record
// stays the authority: this is only a guess about the next load.
export const wornHintKey = (userId) => `hh-worn-avatar:${userId ?? ''}`;

export function readWornHint(storage, userId) {
  try { return storage.getItem(wornHintKey(userId)); } catch { return null; }
}

export function writeWornHint(storage, userId, kind) {
  if (!userId) return;
  try { storage.setItem(wornHintKey(userId), kind); } catch { /* remembered only when allowed */ }
}

// What an equip call answered with: a model means a custom body, none means the standard one.
export function hintKindForEquipped(avatar) {
  return avatar && avatar.modelUrl ? 'custom' : 'default';
}
