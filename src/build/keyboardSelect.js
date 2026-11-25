// #4160 (part of #4158, Build from a keyboard 2/5): N steps through the placed items and selects each one, Shift+N goes
// back, Escape lets go. The same idea as N in Shop (src/shop/keyboardInput.js), for someone who cannot tap an item in
// the world. Pure helpers only: the scene (scene.js) owns the selection and the camera.

// One stop per thing a person would call an item: a bundle is one stop (its first member stands for it), a loose item
// is its own. Order is the order the items were loaded, so it is the same every time.
export function selectionStops(meshes) {
  const seen = new Set();
  const stops = [];
  for (const mesh of meshes) {
    if (mesh.visible === false) continue;
    const key = mesh.userData.groupId ?? mesh.userData.instanceId ?? mesh.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    stops.push({ key, mesh });
  }
  return stops;
}

// The stop after (or, backwards, before) the current selection, wrapping round. Nothing selected starts at the first
// stop going forward and the last going back. `selectedKeys` is the set of stop keys the selection now covers.
export function stepIndex(stops, selectedKeys, backwards) {
  if (stops.length === 0) return -1;
  let current = -1;
  for (let i = 0; i < stops.length; i += 1) {
    if (selectedKeys.has(stops[i].key)) { current = i; break; }
  }
  if (current === -1) return backwards ? stops.length - 1 : 0;
  const step = backwards ? -1 : 1;
  return (current + step + stops.length) % stops.length;
}

// What the live region says: the item's name and where it stands in the walk, in a person's terms.
export function announceStop(name, index, count, { bundle = false } = {}) {
  const what = bundle ? `${name}, a bundle` : name;
  return `${what}, ${index + 1} of ${count}`;
}

function isTyping(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target;
  if (target) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
    if (typeof target.closest === 'function' && target.closest('[role="dialog"]')) return true;
  }
  return false;
}

// N (Shift+N back). Not held, and never while someone is typing or answering a dialog.
export function isStepKeyEvent(event) {
  return event.code === 'KeyN' && !event.repeat && !isTyping(event);
}
// Escape lets go of the selection, but only when nothing else is using the key (a dialog closes itself).
export function isDeselectKeyEvent(event) {
  return event.key === 'Escape' && !event.defaultPrevented && !isTyping(event);
}
