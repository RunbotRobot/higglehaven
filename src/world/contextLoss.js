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
// context is actually gone (#3889: now a word beside the flower's head that opens to the
// sentence and the Reload button, not a bar standing on the world), and removes it by itself if the browser restores
// the context. Build drafts are already synced server-side, so a reload loses
// nothing. Short-lived preview renderers (catalog thumbnails, saved-layout /
// seller / product previews) are deliberately not watched: they rebuild on next
// open, and a notice for a preview would be noise.

import { sayAtHead, clearSaying } from '../ui/headSaying.js';

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

export function showGraphicsInterruptedNotice() {
  sayAtHead('graphics', {
    word: 'Graphics paused',
    title: 'Graphics were interrupted',
    message: GRAPHICS_INTERRUPTED_MESSAGE,
    label: 'Graphics were interrupted. Open for what to do.',
    action: { label: 'Reload', run: () => window.location.reload() },
  });
}

export function hideGraphicsInterruptedNotice() {
  clearSaying('graphics');
}

// The one long-lived renderer (the world canvas): notice while lost, gone again
// if the browser restores the context.
export function watchMainRendererContext(renderer) {
  return watchContextLoss(renderer.domElement, {
    onLost: () => showGraphicsInterruptedNotice(),
    onRestored: () => hideGraphicsInterruptedNotice(),
  });
}
