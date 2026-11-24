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
import { findImplicitSets } from './implicitLodSets.js';
import { setBoundingSphere } from './lodTier.js';

// objects: the placed items. Reads, per item: hasTiers(item) (items without versions are left out and
// keep whatever set id they had), groupIdOf(item), templateKeyOf(item), positionOf(item) -> { x, y, z }
// (read at once, so a shared scratch object may be returned), radiusOf(item) in metres.
// Returns Map<setId, { members, sphere, maxMemberRadiusM, px, near }> and writes `userData.lodSetId` on
// every member (undefined on an item that is not in a set). A bundle of one is not a set (it is decided
// as a single item); loose sets are `auto:<n>`, a bundle's id is its groupId.
export function buildLodSets(objects, { hasTiers, groupIdOf, templateKeyOf, positionOf, radiusOf, implicit = true }) {
  const byGroup = new Map();
  const loose = [];
  for (const object of objects) {
    if (!hasTiers(object)) continue;
    object.userData.lodSetId = undefined;
    const groupId = groupIdOf(object);
    if (!groupId) { loose.push(object); continue; }
    let members = byGroup.get(groupId);
    if (!members) byGroup.set(groupId, members = []);
    members.push(object);
  }
  const sets = new Map();
  const addSet = (setId, members) => {
    const sphere = setBoundingSphere(members.map((object) => {
      const position = positionOf(object);
      return { x: position.x, y: position.y, z: position.z, radiusM: radiusOf(object) };
    }));
    for (const object of members) object.userData.lodSetId = setId;
    // #4089: the biggest member, for a set too costly to be judged whole (setApparentPx).
    let maxMemberRadiusM = 0;
    for (const object of members) maxMemberRadiusM = Math.max(maxMemberRadiusM, radiusOf(object));
    sets.set(setId, { members, sphere, maxMemberRadiusM, px: 0, near: false });
  };
  for (const [groupId, members] of byGroup) {
    if (members.length < 2) continue; // a lone member is decided as a single item
    addSet(groupId, members);
  }
  // #4063: loose placements that stand together are a set for drawing too, so a wall the builder never
  // bundled changes detail as one, exactly as the same wall bundled does.
  const looseItems = [];
  const looseObjects = [];
  for (const object of loose) {
    const key = templateKeyOf(object);
    if (!key) continue;
    const position = positionOf(object);
    looseObjects.push(object);
    looseItems.push({ key, x: position.x, y: position.y, z: position.z, radiusM: radiusOf(object) });
  }
  (implicit ? findImplicitSets(looseItems) : []).forEach((indices, n) => addSet(`auto:${n}`, indices.map((i) => looseObjects[i])));
  return sets;
}
