// Client-side-only persistence for which products are placed on the landlet
// and where. There's no backend/database yet, so this is localStorage for
// now — good enough to prove out the interaction, not meant to survive a
// device change or count as the real data layer.
//
// Storage key bumped from the old "layout" (a position-overrides map keyed
// by a fixed product id) to "instances" (a full list of placed items, since
// builders can now add/remove them, not just move a fixed set of two).
// Old-shaped data under the previous key is simply never read — cleaner
// than trying to detect and migrate a shape that meant something different
// anyway (no per-instance ids existed to migrate to).
const STORAGE_KEY = 'higglehaven.landlet.instances';

export function loadInstances() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveInstances(instances) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(instances));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — layout just
    // won't persist this session.
  }
}
