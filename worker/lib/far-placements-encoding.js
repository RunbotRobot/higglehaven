// #3417 (5/7 of #3412): the compact wire form of a landlet's placements for
// far view, and the matching decoder. Pure (no D1, no cache), so it is unit
// tested on its own and the client's far-view drawing (6/7) can decode with the
// same rules.
//
// A far view needs only: which product, where, turned how, at what size. So a
// response carries a table of product ids once and each placement refers to it
// by index, with positions and rotations rounded to what is visible from afar
// (a centimetre, a milliradian).
//
//   { tile: { x, y, sizeM },
//     templates: ["tpl-a", "tpl-b"],
//     landlets: [ { id, cx, cy, items: [ [t, x, y, z, rx, ry, rz, scale, crop?], ... ] } ] }
//
// `x, y, z` are landlet-local offsets from the landlet centre (cx, cy), the same
// convention as a placed instance. `crop` is present only for a cropped item.
// No labels, no ids, no flags: far view never opens an item.

const round = (value, places) => {
  const factor = 10 ** places;
  const rounded = Math.round((Number(value) || 0) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export const FAR_PLACEMENT_FIELDS = ['templateIndex', 'x', 'y', 'z', 'rotationX', 'rotationY', 'rotationZ', 'scale', 'crop'];

// `rows` are flat query rows ordered by landlet; see far-placements.js.
export function encodeFarPlacements(tile, rows) {
  const templates = [];
  const templateIndex = new Map();
  const landlets = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.id !== row.landlet_id) {
      current = { id: row.landlet_id, cx: round(row.cx, 2), cy: round(row.cy, 2), items: [] };
      landlets.push(current);
    }
    let index = templateIndex.get(row.template_id);
    if (index === undefined) {
      index = templates.length;
      templates.push(row.template_id);
      templateIndex.set(row.template_id, index);
    }
    const item = [
      index, round(row.x_m, 2), round(row.y_m, 2), round(row.z_m, 2),
      round(row.rotation_x_rad, 3), round(row.rotation_y_rad, 3), round(row.rotation_z_rad, 3),
      round(row.scale ?? 1, 3),
    ];
    let crop = null;
    try { crop = JSON.parse(row.crop_json || '{}'); } catch { crop = null; }
    if (crop && Object.keys(crop).length > 0) item.push(crop);
    current.items.push(item);
  }
  return { tile, templates, landlets };
}

// The inverse: named fields, product ids resolved. Positions are still
// landlet-local; add the landlet's (cx, cy) for world coordinates.
export function decodeFarPlacements(payload) {
  return {
    tile: payload.tile,
    landlets: payload.landlets.map((landlet) => ({
      id: landlet.id,
      cx: landlet.cx,
      cy: landlet.cy,
      items: landlet.items.map(([t, x, y, z, rotationX, rotationY, rotationZ, scale, crop]) => ({
        templateId: payload.templates[t], x, y, z, rotationX, rotationY, rotationZ, scale, crop: crop ?? null,
      })),
    })),
  };
}
