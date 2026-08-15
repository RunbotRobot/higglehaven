// The roster of builder identities itself now lives server-side (see
// worker/index.js's /api/builders and docs/API.md's "Builders" section) so
// switching devices sees the same list. There's still no auth — no
// password proves you're "you" — so this module's only remaining local
// state is which of those shared identities *this device* currently has
// active, plus a one-time migration path for identities/an active choice
// that predate the shared roster.
const ACTIVE_ID_KEY = 'higglehaven.activeBuilderId';
const LEGACY_IDENTITIES_KEY = 'higglehaven.identities'; // pre-shared-roster local list
const LEGACY_BUILDER_ID_KEY = 'higglehaven.builderId'; // pre-multi-identity single-ID scheme, older still

export function getActiveBuilderId() {
  return localStorage.getItem(ACTIVE_ID_KEY);
}

export function setActiveBuilderId(id) {
  localStorage.setItem(ACTIVE_ID_KEY, id);
}

// Identities created back when the list was purely local never made it to
// the server on their own — call this once at startup (main.js's
// bootstrap) and POST each one up with its exact existing ID preserved, so
// a device that already claimed a landlet under one of these doesn't lose
// track of it now that the roster is shared. Safe to call on every load:
// once migrated, the legacy keys are gone, so this is a no-op after the
// first run on a given device.
export function takeLegacyIdentities() {
  const identities = [];

  const raw = localStorage.getItem(LEGACY_IDENTITIES_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry.id === 'string' && typeof entry.label === 'string') identities.push(entry);
        }
      }
    } catch {
      // ignore malformed legacy data — nothing sensible to migrate
    }
  } else {
    const legacyId = localStorage.getItem(LEGACY_BUILDER_ID_KEY);
    if (legacyId) identities.push({ id: legacyId, label: 'Builder 1' });
  }

  localStorage.removeItem(LEGACY_IDENTITIES_KEY);
  localStorage.removeItem(LEGACY_BUILDER_ID_KEY);
  return identities;
}
