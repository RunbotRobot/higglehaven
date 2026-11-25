// #4296 (from the #4277 audit): a sign's posts and a calendar's events were
// fetched once as the item entered the world, and a failed request left them
// empty for as long as the lándlet stayed loaded -- an empty sign reads as
// "nobody has written here", which is wrong. This asks again after a short,
// growing wait, only while the item is still in the scene, and stops after a
// few tries.
export const SCENE_LOAD_RETRY_DELAYS_MS = [2000, 6000, 15000];

export function loadWhileInScene({ fetch, isInScene, onResult, delays = SCENE_LOAD_RETRY_DELAYS_MS, setTimer = setTimeout }) {
  const attempt = (n) => {
    Promise.resolve()
      .then(fetch)
      .then((result) => {
        // A failure while drawing the result is not a failed request: do not ask again for it.
        if (isInScene()) { try { onResult(result); } catch { /* drawing failed; the data is not the problem */ } }
      }, () => {
        if (n >= delays.length || !isInScene()) return;
        setTimer(() => {
          if (isInScene()) attempt(n + 1);
        }, delays[n]);
      });
  };
  attempt(0);
}
