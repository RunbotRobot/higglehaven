// #3763 (part of #3759, #3738): what the opening screen remembers about tips, on
// this device only (localStorage). Every read and write is guarded, because the
// opening screen must work with storage blocked; if it is, the tips just start
// from the first one and stay on.
//
// The switch is "Show tips while the app opens" in Settings, on by default. The
// owner assumes almost nobody touches it, so the default behaviour is right
// without it (one tip per load, held long enough to read). Per-account sync is a
// follow-up that needs a column on the account; until then it is per device.
export const TIPS_OFF_KEY = 'higglehaven.loadingTips.off';
export const TIPS_NEXT_KEY = 'higglehaven.loadingTips.next';

function defaultStorage() {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadingTipsEnabled(storage = defaultStorage()) {
  try { return !storage || storage.getItem(TIPS_OFF_KEY) !== '1'; } catch { return true; }
}

export function setLoadingTipsEnabled(on, storage = defaultStorage()) {
  try {
    if (!storage) return;
    if (on) storage.removeItem(TIPS_OFF_KEY); else storage.setItem(TIPS_OFF_KEY, '1');
  } catch { /* the switch just does not stick on this device */ }
}

// Which tip to show next. With nothing stored (the very first open on this
// device) it is the first tip, which is the one about moving; after that the
// tips take turns, so a person who opens often does not read the same one every
// time.
export function nextTipIndex(count, storage = defaultStorage()) {
  try {
    const stored = Number.parseInt(storage ? storage.getItem(TIPS_NEXT_KEY) : '', 10);
    return Number.isInteger(stored) && stored >= 0 ? stored % count : 0;
  } catch { return 0; }
}

export function rememberTipShown(index, count, storage = defaultStorage()) {
  try { if (storage) storage.setItem(TIPS_NEXT_KEY, String((index + 1) % count)); } catch { /* it starts from the first again */ }
}
