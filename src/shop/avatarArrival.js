// #4108 (part of #4067): the fog an avatar arrives through, shared by every mode that mounts the
// person's own avatar (Shop and Sell's showroom, "One way to move through the world"). It hands
// mountShopAvatar the swap/hold dependencies and keeps the one active fog, which the mode steps
// from its own frame update. Shop wrote this inline before; Sell had none, so the default body
// showed and popped to the worn one in a single frame.
import { beginAvatarSwapFog, beginAvatarFogHold } from './avatarSwapFog.js';
import { createArrivalFog } from './arrivalEffect.js';

export function createAvatarArrival({
  getScene, getPosition, getUserId, reducedMotion = defaultReducedMotion,
  beginSwap = beginAvatarSwapFog, beginHold = beginAvatarFogHold, makeFog = createArrivalFog,
  now = () => performance.now(), storage = defaultStorage,
}) {
  let active = null;
  const wornKey = () => `hh-worn-avatar:${getUserId() ?? ''}`;
  return {
    deps: {
      // #3905: the equipped avatar replaces the default body inside a puff of fog, not as a pop.
      beginAvatarSwap: (commit) => {
        active?.cancel();
        const swap = beginSwap({ createFog: makeFog, parent: getScene(), getPosition, commit, nowMs: now(), reducedMotion: reducedMotion() });
        active = swap.released ? null : swap;
        return swap;
      },
      cancelAvatarSwap: () => { active?.cancel(); active = null; },
      // #4067: someone who may wear a model of their own is shown fog, not the default body, until it is known.
      beginAvatarFogHold: () => {
        active?.cancel();
        const hold = beginHold({ createFog: makeFog, parent: getScene(), getPosition, nowMs: now(), reducedMotion: reducedMotion() });
        active = hold.released ? null : hold;
        return hold;
      },
      readWornHint: () => { try { return storage().getItem(wornKey()); } catch { return null; } },
      writeWornHint: (kind) => {
        try { if (getUserId()) storage().setItem(wornKey(), kind); } catch { /* remembered only when allowed */ }
      },
    },
    // Call from the mode's per-frame update.
    step: (t) => { if (active?.step(t)) active = null; },
    cancel: () => { active?.cancel(); active = null; },
  };
}

function defaultReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function defaultStorage() { return localStorage; }
