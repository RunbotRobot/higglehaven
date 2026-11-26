// #4391 (leaf 1): what a change of a lándlet's live version means for a shopper who already has it loaded.
// Instances keep their id from the builder's draft into every version snapshot (version_instances.source_instance_id),
// so the two lists are matched by id: an id in both with nothing different is untouched; an id only in the old
// list leaves; an id only in the new list arrives; an id in both with anything different is the old one leaving
// and the new one arriving (the same two things as any other swap). Pure, no three.js.

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export function instanceIdOf(instance) {
  return instance?.instanceId ?? instance?.id;
}

// True when nothing a shopper could see or touch differs between the two records of one instance.
export function sameInstance(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'id' || key === 'instanceId') continue;
    if (!sameValue(a[key], b[key])) return false;
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
