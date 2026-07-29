// Placeholder product data — no real product database exists yet.
// Dimensions in meters. Position (x, y) is the ground-plane location
// relative to the landlet's center (its coordinate origin, per spec §3);
// height off the ground is handled separately in main.js.
export const PRODUCTS = [
  {
    id: 'placeholder-crate-01',
    name: 'Placeholder Crate',
    dimensions: { width: 1, height: 1, depth: 1 },
    color: 0xd2691e,
    position: { x: 6, y: -4 },
  },
  {
    id: 'placeholder-planter-01',
    name: 'Placeholder Planter',
    dimensions: { width: 0.6, height: 0.8, depth: 0.6 },
    color: 0x8b5a2b,
    position: { x: -5, y: 5 },
  },
];
