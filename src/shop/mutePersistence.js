// #3128: voice and nearby-chat mutes used to live only in memory, so a normal
// walk-away, reconnect or reload silently un-muted a harasser. This keeps a
// mute set in localStorage, keyed by the muting account (so two accounts on
// one browser don't share), and is DOM-free so it can be unit tested.
//
// Purely client-side: nothing here reaches the server, and the muted person
// can't detect it (the same "told nothing" posture #2819/#2956 established).
// Storage can be unavailable (private window, blocked site data) or throw on
// read/write, so every access is wrapped; without it the set simply behaves
// like the old in-memory one for that session.
const KEY_PREFIX = 'hh-muted';

function defaultStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function storageKey(kind, accountKey) {
  return `${KEY_PREFIX}:${kind}:${accountKey}`;
}

function loadIds(storage, kind, accountKey) {
  try {
    const raw = storage?.getItem(storageKey(kind, accountKey));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveIds(storage, kind, accountKey, ids) {
  try {
    if (ids.size === 0) storage?.removeItem(storageKey(kind, accountKey));
    else storage?.setItem(storageKey(kind, accountKey), JSON.stringify([...ids]));
  } catch {
    // Storage unavailable or full: keep working in memory for this session.
  }
}

// A Set-like (has/add/delete/values/size) bound to whichever account is
// signed in *right now*: getAccountKey() is read on every call, so signing in
// or out (or switching accounts) swaps to that account's own set rather than
// leaking one account's mutes onto another. A signed-out viewer (null key)
// gets an in-memory-only set that is never written.
export function createPersistentMuteSet(kind, getAccountKey, storage = defaultStorage()) {
  let boundKey = null;
  let ids = new Set();
  function bound() {
    const key = getAccountKey() ?? null;
    if (key !== boundKey) {
      boundKey = key;
      ids = key ? loadIds(storage, kind, key) : new Set();
    }
    return ids;
  }
  function persist() {
    if (boundKey) saveIds(storage, kind, boundKey, ids);
  }
  return {
    has: (id) => bound().has(id),
    add(id) {
      bound().add(id);
      persist();
    },
    delete(id) {
      const removed = bound().delete(id);
      persist();
      return removed;
    },
    values: () => [...bound()],
    get size() {
      return bound().size;
    },
  };
}
