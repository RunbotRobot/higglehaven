// #3262 (owner decision, 2026-11-08): what a builder sees on their lándlet is
// what a shopper sees. Shop mode used to give only unclaimed greenbelt plots
// the textured ground and drew claimed plots as a flat tan "ownership status"
// fill (#220/#2371), so a claimed lándlet looked nothing like it does in Build
// mode. Now a claimed plot uses the same biome ground texture
// (createGroundTexture(record.biome), the call Build mode makes too). Only
// plots nobody can have built on keep a status colour: 'generating' (still
// being made) and 'water' (cannot be owned).
//
// Pure and dependency-free so it can be unit tested without three.js.
const TEXTURED_PLOT_KEYS = new Set(['greenbelt', 'claimed']);

// plotColorKey: the result of plotColorKeyForLandlet(record).
export function shopGroundUsesBiomeTexture(plotColorKey) {
  return TEXTURED_PLOT_KEYS.has(plotColorKey);
}
