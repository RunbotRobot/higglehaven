// #3329 (leaf 6/7 of #3323): the database half of re-laying every placement
// linked to a saved bundle after its creator edits it. The geometry is in
// worker/lib/bundle-relayout.js; read its header for what "matches" means.
//
// Guarantees, in the order a builder would care about them:
//  - A placement that still IS the bundle (the template's members, moved and
//    turned as a unit) is re-laid from the new members, keeping its own anchor
//    and yaw. Its instance ids are kept where the member at the same position
//    in the list is the same product, so another builder's open Build tab
//    mostly keeps working.
//  - A placement that no longer matches (a member was nudged, deleted, tilted)
//    or whose new layout does not fit its landlet is NOT touched. It is
//    detached: it stays exactly as it is, as that builder's own ordinary
//    bundle, and they are told. Nothing disappears from anyone's land.
//  - Every write is conditional on the template still holding the items being
//    laid out, so two edits racing each other never interleave on a landlet.
//  - The builders who own the other landlets get one notice per bundle every
//    10 minutes (rapid successive edits coalesce); a detach notice is never
//    coalesced, since it says something no earlier notice did.
import { HttpError } from './http.js';
import { fireNotification } from './notifications.js';
import { suspendedSellerTemplateIds, SUSPENDED_SELLER_PLACEMENT_ERROR } from './auth.js';
import { findPlacementTransform, layOutItems } from './bundle-relayout.js';
import {
  assertCropWithinTemplateBounds, assertInstanceZWithinLevels, assertInstanceXYWithinLandlet,
  assertInstanceScaleWithinBounds,
} from '../index.js';

// One request may touch this many landlets / rows; beyond it the edit is
// refused up front (before anything is written) rather than half applied.
export const RELAYOUT_MAX_LANDLETS = 25;
export const RELAYOUT_MAX_ROWS = 20000;
export const RELAYOUT_NOTICE_COALESCE_MINUTES = 10;
const ID_CHUNK = 80;

export const RELAYOUT_TOO_MANY_MESSAGE = 'This bundle is placed in too many places to update all at once. Unbundle some copies, then try again.';

const sameItems = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Counts the placements a relayout would touch, for the up-front refusal.
export async function countLinkedPlacements(db, bundleId, excludeGroupId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT landlet_id) AS landlets
    FROM placed_instances WHERE bundle_id = ? AND group_id IS NOT ?
  `).bind(bundleId, excludeGroupId ?? null).first();
  return { rows: row?.rows ?? 0, landlets: row?.landlets ?? 0 };
}

export async function assertNewTemplatesFromActiveSellers(db, oldItems, newItems) {
  const known = new Set(oldItems.map((item) => item.templateId));
  const added = [...new Set(newItems.map((item) => item.templateId).filter((id) => !known.has(id)))];
  if (added.length === 0) return;
  const suspended = await suspendedSellerTemplateIds(db, added);
  if (suspended.size > 0) throw new HttpError(SUSPENDED_SELLER_PLACEMENT_ERROR, 400);
}

function rowToPlacementRow(row) {
  return {
    id: row.instance_id,
    templateId: row.template_id,
    x: row.x_m, y: row.y_m, z: row.z_m,
    rotationX: row.rotation_x_rad, rotationY: row.rotation_y_rad, rotationZ: row.rotation_z_rad,
    scale: row.scale,
  };
}

// A row with its own text or a community flag is something a member edit
// cannot recreate faithfully, so the placement is left alone instead.
const hasOwnState = (row) => row.label !== null || row.is_community_sign === 1 || row.is_community_calendar === 1;

export async function relayoutLinkedPlacements(db, {
  bundleId, bundleName, oldItems, newItems, newItemsJson, editorBuilderId, editorLabel, excludeGroupId,
}) {
  const { results } = await db.prepare(`
    SELECT p.*, l.owner_builder_id AS owner_builder_id, l.name AS landlet_name
    FROM placed_instances p JOIN landlets l ON l.landlet_id = p.landlet_id
    WHERE p.bundle_id = ? AND p.group_id IS NOT ?
    ORDER BY p.landlet_id, p.group_id, p.instance_id
  `).bind(bundleId, excludeGroupId ?? null).all();

  const placements = new Map();
  for (const row of results) {
    const key = `${row.landlet_id}\u0000${row.group_id}`;
    if (!placements.has(key)) {
      placements.set(key, {
        landletId: row.landlet_id, landletName: row.landlet_name, groupId: row.group_id,
        ownerBuilderId: row.owner_builder_id, rows: [],
      });
    }
    placements.get(key).rows.push(row);
  }

  const guard = `EXISTS (SELECT 1 FROM bundles WHERE bundle_id = ? AND items_json = ?)`;
  const guardBinds = [bundleId, newItemsJson];
  const statementsByLandlet = new Map();
  const push = (landletId, statement) => {
    if (!statementsByLandlet.has(landletId)) statementsByLandlet.set(landletId, []);
    statementsByLandlet.get(landletId).push(statement);
  };
  // Per owning builder: which landlets were relaid / detached.
  const outcomeByBuilder = new Map();
  const outcomeFor = (builderId) => {
    if (!outcomeByBuilder.has(builderId)) outcomeByBuilder.set(builderId, { relaid: new Set(), detached: new Set() });
    return outcomeByBuilder.get(builderId);
  };
  const ownLandletIdsChanged = new Set();
  let relaidCount = 0;
  let detachedCount = 0;

  for (const placement of placements.values()) {
    const detach = () => {
      push(placement.landletId, db.prepare(`
        UPDATE placed_instances SET bundle_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE group_id = ? AND landlet_id = ? AND bundle_id = ?
      `).bind(placement.groupId, placement.landletId, bundleId));
      detachedCount += 1;
      if (placement.ownerBuilderId) outcomeFor(placement.ownerBuilderId).detached.add(placement.landletName);
      if (placement.ownerBuilderId === editorBuilderId) ownLandletIdsChanged.add(placement.landletId);
    };
    if (placement.rows.some(hasOwnState)) { detach(); continue; }
    const rows = placement.rows.map(rowToPlacementRow);
    const found = findPlacementTransform(oldItems, rows);
    if (!found) {
      // Already shows the new members (an earlier attempt got this far).
      if (findPlacementTransform(newItems, rows)) continue;
      detach();
      continue;
    }
    const laid = layOutItems(newItems, found);
    const candidates = laid.map((member, index) => ({
      instanceId: `instance-${crypto.randomUUID()}`, landletId: placement.landletId, ...member, index,
    }));
    try {
      assertInstanceScaleWithinBounds(candidates);
      await assertCropWithinTemplateBounds(db, candidates);
      await assertInstanceZWithinLevels(db, candidates);
      await assertInstanceXYWithinLandlet(db, candidates);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      detach();
      continue;
    }
    // Keep an instance id where the member at this position is the same product.
    const keptIds = new Set();
    for (const candidate of candidates) {
      const old = oldItems[candidate.index];
      const oldId = old && old.templateId === candidate.templateId ? found.pairs.get(candidate.index) : undefined;
      if (oldId) { candidate.instanceId = oldId; candidate.reuse = true; keptIds.add(oldId); }
    }
    const removeIds = rows.map((row) => row.id).filter((id) => !keptIds.has(id));
    for (let i = 0; i < removeIds.length; i += ID_CHUNK) {
      const chunk = removeIds.slice(i, i + ID_CHUNK);
      push(placement.landletId, db.prepare(`
        DELETE FROM placed_instances
        WHERE instance_id IN (${chunk.map(() => '?').join(', ')}) AND bundle_id = ? AND ${guard}
      `).bind(...chunk, bundleId, ...guardBinds));
    }
    for (const c of candidates) {
      if (c.reuse) {
        push(placement.landletId, db.prepare(`
          UPDATE placed_instances SET template_id = ?, x_m = ?, y_m = ?, z_m = ?,
            rotation_x_rad = ?, rotation_y_rad = ?, rotation_z_rad = ?, crop_json = ?, scale = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE instance_id = ? AND bundle_id = ? AND ${guard}
        `).bind(c.templateId, c.x, c.y, c.z, c.rotationX, c.rotationY, c.rotationZ, JSON.stringify(c.crop), c.scale,
          c.instanceId, bundleId, ...guardBinds));
      } else {
        push(placement.landletId, db.prepare(`
          INSERT INTO placed_instances
            (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad,
             crop_json, scale, group_id, bundle_id)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${guard} AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
        `).bind(c.instanceId, placement.landletId, c.templateId, c.x, c.y, c.z, c.rotationX, c.rotationY, c.rotationZ,
          JSON.stringify(c.crop), c.scale, placement.groupId, bundleId, ...guardBinds,
          placement.landletId, placement.ownerBuilderId));
      }
    }
    relaidCount += 1;
    if (placement.ownerBuilderId) outcomeFor(placement.ownerBuilderId).relaid.add(placement.landletName);
    if (placement.ownerBuilderId === editorBuilderId) ownLandletIdsChanged.add(placement.landletId);
  }

  // One batch per landlet: D1 runs a batch in a transaction, so a landlet is
  // never left half re-laid.
  for (const statements of statementsByLandlet.values()) await db.batch(statements);

  let notifiedBuilders = 0;
  for (const [builderId, outcome] of outcomeByBuilder) {
    if (builderId === editorBuilderId) continue;
    const parts = [];
    const names = (set) => [...set].join(', ');
    if (outcome.relaid.size > 0) {
      const sentence = `${editorLabel} changed the bundle "${bundleName}" on your lándlet ${names(outcome.relaid)}. Unbundle it if you want to keep your own copy.`;
      // D1 caps a LIKE pattern at 50 bytes, so the (long) wording is matched here.
      const { results: recentNotices } = await db.prepare(`
        SELECT message FROM notifications
        WHERE builder_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
        ORDER BY created_at DESC LIMIT 50
      `).bind(builderId, `-${RELAYOUT_NOTICE_COALESCE_MINUTES} minutes`).all();
      const marker = ` changed the bundle "${bundleName}" on your lándlet `;
      const recent = recentNotices.some((notice) => notice.message.includes(marker));
      if (!recent) parts.push(sentence);
    }
    if (outcome.detached.size > 0) {
      parts.push(`${editorLabel} changed the bundle "${bundleName}", but your copy on lándlet ${names(outcome.detached)} no longer matched it, so it was left exactly as it is and is now your own bundle.`);
    }
    if (parts.length === 0) continue;
    await fireNotification(db, builderId, parts.join(' '));
    notifiedBuilders += 1;
  }

  return { relaidCount, detachedCount, notifiedBuilders, ownLandletIds: [...ownLandletIdsChanged] };
}

export { sameItems };
