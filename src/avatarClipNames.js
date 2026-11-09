// #2744: what the upload wizard tells a seller about a model's animation clips.
// Pure (clip names in, text out) so it is unit-testable without three.js, like
// src/skeletonSignature.js.
//
// An avatar's clips are picked up only when they are named exactly idle, walk
// and/or fly (case-sensitive, THREE.AnimationClip.findByName). A model from a
// download site often carries clips under other names ("Walking",
// "Armature|Walk", "mixamo.com"), and the owner's equipped avatar silently never
// walked because of it. Saying which names the file actually has lets the seller
// see why and fix it in their 3D tool; before this the wizard only gave a count.

export const AVATAR_CLIP_NAMES = ['idle', 'walk', 'fly'];

const MAX_NAMES_SHOWN = 5;
const MAX_NAME_CHARS = 32;

function shortName(name) {
  const text = String(name ?? '').trim() || '(unnamed)';
  return text.length > MAX_NAME_CHARS ? `${text.slice(0, MAX_NAME_CHARS - 1)}…` : text;
}

// clipNames: the names of every animation clip in the model, in file order.
// Returns the sentence to show, or null when there is nothing to say (a model
// with no clips at all is an ordinary product, e.g. a chair, so stays quiet).
export function describeAvatarClips(clipNames) {
  if (!Array.isArray(clipNames) || clipNames.length === 0) return null;
  const matched = AVATAR_CLIP_NAMES.filter((name) => clipNames.includes(name));
  if (matched.length > 0) {
    return `Avatar animations detected: ${matched.join(', ')} — these play automatically if this is equipped as an avatar.`;
  }
  const shown = clipNames.slice(0, MAX_NAMES_SHOWN).map(shortName).join(', ');
  const more = clipNames.length > MAX_NAMES_SHOWN ? ` and ${clipNames.length - MAX_NAMES_SHOWN} more` : '';
  const count = clipNames.length;
  return `This model has ${count} animation clip${count === 1 ? '' : 's'} (${shown}${more}), but none named idle, walk or fly (exactly those names, lower case) — `
    + "if equipped as an avatar it'll still move, just without playing them. Rename them in your 3D tool and upload again to use them.";
}

// #2744 (owner, 2026-11-08): a model with no animation clips at all is a static
// mesh, and the wizard said nothing, which is what sent everyone looking for a
// naming problem instead. When the seller lists such a model as an equippable
// avatar, say so plainly. Stays quiet for an ordinary product (a chair has no
// walk cycle and does not need telling) and until the file's clips are known
// (clipCount null). Without clips the avatar still moves, as a rigid whole:
// it slides around rather than walking.
export function describeNoAnimationsForAvatar(clipCount, listedAsAvatar) {
  if (!listedAsAvatar || clipCount !== 0) return null;
  return 'This model has no animations. As an avatar it will slide around without walking, unless a buyer applies an animation to it.';
}
