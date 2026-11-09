// #2744 / #3287: which of a model's animation clips play as an avatar's idle,
// walk and fly, and what the upload wizard tells a seller about that. Pure
// (clip names in, roles/text out) so it is unit-testable without three.js,
// like src/skeletonSignature.js.
//
// A model from a download site often carries clips under the names those sites
// use ("Walking", "Armature|Walk", "Idle", "mixamo.com"); matching only the
// exact lower-case words meant such an avatar silently never animated. One
// function decides the roles, and the shopper's own avatar, other players'
// avatars and the upload wizard all call it, so they cannot drift apart.

export const AVATAR_CLIP_NAMES = ['idle', 'walk', 'fly'];

// After an exact name, these whole names count for a role; after those, any
// name that merely contains the role's word does.
const ALIASES = {
  idle: ['standing', 'breathing idle'],
  walk: ['walking', 'walk cycle'],
  fly: ['flying'],
};

const MAX_NAMES_SHOWN = 5;
const MAX_NAME_CHARS = 32;

function shortName(name) {
  const text = String(name ?? '').trim() || '(unnamed)';
  return text.length > MAX_NAME_CHARS ? `${text.slice(0, MAX_NAME_CHARS - 1)}…` : text;
}

// "Armature|Walk" -> "walk": exporters prefix the clip with its armature, so
// only the part after the last "|" is the clip's own name.
function normalizedName(name) {
  const text = String(name ?? '');
  return text.slice(text.lastIndexOf('|') + 1).trim().toLowerCase();
}

// How well a clip name fits a role: 0 exact, 1 listed alias, 2 contains the
// role's word, null no fit.
function matchRank(normalized, role) {
  if (normalized === role) return 0;
  if (ALIASES[role].includes(normalized)) return 1;
  if (normalized.includes(role)) return 2;
  return null;
}

// clipNames: every animation clip name in the model, in file order.
// roles: which roles the caller can use (other players' bodies have no fly).
// Returns { idle, walk, fly }, each the index into clipNames of the clip that
// plays for that role, or null. A clip serves at most one role, so "walk_idle"
// cannot be both; better fits are settled first, ties go in idle, walk, fly
// order and then file order.
export function matchAvatarClips(clipNames, roles = AVATAR_CLIP_NAMES) {
  const result = { idle: null, walk: null, fly: null };
  if (!Array.isArray(clipNames) || clipNames.length === 0) return result;
  const candidates = [];
  clipNames.forEach((name, index) => {
    const normalized = normalizedName(name);
    for (const role of roles) {
      const rank = matchRank(normalized, role);
      if (rank !== null) candidates.push({ role, index, rank });
    }
  });
  candidates.sort((a, b) => a.rank - b.rank
    || AVATAR_CLIP_NAMES.indexOf(a.role) - AVATAR_CLIP_NAMES.indexOf(b.role)
    || a.index - b.index);
  const usedClips = new Set();
  for (const { role, index } of candidates) {
    if (result[role] !== null || usedClips.has(index)) continue;
    result[role] = index;
    usedClips.add(index);
  }
  // A lone clip called "mixamo.com" is what a Mixamo download names its one
  // animation; with nothing else to go on it is the idle loop.
  if (clipNames.length === 1 && normalizedName(clipNames[0]) === 'mixamo.com' && roles.includes('idle')) {
    result.idle = 0;
  }
  return result;
}

// clips: objects with a `name` (THREE.AnimationClip). Returns { idle, walk, fly }
// holding the clip for each role, or null.
export function pickAvatarClips(clips, roles = AVATAR_CLIP_NAMES) {
  const list = Array.isArray(clips) ? clips : [];
  const indexes = matchAvatarClips(list.map((clip) => clip?.name), roles);
  const picked = {};
  for (const role of AVATAR_CLIP_NAMES) picked[role] = indexes[role] === null ? null : list[indexes[role]];
  return picked;
}

// clipNames: the names of every animation clip in the model, in file order.
// Returns the sentence to show, or null when there is nothing to say (a model
// with no clips at all is an ordinary product, e.g. a chair, so stays quiet).
export function describeAvatarClips(clipNames) {
  if (!Array.isArray(clipNames) || clipNames.length === 0) return null;
  const indexes = matchAvatarClips(clipNames);
  const matched = AVATAR_CLIP_NAMES.filter((role) => indexes[role] !== null).map((role) => {
    const raw = clipNames[indexes[role]];
    // Say which clip each role came from when the name was not simply the role.
    return raw === role ? role : `${role} (from ${shortName(raw)})`;
  });
  if (matched.length > 0) {
    return `Avatar animations detected: ${matched.join(', ')} — these play automatically if this is equipped as an avatar.`;
  }
  const shown = clipNames.slice(0, MAX_NAMES_SHOWN).map(shortName).join(', ');
  const more = clipNames.length > MAX_NAMES_SHOWN ? ` and ${clipNames.length - MAX_NAMES_SHOWN} more` : '';
  const count = clipNames.length;
  return `This model has ${count} animation clip${count === 1 ? '' : 's'} (${shown}${more}), but none that look like idle, walk or fly (names like Idle, Walking or Flying work) — `
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

// #3315 (part of #3301): the upload wizard's "Which motion is this clip?"
// picker. A pick per clip is one of idle/walk/fly/none ("Not used"). The
// starting picks are what the name matcher decided, so a correctly named file
// needs no interaction; only when the seller changes something does the wizard
// send a clipRoles at all (otherwise name matching keeps applying, and a later
// improvement to it still reaches the product).
export const CLIP_PICK_CHOICES = [...AVATAR_CLIP_NAMES, 'none'];
const MAX_CLIP_ROLE_NAME_CHARS = 200; // the server's own cap on a stored clip name

// One entry per clip, in file order: the role the name matcher gives it, or 'none'.
export function defaultClipPicks(clipNames) {
  const picks = (Array.isArray(clipNames) ? clipNames : []).map(() => 'none');
  const indexes = matchAvatarClips(clipNames);
  for (const role of AVATAR_CLIP_NAMES) {
    if (indexes[role] !== null) picks[indexes[role]] = role;
  }
  return picks;
}

// Sets one clip's pick. A role holds one clip, so picking a role another clip
// holds moves it (that clip becomes 'none'). Returns a new array.
export function pickClipRole(picks, clipIndex, role) {
  const next = picks.slice();
  if (role !== 'none') {
    next.forEach((held, index) => { if (held === role) next[index] = 'none'; });
  }
  next[clipIndex] = role;
  return next;
}

// What to send as clipRoles: null while the picks are still the matcher's own,
// otherwise { idle, walk, fly } holding a clip NAME (the form the server stores)
// or null per role. A clip name the server would refuse (empty, too long) or a
// name already given to another role is left out rather than failing the whole
// upload over it.
export function clipRolesFromPicks(clipNames, picks) {
  const defaults = defaultClipPicks(clipNames);
  if (picks.length === defaults.length && picks.every((pick, index) => pick === defaults[index])) return null;
  const roles = { idle: null, walk: null, fly: null };
  const used = new Set();
  picks.forEach((role, index) => {
    if (role === 'none') return;
    const name = String(clipNames[index] ?? '');
    if (name.trim() === '' || name.length > MAX_CLIP_ROLE_NAME_CHARS || used.has(name)) return;
    used.add(name);
    roles[role] = name;
  });
  return roles;
}
