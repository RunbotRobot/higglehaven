// #4198: a read-only list of the items that stand off their own lándlet, for the owner and the fleet to see what is
// already there before the rule that keeps new ones out (shared/landlet-outline.js) is switched on. Nothing is moved
// or removed here, or by the rule: an item already outside keeps loading and is marked in Build.
//
//   GET /api/admin-items-outside-landlets   admin only
//
// Built for today's size (a few thousand items on a few lándlets): one pass over every owned lándlet's items, no
// paging. If the item count passes about 50,000 this wants to become a per-lándlet request.
import { json } from './http.js';
import { requireAdmin } from './auth.js';
import { footprintScaleAtHeight } from '../earthCurvature.js';
import { parseOutline, scaleOutline, footprintCorners, footprintInsideOutline } from '../../shared/landlet-outline.js';
import { instanceFromRow, templateFromRow } from '../index.js';

const EXAMPLES_PER_LANDLET = 5;

// The footprint an item claims, by the same rules the square check has always used: crop and scale applied, except
// flooring, which is always its template's raw width and depth.
export function instanceFootprintSize(instance, template) {
  if (!template) return { width: 0, depth: 0 };
  if (template.metadata?.flooring === true) return { width: template.dimensions.width, depth: template.dimensions.depth };
  return {
    width: (instance.crop?.x ?? template.dimensions.width) * instance.scale,
    depth: (instance.crop?.y ?? template.dimensions.depth) * instance.scale,
  };
}

export async function handleAdminItemsOutsideLandlets(request, db) {
  await requireAdmin(request, db);
  const { results: landlets } = await db.prepare(`
    SELECT l.landlet_id, l.name, l.polygon_json, u.username
    FROM landlets l
    LEFT JOIN builders b ON b.builder_id = l.owner_builder_id
    LEFT JOIN users u ON u.user_id = b.user_id
    WHERE l.owner_builder_id IS NOT NULL
    ORDER BY l.landlet_id
  `).all();
  const { results: instanceRows } = await db.prepare('SELECT * FROM placed_instances').all();
  const { results: templateRows } = await db.prepare('SELECT * FROM catalog_templates').all();
  const templatesById = new Map(templateRows.map((row) => [row.template_id, templateFromRow(row)]));
  const instancesByLandlet = new Map();
  for (const row of instanceRows) {
    const list = instancesByLandlet.get(row.landlet_id) ?? [];
    list.push(instanceFromRow(row));
    instancesByLandlet.set(row.landlet_id, list);
  }

  const report = [];
  let totalChecked = 0;
  let totalOutside = 0;
  for (const landlet of landlets) {
    const outline = parseOutline(landlet.polygon_json);
    const instances = instancesByLandlet.get(landlet.landlet_id) ?? [];
    totalChecked += instances.length;
    if (!outline) continue; // no usable outline to measure against
    const examples = [];
    let outside = 0;
    for (const instance of instances) {
      const template = templatesById.get(instance.templateId);
      const { width, depth } = instanceFootprintSize(instance, template);
      const corners = footprintCorners({ x: instance.x, y: instance.y, width, depth, rotationZ: instance.rotationZ ?? 0 });
      const scaled = scaleOutline(outline, footprintScaleAtHeight(instance.z));
      if (footprintInsideOutline(scaled, corners)) continue;
      outside += 1;
      if (examples.length < EXAMPLES_PER_LANDLET) {
        examples.push({ instanceId: instance.instanceId, product: template?.name ?? null, x: Number(instance.x.toFixed(2)), y: Number(instance.y.toFixed(2)) });
      }
    }
    totalOutside += outside;
    if (outside > 0) {
      report.push({ landletId: landlet.landlet_id, name: landlet.name, owner: landlet.username ?? null, items: instances.length, outside, examples });
    }
  }
  return json({ checkedItems: totalChecked, outsideItems: totalOutside, landlets: report });
}
