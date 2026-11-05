// #1318: nothing told the user when the browser took the WebGL context away
// (GPU reset, tab evicted under memory pressure on mobile, another tab claiming
// the GPU) -- the world just went blank with no hint that a reload fixes it.
//
// Three.js's own WebGLRenderer already registers webglcontextlost/restored
// listeners on its canvas: it calls preventDefault() (which is what keeps the
// context restorable) and re-initialises its GPU state on restore, re-uploading
// geometry/textures lazily as they are next drawn. So the gap is purely the
// missing user-facing notice, not the recovery itself. Per the #3157 re-triage
// ("No silent loss" + "Prefer an invisible fix over a new user-facing step"):
// first version shows a plain notice with a reload button only while the
// context is actually gone, and removes it by itself if the browser restores
// the context. Build drafts are already synced server-side, so a reload loses
// nothing. Short-lived preview renderers (catalog thumbnails, saved-layout /
// seller / product previews) are deliberately not watched: they rebuild on next
// open, and a notice for a preview would be noise.

export const GRAPHICS_INTERRUPTED_MESSAGE = 'Graphics were interrupted. If the screen stays blank, reload to get back in.';

// Pure wiring, kept separate from the DOM so it can be unit-tested with any
// EventTarget. Calling preventDefault here too is harmless (Three.js already
// does) and keeps this correct even if a renderer without that built-in
// handling is ever passed in.
export function watchContextLoss(target, { onLost, onRestored } = {}) {
  const handleLost = (event) => {
    event.preventDefault();
    onLost?.();
  };
  const handleRestored = () => onRestored?.();
  target.addEventListener('webglcontextlost', handleLost);
  target.addEventListener('webglcontextrestored', handleRestored);
  return () => {
    target.removeEventListener('webglcontextlost', handleLost);
    target.removeEventListener('webglcontextrestored', handleRestored);
  };
}

let noticeEl = null;

export function showGraphicsInterruptedNotice(doc = document) {
  if (noticeEl && noticeEl.isConnected) return noticeEl;
  const el = doc.createElement('div');
  el.id = 'graphics-interrupted-notice';
  el.setAttribute('role', 'alert');
  el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:10000;'
    + 'max-width:min(92vw,420px);box-sizing:border-box;padding:12px 14px;border-radius:10px;'
    + 'background:rgba(20,24,32,0.94);color:#fff;font:14px/1.4 system-ui,sans-serif;'
    + 'box-shadow:0 4px 18px rgba(0,0,0,0.4);display:flex;gap:12px;align-items:center;';
  const text = doc.createElement('span');
  text.textContent = GRAPHICS_INTERRUPTED_MESSAGE;
  const reload = doc.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = 'flex:none;padding:8px 14px;border:0;border-radius:8px;background:#fff;color:#111;'
    + 'font:inherit;font-weight:600;cursor:pointer;min-height:36px;';
  reload.addEventListener('click', () => window.location.reload());
  el.append(text, reload);
  doc.body.appendChild(el);
  noticeEl = el;
  return el;
}

export function hideGraphicsInterruptedNotice() {
  if (noticeEl) noticeEl.remove();
  noticeEl = null;
}

// The one long-lived renderer (the world canvas): notice while lost, gone again
// if the browser restores the context.
export function watchMainRendererContext(renderer) {
  return watchContextLoss(renderer.domElement, {
    onLost: () => showGraphicsInterruptedNotice(),
    onRestored: () => hideGraphicsInterruptedNotice(),
  });
}
