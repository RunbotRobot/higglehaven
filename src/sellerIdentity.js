// A genuinely separate identity namespace from builders (see
// builderIdentity.js) — which seller roster entry (see worker/index.js's
// /api/sellers) this device currently sells as. No legacy migration to do
// here the way builderIdentity.js has: sellers didn't exist as a local-only
// concept before the shared roster did.
const ACTIVE_ID_KEY = 'higglehaven.activeSellerId';

export function getActiveSellerId() {
  return localStorage.getItem(ACTIVE_ID_KEY);
}

export function setActiveSellerId(id) {
  localStorage.setItem(ACTIVE_ID_KEY, id);
}
