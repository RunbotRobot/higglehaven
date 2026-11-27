// The name a screen reader gives the world canvas, by mode (#4591, from the #4574 keyboard and screen-reader walk). The
// canvas used to carry the Build wording in every mode, so in Shop it announced "Build view. With an item chosen, press
// Enter to place it", which is wrong there. Keys named here are the ones that work in that mode (src/shop/keyboardInput.js).
export const WORLD_CANVAS_NAMES = {
  shop: 'World view. Walk with W, A, S, D or the arrow keys, turn with Q and E, and press N for the nearest product.',
  build: 'Build view. With an item chosen, press Enter to place it where the camera is looking.',
  sell: 'Your products view. Walk with W, A, S, D or the arrow keys and turn with Q and E.',
};

export function worldCanvasName(mode) {
  return WORLD_CANVAS_NAMES[mode] ?? WORLD_CANVAS_NAMES.shop;
}
