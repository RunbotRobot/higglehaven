// #3873 (part of #3539): a mode switch reloads the page, and the reload used to put the cold-open screen
// back up (the bud, the wordmark, a plain wash) for a person who is already in the world. Instead the
// world they were looking at is drawn small into an image at the moment of the tap, kept in
// sessionStorage across the reload, and shown behind a pale fog veil on the loading screen by
// public/bud-switch.js, before any other script has run. The lit petal and the bar are the signs of work;
// the world stays on screen until the new mode is ready.
//
// A quarter-size image is enough: it is shown stretched over the screen and veiled in fog, so it reads as a
// soft memory of the place, not a picture to inspect. Drawing the canvas straight after a render, in the
// same task, is the one time its buffer can be read (the page is not told to keep it).

export const SNAPSHOT_KEY = 'higglehaven.switchSnapshot';
export const SNAPSHOT_WIDTH_PX = 240;
export const SNAPSHOT_QUALITY = 0.6;
// Same freshness as the switch record it travels with (src/ui/bud.js).
export const SNAPSHOT_FRESH_MS = 60000;

// Pure: the size to draw the snapshot at, from the canvas's own size. Keeps the aspect, never zero.
export function snapshotSize(canvasWidth, canvasHeight, width = SNAPSHOT_WIDTH_PX) {
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) return null;
  return { width, height: Math.max(1, Math.round((width * canvasHeight) / canvasWidth)) };
}

// Pure: the stored record for an image taken at `now`, and whether a stored record can still be used.
export function snapshotRecord(url, now) { return { url, at: now }; }
export function snapshotUsable(record, now) {
  return !!record && typeof record.url === 'string' && record.url.startsWith('data:image/') && now - Number(record.at) <= SNAPSHOT_FRESH_MS;
}

// Draws the world now and stores it. `renderNow` draws a fresh frame first (the canvas can only be read
// straight after a render). Never throws: a missing snapshot only means the screen is the cold-open one.
export function captureSwitchSnapshot(canvas, renderNow, storage = typeof sessionStorage === 'undefined' ? null : sessionStorage, now = Date.now()) {
  try {
    if (!canvas || !storage) return false;
    const size = snapshotSize(canvas.width, canvas.height);
    if (!size) return false;
    if (typeof renderNow === 'function') renderNow();
    const small = document.createElement('canvas');
    small.width = size.width;
    small.height = size.height;
    small.getContext('2d').drawImage(canvas, 0, 0, size.width, size.height);
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshotRecord(small.toDataURL('image/jpeg', SNAPSHOT_QUALITY), now)));
    return true;
  } catch {
    return false;
  }
}

export function clearSwitchSnapshot(storage = typeof sessionStorage === 'undefined' ? null : sessionStorage) {
  try { storage?.removeItem(SNAPSHOT_KEY); } catch { /* nothing to clear */ }
}
