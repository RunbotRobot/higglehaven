// #4295 (from the #4277 audit): Shop asks for the catalog once as it opens. When that one request failed, the
// built-in sample catalog stood in for the rest of the session: no real product had a template, so every placement
// on every lándlet "never arrived" and the world stayed empty, with nothing asking again. This asks again in the
// background after a growing wait, and hands the catalog over the moment one arrives. Dependency-free (the fetch,
// the timer and the hand-over are passed in) so it runs in the plain vitest pool.

export const CATALOG_RETRY_DELAYS_MS = [3000, 8000, 20000, 45000, 90000];

export function retryCatalogLater({ fetchCatalog, onCatalog, schedule = setTimeout, clear = clearTimeout, delays = CATALOG_RETRY_DELAYS_MS }) {
  let attempt = 0;
  let timer = null;
  let stopped = false;
  function arm() {
    if (stopped || attempt >= delays.length) return;
    timer = schedule(run, delays[attempt]);
  }
  async function run() {
    timer = null;
    attempt += 1;
    try {
      const catalog = await fetchCatalog();
      if (stopped) return;
      stopped = true;
      onCatalog(catalog);
    } catch {
      arm();
    }
  }
  arm();
  return { cancel() { stopped = true; if (timer !== null) clear(timer); timer = null; }, attempts: () => attempt };
}
