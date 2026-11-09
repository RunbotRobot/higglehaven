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
//   boundsCamera            OPTIONAL. false = the follow camera is not clamped to
//                           the boundary (only the avatar is). Default true.
//   clampToBoundary(position, clearanceM)   OPTIONAL. A world whose edge is not
//                           a circle (#3295: Sell's rectangular showcase ground)
//                           supplies this to pull (x, y) back inside its own
//                           edge, `clearanceM` in from it, in place. Without
//                           it the boundary is the circle worldRadiusM() names
//                           (Shop's).

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
export function clampRadiusIn(world, position, maxRadius, isCamera = false) {
  const worldRadiusM = world.worldRadiusM();
  if (worldRadiusM === null) return;
  // #3295: a world can leave the follow camera unbounded (`boundsCamera:
  // false`): the camera trails the avatar by several metres and may sit
  // outside the walkable ground, which only the avatar must stay inside.
  if (isCamera && world.boundsCamera === false) return;
  // #3295: callers pass the radius they want, already net of their own
  // clearance from the edge (worldRadius - clearance), so the clearance a
  // non-circular world needs is the difference.
  if (world.clampToBoundary) {
    world.clampToBoundary(position, Math.max(0, worldRadiusM - maxRadius));
    return;
  }
  const distance = Math.hypot(position.x, position.y);
  if (distance > maxRadius) {
    const scale = maxRadius / distance;
    position.x *= scale;
    position.y *= scale;
  }
}

// #3295 (leaf 4/6 of #3291, part of #3253): Sell mode's world for the same
// movement core. The walkable area is the showcase page's own rectangular
// ground, the obstacles are the page's product meshes (at the scene origin,
// not inside a landlet group), and the ground is flat. `showcaseMeshes()` and
// `groundBounds()` are getters so every read sees the current page:
// groundBounds() is { minX, maxX, minY, maxY } or null before a page exists.
export function createSellMovementWorld({ showcaseMeshes, groundBounds }) {
  return {
    forEachObstacle(visit) {
      for (const mesh of showcaseMeshes()) {
        if (visit(mesh, 0, 0, 0) === true) return true;
      }
      return false;
    },
    groundHeightAt: () => 0,
    boundsCamera: false,
    // The circle through the ground's corners: only used where the core needs
    // *a* radius (it is never the actual edge, clampToBoundary is).
    worldRadiusM() {
      const b = groundBounds();
      if (!b) return null;
      return Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2;
    },
    clampToBoundary(position, clearanceM) {
      const b = groundBounds();
      if (!b) return;
      // A ground narrower than twice the clearance still keeps the avatar on
      // it: the clamp range collapses to the ground's centre line.
      const clampAxis = (value, min, max) => {
        const lo = min + clearanceM;
        const hi = max - clearanceM;
        if (lo > hi) return (min + max) / 2;
        return Math.min(hi, Math.max(lo, value));
      };
      position.x = clampAxis(position.x, b.minX, b.maxX);
      position.y = clampAxis(position.y, b.minY, b.maxY);
    },
  };
}
