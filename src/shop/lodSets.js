// #4115 (part of #4062, #4063): which placed items are one set when level of detail is decided, shared by
// Shop (src/shop/presenceAndContent.js) and Build (src/build/lod.js) so there is one copy of the rule
// ("One model, not a hybrid"). A set is a placed bundle (the items sharing a groupId) or loose items that
// stand together (the same product, touching or a small gap apart: src/shop/implicitLodSets.js). Items of
// a set change version as one, so no edge runs through a wall. Nothing here is stored or shown: the
// grouping reaches no selection, no undo entry and no saved layout, only the version each item is drawn in.
//
// Pure of any scene: the caller says how to read an item (does it have versions, its bundle, its product,
// where it stands in one common space, how big it is). Sets the item list no longer matches are simply
// found again by the next call.
import { findImplicitSetsSteps, STEP_CHUNK } from './implicitLodSets.js';
import { setBoundingSphere } from './lodTier.js';

// objects: the placed items. Reads, per item: hasTiers(item) (items without versions are left out and
// keep whatever set id they had), groupIdOf(item), templateKeyOf(item), positionOf(item) -> { x, y, z }
// (read at once, so a shared scratch object may be returned), radiusOf(item) in metres.
// Returns Map<setId, { members, sphere, maxMemberRadiusM, px, near }> and writes `userData.lodSetId` on
// every member (undefined on an item that is not in a set). A bundle of one is not a set (it is decided
// as a single item); loose sets are `auto:<n>`, a bundle's id is its groupId.
export function buildLodSets(objects, options) {
  const steps = buildLodSetsSteps(objects, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

// #4189: a job to work the sets out in slices (a frame's budget at a time) so a big lándlet's discovery never
// takes a whole frame ("Moving, looking and drawing never wait on loading"). The items are snapshotted when
// the job starts; nothing is written to any item until the whole job is done, so the sets in use stay the
// previous ones until the new ones are complete and then change at once. A caller drops a job whose layout
// changed and starts another. Drained to the end it gives exactly what buildLodSets gives.
export function startLodSetsJob(objects, options) {
  const snapshot = objects.slice();
  return { steps: buildLodSetsSteps(snapshot, options), done: false, failed: false, sets: null, small: snapshot.length <= SMALL_JOB_ITEMS };
}

// Runs the job until `budgetMs` has passed, but always at least MIN_CHUNKS chunks (a chunk is about 256
// items of one loop, a fraction of a millisecond) so a slow or loaded machine still finishes in a bounded
// number of ticks rather than never. Returns the sets once complete, else null.
export const MIN_CHUNKS = 4;
// A job this small costs about a millisecond whole, so it is finished in one step: no wait, and no dependence
// on the clock, for the ordinary lándlet.
export const SMALL_JOB_ITEMS = 500;
// A reading that throws (positionOf, radiusOf, ...) ends the job with no sets and `job.failed` set, with one
// console.error: the callers carry on with every item judged alone, as before sets existed, and do not retry
// until the layout changes. It never throws and never leaves a job that steps forever.
export function stepLodSetsJob(job, budgetMs, now = () => performance.now()) {
  if (job.done) return job.sets;
  const start = now();
  let chunks = 0;
  try {
    do {
      const next = job.steps.next();
      chunks += 1;
      if (next.done) {
        job.done = true;
        job.sets = next.value;
        return job.sets;
      }
    } while (job.small || chunks < MIN_CHUNKS || now() - start < budgetMs);
  } catch (error) {
    job.done = true;
    job.failed = true;
    job.sets = new Map();
    console.error('#4189: set discovery failed; items are judged one by one until the layout changes', error);
    return job.sets;
  }
  return null;
}

function* buildLodSetsSteps(objects, { hasTiers, groupIdOf, templateKeyOf, positionOf, radiusOf, implicit = true }) {
  const byGroup = new Map();
  const loose = [];
  const withTiers = [];
  for (let n = 0; n < objects.length; n++) {
    const object = objects[n];
    if (n % STEP_CHUNK === STEP_CHUNK - 1) yield;
    if (!hasTiers(object)) continue;
    withTiers.push(object);
    const groupId = groupIdOf(object);
    if (!groupId) { loose.push(object); continue; }
    let members = byGroup.get(groupId);
    if (!members) byGroup.set(groupId, members = []);
    members.push(object);
  }
  const sets = new Map();
  const planned = []; // [setId, members], written to the items only when the job is complete
  // Read in chunks (a set of thousands is not one step); #4089: also the biggest member, for a set too costly
  // to be judged whole (setApparentPx).
  const addSet = function* (setId, members) {
    const spheres = [];
    let maxMemberRadiusM = 0;
    for (let n = 0; n < members.length; n++) {
      if (n % STEP_CHUNK === STEP_CHUNK - 1) yield;
      const position = positionOf(members[n]);
      const radiusM = radiusOf(members[n]);
      spheres.push({ x: position.x, y: position.y, z: position.z, radiusM });
      if (radiusM > maxMemberRadiusM) maxMemberRadiusM = radiusM;
    }
    const sphere = setBoundingSphere(spheres);
    planned.push([setId, members]);
    sets.set(setId, { members, sphere, maxMemberRadiusM, px: 0, near: false });
  };
  for (const [groupId, members] of byGroup) {
    if (members.length < 2) continue; // a lone member is decided as a single item
    yield* addSet(groupId, members);
    yield;
  }
  // #4063: loose placements that stand together are a set for drawing too, so a wall the builder never
  // bundled changes detail as one, exactly as the same wall bundled does.
  const looseItems = [];
  const looseObjects = [];
  for (let n = 0; n < loose.length; n++) {
    const object = loose[n];
    if (n % STEP_CHUNK === STEP_CHUNK - 1) yield;
    const key = templateKeyOf(object);
    if (!key) continue;
    const position = positionOf(object);
    looseObjects.push(object);
    looseItems.push({ key, x: position.x, y: position.y, z: position.z, radiusM: radiusOf(object) });
  }
  const found = implicit ? yield* findImplicitSetsSteps(looseItems) : [];
  for (let n = 0; n < found.length; n++) {
    yield* addSet(`auto:${n}`, found[n].map((i) => looseObjects[i]));
    yield;
  }
  // Complete: only now do the items learn their set (an item in no set has none), in chunks like the rest.
  // lodSetsSeen: this item was looked at by a finished job, so its first version is judged with its set and
  // not alone (Shop holds an item's version until then: a change of version is never seen).
  for (let n = 0; n < withTiers.length; n++) {
    if (n % STEP_CHUNK === STEP_CHUNK - 1) yield;
    withTiers[n].userData.lodSetId = undefined;
    withTiers[n].userData.lodSetsSeen = true;
  }
  let written = 0;
  for (const [setId, members] of planned) {
    for (const object of members) {
      object.userData.lodSetId = setId;
      if (++written % STEP_CHUNK === 0) yield;
    }
  }
  return sets;
}

// #4189: an item no finished job has looked at keeps the version it has (judged alone it would take a different
// version from the set it is about to join, and the change would be seen). A failed job releases the hold.
export function isHeldForSets(object, failed = false) {
  return object.userData.lodSetsSeen !== true && !failed;
}
