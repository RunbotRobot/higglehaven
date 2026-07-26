// Client-side-only persistence for where products have been dragged to.
// There's no backend/database yet, so this is localStorage for now —
// good enough to prove out the interaction, not meant to survive a
// device change or count as the real data layer.
const STORAGE_KEY = 'higglehaven.landlet.layout';

export function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveLayout(positionsById) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positionsById));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) — layout just
    // won't persist this session.
  }
}
