// #4391 (leaf 1): what a change of a lándlet's live version means for a shopper who already has it loaded.
// Instances keep their id from the builder's draft into every version snapshot (version_instances.source_instance_id),
// so the two lists are matched by id: an id in both with nothing different is untouched; an id only in the old
// list leaves; an id only in the new list arrives; an id in both with anything different is the old one leaving
// and the new one arriving (the same two things as any other swap). Pure, no three.js.

// Field by field, without serialising (this runs for every instance of a lándlet in one tick): numbers, strings and
// booleans by value, and the small objects an instance carries (a crop) key by key.
function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

export function instanceIdOf(instance) {
  return instance?.instanceId ?? instance?.id;
}

// The fields of an instance that a shopper can see or touch. A fixed list, not "every key": a draft's instances
// carry landletId, createdAt and updatedAt that a version's do not (worker/index.js, instanceFromRow and
// versionInstanceFromRow), so comparing every key called every item changed on the first publish of a lándlet.
const VISIBLE_FIELDS = [
  'templateId', 'x', 'y', 'z', 'rotationX', 'rotationY', 'rotationZ', 'scale', 'crop', 'label',
  'groupId', 'bundleId', 'isCommunitySign', 'isCommunityCalendar',
];

// An absent crop is an empty crop, an absent flag is false, and null and missing are the same for the rest.
function normalized(instance, key) {
  const value = instance[key];
  if (key === 'crop') return value && typeof value === 'object' ? value : {};
  if (key === 'isCommunitySign' || key === 'isCommunityCalendar') return Boolean(value);
  return value ?? null;
}

// True when nothing a shopper could see or touch differs between the two records of one instance.
export function sameInstance(a, b) {
  for (const key of VISIBLE_FIELDS) {
    if (!sameValue(normalized(a, key), normalized(b, key))) return false;
  }
  return true;
}

// oldById: Map(instanceId -> instance) as drawn now; newInstances: the new version's list.
// Returns { removed: [ids], added: [instances], changed: [{ id, instance }], unchanged: n } where `changed`
// ids are also to be treated as leaving (old) and arriving (new instance).
export function diffVersionInstances(oldById, newInstances) {
  const removed = [];
  const added = [];
  const changed = [];
  let unchanged = 0;
  const seen = new Set();
  for (const instance of newInstances) {
    const id = instanceIdOf(instance);
    if (id === undefined || id === null) continue;
    seen.add(id);
    const before = oldById.get(id);
    if (!before) added.push(instance);
    else if (sameInstance(before, instance)) unchanged += 1;
    else changed.push({ id, instance });
  }
  for (const id of oldById.keys()) if (!seen.has(id)) removed.push(id);
  return { removed, added, changed, unchanged };
}

// What to do about a change of version, given the diff and the drawn objects (by instance id). Returns
// { plain: true } when the lándlet should load again plainly instead of fading piece by piece, otherwise
// { plain: false, leaving: [objects], arriving: [instances] }. Plain when the diff is too big to fade piece by piece,
// or when anything leaving is one of a drawn-together batch (its meshes and enclosure books are one thing), a
// community sign or a calendar (each has its own registration). An id with no drawn object (a model that failed)
// has nothing to fade and is skipped.
export function planVersionChange(diff, objectsById, maxChanges) {
  const leavingIds = new Set([...diff.removed, ...diff.changed.map((change) => change.id)]);
  const arriving = [...diff.added, ...diff.changed.map((change) => change.instance)];
  if (leavingIds.size + arriving.length > maxChanges) return { plain: true };
  const leaving = [];
  for (const id of leavingIds) {
    const object = objectsById.get(id);
    if (!object) continue;
    const data = object.userData ?? {};
    if (data.batch || data.isCommunitySign || data.isCommunityCalendar) return { plain: true };
    leaving.push(object);
  }
  return { plain: false, leaving, arriving };
}
