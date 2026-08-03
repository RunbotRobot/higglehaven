// A builder's identity is just a random ID persisted in localStorage — there
// is no auth system yet (see docs/API.md's "Future auth should not be
// inferred from this API" note). This only has to be stable enough for the
// backend's one-claimed-landlet-per-builder rule to recognize "the same
// builder" across visits on the same device/browser; it doesn't need to
// survive a device change or count as a real account.
const BUILDER_ID_KEY = 'higglehaven.builderId';

export function getOrCreateBuilderId() {
  let id = localStorage.getItem(BUILDER_ID_KEY);
  if (!id) {
    id = `builder-${crypto.randomUUID()}`;
    localStorage.setItem(BUILDER_ID_KEY, id);
  }
  return id;
}
