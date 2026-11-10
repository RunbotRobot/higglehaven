// #3372: the one definition of how high and low an item's centre may sit on a
// landlet, read by the Worker (which refuses a save outside it) and by the
// Build client (which stops a move at it). Keeping a single copy means the
// client can never accept a move the server will then refuse.
//
// Levels stack directly, each LEVEL_HEIGHT_M tall; the ground level (index 0)
// always exists. A centre may sit up to half a level past the outermost
// purchased level, so an item's own thickness can carry it slightly past a
// level boundary without forcing another level to be bought just to fit.
export const LEVEL_HEIGHT_M = 10;
export const HALF_LEVEL_HEIGHT_M = LEVEL_HEIGHT_M / 2;

export function landletLevelZRange(levelIndices) {
  return {
    minZ: Math.min(0, ...levelIndices) * LEVEL_HEIGHT_M - HALF_LEVEL_HEIGHT_M,
    maxZ: Math.max(0, ...levelIndices) * LEVEL_HEIGHT_M + HALF_LEVEL_HEIGHT_M,
  };
}
