// A builder's identity is just a random ID persisted in localStorage — there
// is no auth system yet (see docs/API.md's "Future auth should not be
// inferred from this API" note). This only has to be stable enough for the
// backend's one-claimed-landlet-per-builder rule to recognize "the same
// builder" across visits on the same device/browser; it doesn't need to
// survive a device change or count as a real account.
//
// Multiple identities are kept as a list so one browser can "log in" as
// several imaginary builders (e.g. to claim more than one landlet for
// testing) and switch between them. Each entry's `id` is the value actually
// sent to the API as ownerBuilderId/builderId — renaming an identity must
// never change it, or it would orphan whatever that ID already owns
// server-side. `label` is purely local display text.
const IDENTITIES_KEY = 'higglehaven.identities';
const ACTIVE_ID_KEY = 'higglehaven.activeBuilderId';
const LEGACY_BUILDER_ID_KEY = 'higglehaven.builderId'; // pre-multi-identity single-ID scheme

function readIdentities() {
  const raw = localStorage.getItem(IDENTITIES_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to migration/empty below
    }
  }

  const legacyId = localStorage.getItem(LEGACY_BUILDER_ID_KEY);
  if (legacyId) {
    const migrated = [{ id: legacyId, label: 'Builder 1' }];
    writeIdentities(migrated);
    localStorage.setItem(ACTIVE_ID_KEY, legacyId);
    localStorage.removeItem(LEGACY_BUILDER_ID_KEY);
    return migrated;
  }

  return [];
}

function writeIdentities(identities) {
  localStorage.setItem(IDENTITIES_KEY, JSON.stringify(identities));
}

// Always returns at least one identity, creating a first one on a genuinely
// fresh browser — callers that just need "a list to show" never have to
// special-case the empty state.
export function listIdentities() {
  const identities = readIdentities();
  if (identities.length > 0) return identities;
  const created = { id: `builder-${crypto.randomUUID()}`, label: 'Builder 1' };
  writeIdentities([created]);
  return [created];
}

export function getActiveBuilderId() {
  return localStorage.getItem(ACTIVE_ID_KEY);
}

export function setActiveBuilderId(id) {
  localStorage.setItem(ACTIVE_ID_KEY, id);
}

export function createIdentity() {
  const identities = listIdentities();
  const identity = { id: `builder-${crypto.randomUUID()}`, label: `Builder ${identities.length + 1}` };
  writeIdentities([...identities, identity]);
  return identity;
}

export function renameIdentity(id, label) {
  const identities = listIdentities();
  const entry = identities.find((identity) => identity.id === id);
  if (!entry) return;
  entry.label = label;
  writeIdentities(identities);
}

// Only removes the local identity — whatever it already claimed/placed
// server-side is unaffected and stays under that now-orphaned ID forever
// (there's no unclaim flow). That's the point for "test from a clean
// slate": the next listIdentities() call self-heals back to at least one
// identity if this empties the list.
export function deleteIdentity(id) {
  writeIdentities(listIdentities().filter((identity) => identity.id !== id));
  if (getActiveBuilderId() === id) localStorage.removeItem(ACTIVE_ID_KEY);
}
