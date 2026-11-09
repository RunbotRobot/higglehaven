// #3293 (leaf 2/6 of #3291, part of #3253): the world the Shop movement core
// moves through, behind one small adapter, so Sell mode's world view can later
// run the very same movement code against its own world (One model, not a
// hybrid: one movement system, one seam) instead of a second copy.
//
// This file is pure (no three.js, no DOM, no main.js) so the seam is
// unit-testable (src/shop/movementWorld.test.js). The movement core in
// src/shop/flightMovement.js registers Shop's world as the default at load and
// reads everything world-shaped through `movementWorld()`.
//
// The adapter is three small questions the core asks of a world:
//   forEachObstacle(visit)  calls visit(mesh, originX, originY, originZ) for
//                           every solid mesh the avatar can collide with or
//                           land on; originX/Y/Z is the world-space offset the
//                           mesh's own position is relative to (Shop: the
//                           loaded landlet group's position). Return true from
//                           visit to stop early. A visitor, not a generator,
//                           because the core asks this every frame and an
//                           allocation per obstacle per call would be GC churn
//                           on phones. Returns true if a visit stopped it.
//   groundHeightAt(x, y)    the real ground height at (x, y), regardless of
//                           claim status (Shop: shopTerrainHeightAtM).
//   worldRadiusM()          the boundary radius, or null when there is no
//                           boundary yet (every boundary clamp is then a no-op).

let activeWorld = null;

export function setMovementWorld(world) {
  activeWorld = world;
}

export function movementWorld() {
  if (!activeWorld) throw new Error('movementWorld(): no world registered');
  return activeWorld;
}

// Shop's own world, built from the live Shop state the caller hands in as
// getters (so every read sees the current value, never a snapshot).
export function createShopMovementWorld({ landlets, terrainHeightAt, worldRadiusM }) {
  return {
    forEachObstacle(visit) {
      for (const entry of landlets().values()) {
        if (!entry.loaded) continue;
        const { x, y, z } = entry.group.position;
        for (const mesh of entry.objects) {
          if (visit(mesh, x, y, z) === true) return true;
        }
      }
      return false;
    },
    groundHeightAt: (x, y) => terrainHeightAt(x, y),
    worldRadiusM: () => worldRadiusM(),
  };
}

// geometry = { meshDimensions, footprintCorners, footprintsOverlap,
// isFlooring } -- the collision primitives (they live in build/scene.js and
// world/models.js, which pull in three.js), injected so this stays pure.

// Is the avatar's footprint (avatarCorners, at height z, avatarHeightM tall)
// overlapping any solid obstacle of `world`? Flooring is a walkable surface,
// never an obstacle (#530). #1829: standing exactly on an obstacle's top
// (z >= itemZMax) is not overlap.
export function positionBlockedIn(world, geometry, avatarCorners, z, avatarHeightM) {
  const { meshDimensions, footprintCorners, footprintsOverlap, isFlooring } = geometry;
  return world.forEachObstacle((mesh, originX, originY, originZ) => {
    if (isFlooring(mesh.userData.template)) return false;
    const { height } = meshDimensions(mesh);
    // #2852: the origin's z carries the landlet's real terrain elevation, the
    // same way its x/y shift the footprint.
    const itemZMin = originZ + mesh.position.z - height / 2;
    const itemZMax = originZ + mesh.position.z + height / 2;
    if (z + avatarHeightM < itemZMin || z >= itemZMax) return false;
    return footprintsOverlap(avatarCorners, footprintCorners(mesh, originX + mesh.position.x, originY + mesh.position.y));
  });
}

// #1090: the highest top surface of any non-flooring obstacle under the
// avatar's footprint, ignoring the avatar's own z (a straight-down landing's
// floor); null when there is none.
export function landingObstructionTopZIn(world, geometry, avatarCorners) {
  const { meshDimensions, footprintCorners, footprintsOverlap, isFlooring } = geometry;
  let topZ = null;
  world.forEachObstacle((mesh, originX, originY, originZ) => {
    if (isFlooring(mesh.userData.template)) return false;
    if (!footprintsOverlap(avatarCorners, footprintCorners(mesh, originX + mesh.position.x, originY + mesh.position.y))) return false;
    const { height } = meshDimensions(mesh);
    const itemZMax = originZ + mesh.position.z + height / 2;
    if (topZ === null || itemZMax > topZ) topZ = itemZMax;
    return false;
  });
  return topZ;
}

// Pulls `position` (x, y) radially back inside maxRadius, in place; a no-op
// while the world has no boundary yet.
export function clampRadiusIn(world, position, maxRadius) {
  if (world.worldRadiusM() === null) return;
  const distance = Math.hypot(position.x, position.y);
  if (distance > maxRadius) {
    const scale = maxRadius / distance;
    position.x *= scale;
    position.y *= scale;
  }
}
