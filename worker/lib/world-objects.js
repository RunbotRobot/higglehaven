// #2539: world-object handlers -- placed instances (and their nested
// backup/replacement chains), community sign posts, and community
// calendar events (plus its own trigger-check sub-route). Extracted
// verbatim from worker/index.js, zero behavior change, same discipline
// as #2501/#2519/#2454.
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import {
  readJson, stringValue, queryLimit, decodeCursor, encodeCursor, assertReferencesExist,
} from './validation.js';
import { currentUser, requireSessionBuilder, requireVerifiedSession } from './auth.js';
import { adminActionLogStatement } from './admin-log.js';
// #2535 (see its own module's comment for the general shape): these
// haven't been extracted from worker/index.js yet -- requireOwnedLandlet(s)
// is a genuinely cross-cutting auth/ownership helper used from dozens of
// unrelated handlers, and assertReferenceExists/the instance-validation
// helpers below live alongside handleInstancePurchase's own use of them,
// not just this module's. Importing them back from the main file (rather
// than duplicating or prematurely relocating them) is an intentional, safe
// circular import -- every one of these is only ever called at request
// time, long after both modules have finished their own top-level
// evaluation, so the cycle never actually binds an undefined value.
import {
  requireOwnedLandlet, requireOwnedLandlets,
  assertReferenceExists, assertCropWithinTemplateBounds, assertInstanceZWithinLevels,
  assertInstanceXYWithinLandlet, assertInstanceScaleWithinBounds, cropsEqual, instanceParams, instanceFromRow,
  getInstancesById, validateInstance, recordContentEditHistory,
  isoDateString,
} from '../index.js';
// #2614: handleInstancePurchase itself moved out of worker/index.js into
// worker/lib/purchase-creation.js -- import it from there directly instead
// of via the '../index.js' circular-import path above.
import { handleInstancePurchase } from './purchase-creation.js';

// #827: unlike almost every other authenticated write in this file
// (landlet-version, bundle-create, saved-layout-create, friend-request,
// calendar-event, landlet-self-claim-create, ...), none of the placed_instances
// mutations below ever called checkRateLimit — a compromised/scripted builder
// session could flood single or batch creates/updates/deletes with zero
// throttling. This bucket needs a much higher ceiling than those endpoints'
// (10-30 per RATE_LIMIT_WINDOW_MS): unlike a one-off friend request or bundle,
// src/main.js's syncUpdate fires on every discrete drag/rotate/resize/rename
// commit during ordinary active building, easily dozens of times in a few
// minutes — a low threshold copied from those endpoints would throttle a
// legitimately active builder mid-session, the same trap PR #381 hit (and
// was superseded by #382 for) when it tried a naive per-IP limit on catalog
// creation. One shared bucket per builder across every write shape (single
// or batch — a batch of up to 100 instances counts as one hit, same as
// every other batch endpoint in this file) still bounds a genuine flood
// while leaving generous headroom for real interactive editing.
const INSTANCE_WRITE_RATE_LIMIT_MAX = 500;

export async function handleInstances(request, env, route, url) {
  const db = env.DB;
  if (request.method === 'DELETE' && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.instanceIds)) throw new HttpError('instanceIds must be an array', 400);
    if (input.instanceIds.length === 0) throw new HttpError('instanceIds must contain at least one item', 400);
    if (input.instanceIds.length > 100) throw new HttpError('instanceIds must contain at most 100 items', 400);
    const instanceIds = input.instanceIds.map((id) => stringValue(id, 'instanceIds item'));
    if (new Set(instanceIds).size !== instanceIds.length) throw new HttpError('instanceIds must be unique', 400);
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    const placeholders = instanceIds.map(() => '?').join(', ');
    const { results } = await db.prepare(`
      SELECT instance_id, landlet_id FROM placed_instances WHERE instance_id IN (${placeholders})
    `).bind(...instanceIds).all();
    if (results.length !== instanceIds.length) {
      throw new HttpError('Every instanceId must reference an existing placed instance', 404);
    }
    await requireOwnedLandlets(db, results.map((row) => row.landlet_id), sessionBuilder.builder_id);
    const landletIdByInstanceId = new Map(results.map((row) => [row.instance_id, row.landlet_id]));
    // #929: same fold-the-ownership-re-check-into-the-write idiom as the
    // single DELETE above and the POST/PUT batch below — requireOwnedLandlets
    // is a point-in-time check, so without this a landlet transfer landing
    // in the await gap since `results` was fetched would let this DELETE
    // still remove rows the caller no longer owns.
    const batchResults = await db.batch(instanceIds.map((instanceId) => db.prepare(`
      DELETE FROM placed_instances
      WHERE instance_id = ?
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(instanceId, landletIdByInstanceId.get(instanceId), sessionBuilder.builder_id)));
    // #1773: sibling of #1772's own fix — a batch can span multiple
    // landlets (requireOwnedLandlets above explicitly supports that), and
    // db.batch() has no atomic rollback on a WHERE-guard mismatch (same D1
    // semantics the single-instance PATCH handler below's own #1022
    // comment documents): a guard failing for one instance's landlet
    // doesn't undo another instance's own delete in the same batch.
    // Throwing a blanket 409 here used to claim the whole request failed
    // even when some of these deletes were already durable -- real rows on
    // a still-owned landlet, genuinely gone from the DB, while the client
    // (believing nothing happened) never prunes them locally. Only when
    // literally nothing was deleted is it safe to report a clean,
    // fully-retryable failure; otherwise report exactly which instanceIds
    // were rejected so the caller can reconcile instead of being lied to.
    const rejectedInstanceIds = instanceIds.filter((_, i) => batchResults[i].meta.changes === 0);
    if (rejectedInstanceIds.length === instanceIds.length) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const rejectedSet = new Set(rejectedInstanceIds);
    const deletedInstanceIds = instanceIds.filter((instanceId) => !rejectedSet.has(instanceId));
    return json({ deletedInstanceIds, rejectedInstanceIds });
  }

  // #2764: core Group/Ungroup actions. A group is just a shared, opaque
  // `group_id` (migrations/0154_placed_instance_groups.sql) -- there's no
  // separate "group" resource to create first, so grouping an existing
  // group's members together with other instances (or with another
  // group's members) simply overwrites every one of them with one freshly
  // minted id, merging whichever prior groups happened to be selected
  // rather than requiring them to be ungrouped first. The frontend's own
  // selection logic (src/build/scene.js's selectOnly/toggleInSelection)
  // always expands a selection to whole groups before this is ever called,
  // so in practice a request here never asks to split a group -- but the
  // server doesn't assume that itself, same "never trust the client already
  // did its own validation" posture as every other write in this file.
  if (request.method === 'POST' && route.length === 2 && route[1] === 'group') {
    const input = await readJson(request);
    if (!Array.isArray(input.instanceIds)) throw new HttpError('instanceIds must be an array', 400);
    if (input.instanceIds.length < 2) throw new HttpError('instanceIds must contain at least 2 items', 400);
    if (input.instanceIds.length > 100) throw new HttpError('instanceIds must contain at most 100 items', 400);
    const instanceIds = input.instanceIds.map((id) => stringValue(id, 'instanceIds item'));
    if (new Set(instanceIds).size !== instanceIds.length) throw new HttpError('instanceIds must be unique', 400);
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    const placeholders = instanceIds.map(() => '?').join(', ');
    const { results } = await db.prepare(`
      SELECT instance_id, landlet_id, group_id FROM placed_instances WHERE instance_id IN (${placeholders})
    `).bind(...instanceIds).all();
    if (results.length !== instanceIds.length) {
      throw new HttpError('Every instanceId must reference an existing placed instance', 404);
    }
    await requireOwnedLandlets(db, results.map((row) => row.landlet_id), sessionBuilder.builder_id);
    const landletIdByInstanceId = new Map(results.map((row) => [row.instance_id, row.landlet_id]));
    const priorGroupIdByInstanceId = new Map(results.map((row) => [row.instance_id, row.group_id]));
    const groupId = crypto.randomUUID();
    // #929 idiom: fold the ownership re-check into each write, same as the
    // DELETE/POST/PUT batch endpoints above -- requireOwnedLandlets is a
    // point-in-time check.
    const batchResults = await db.batch(instanceIds.map((instanceId) => db.prepare(`
      UPDATE placed_instances SET group_id = ?
      WHERE instance_id = ?
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(groupId, instanceId, landletIdByInstanceId.get(instanceId), sessionBuilder.builder_id)));
    const rejectedInstanceIds = instanceIds.filter((_, i) => batchResults[i].meta.changes === 0);
    if (rejectedInstanceIds.length > 0) {
      // Unlike the DELETE/POST/PUT batch endpoints above (#1772/#1773,
      // which report a partial success since they're writing rows that
      // already independently existed), this call mints one brand new
      // shared group_id -- "most members report the new id, a few don't"
      // is an actively broken, half-formed group, not a partially-applied
      // write. Rolls back whichever members did land rather than leaving
      // that behind -- restoring each one's own PRIOR group_id (NULL, or
      // another group's id if it was already grouped before this request;
      // see #2788) rather than blanket-nulling it, since blanket-null would
      // silently dissolve a pre-existing group the caller never asked to
      // touch, as a side effect of a request reported as a total failure.
      const succeededInstanceIds = instanceIds.filter((_, i) => batchResults[i].meta.changes > 0);
      if (succeededInstanceIds.length > 0) {
        await db.batch(succeededInstanceIds.map((instanceId) => db.prepare(`
          UPDATE placed_instances SET group_id = ? WHERE instance_id = ? AND group_id = ?
        `).bind(priorGroupIdByInstanceId.get(instanceId), instanceId, groupId)));
      }
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const stored = await getInstancesById(db, instanceIds);
    return json({ groupId, instances: instanceIds.map((instanceId) => stored.get(instanceId)) }, 201);
  }

  // #2764: Ungroup fully dissolves a group back to independent items (no
  // partial/nested ungroup -- see #2763's own "Owner-judgment items" for why
  // that stays out of scope here). Targets a `groupId` directly (every
  // member the frontend has selected already carries the same one, via
  // mesh.userData.groupId) rather than an instanceIds list, since there's no
  // partial form of this action to express.
  if (request.method === 'POST' && route.length === 2 && route[1] === 'ungroup') {
    const input = await readJson(request);
    const groupId = stringValue(input.groupId, 'groupId');
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    const { results } = await db.prepare(`
      SELECT instance_id, landlet_id FROM placed_instances WHERE group_id = ?
    `).bind(groupId).all();
    if (results.length === 0) throw new HttpError('Group not found', 404);
    await requireOwnedLandlets(db, results.map((row) => row.landlet_id), sessionBuilder.builder_id);
    const instanceIds = results.map((row) => row.instance_id);
    const landletIdByInstanceId = new Map(results.map((row) => [row.instance_id, row.landlet_id]));
    // #929 idiom, same as every other write in this file — requireOwnedLandlets
    // above is a point-in-time check.
    const batchResults = await db.batch(instanceIds.map((instanceId) => db.prepare(`
      UPDATE placed_instances SET group_id = NULL
      WHERE instance_id = ? AND group_id = ?
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(instanceId, groupId, landletIdByInstanceId.get(instanceId), sessionBuilder.builder_id)));
    // #1772/#1773 idiom: dissolving is independent per member (unlike Group
    // above, a member left behind mid-dissolve is just "still grouped," not
    // a broken state), so only a total failure is a clean, retryable 409.
    const rejectedInstanceIds = instanceIds.filter((_, i) => batchResults[i].meta.changes === 0);
    if (rejectedInstanceIds.length === instanceIds.length) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const rejectedSet = new Set(rejectedInstanceIds);
    const ungroupedInstanceIds = instanceIds.filter((instanceId) => !rejectedSet.has(instanceId));
    return json({ ungroupedInstanceIds, rejectedInstanceIds });
  }

  if ((request.method === 'POST' || request.method === 'PUT') && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.instances)) throw new HttpError('instances must be an array', 400);
    if (input.instances.length === 0) throw new HttpError('instances must contain at least one item', 400);
    if (input.instances.length > 100) throw new HttpError('instances must contain at most 100 items', 400);
    const instances = input.instances.map((item) => validateInstance(item, crypto.randomUUID()));
    const instanceIds = instances.map((instance) => instance.instanceId);
    if (new Set(instanceIds).size !== instanceIds.length) {
      throw new HttpError('instanceId values must be unique', 400);
    }
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    await assertReferencesExist(db, 'catalog_templates', 'template_id', instances.map((instance) => instance.templateId), 'templateId');
    await assertReferencesExist(db, 'landlets', 'landlet_id', instances.map((instance) => instance.landletId), 'landletId');
    const existingInstances = await getInstancesById(db, instanceIds);
    // Found via backlog audit: this batch endpoint re-validated crop/z
    // unconditionally for every instance, even ones already stored
    // unchanged — exactly the bug #338 already fixed for the single-
    // instance PUT/PATCH handler below (see its own comment). PUT
    // /instances/batch is what a multi-item group move or an undo/redo
    // snapshot restore uses (src/api.js's upsertInstancesRemote), and both
    // resend every affected instance's full current state, untouched ones
    // included — so a template shrunk (or a landlet level removed) after
    // an instance's crop/z was already validated would brick that
    // instance on its next unrelated group move, the same bricking #338
    // fixed for a single-instance edit. An instance with no existing row
    // (a genuinely new one, or POST's case where none can exist yet)
    // always gets validated, same as before.
    const instancesNeedingCropCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.templateId !== existing.templateId || !cropsEqual(instance.crop, existing.crop);
    });
    await assertCropWithinTemplateBounds(db, instancesNeedingCropCheck);
    const instancesNeedingZCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.z !== existing.z || instance.landletId !== existing.landletId;
    });
    await assertInstanceZWithinLevels(db, instancesNeedingZCheck);
    // Same "only re-check what actually changed" reasoning as crop/z above.
    // #1048: scale's own domain bound is checked before the footprint-aware
    // XY check below (see that call site's own comment for why).
    const instancesNeedingScaleCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.scale !== existing.scale;
    });
    assertInstanceScaleWithinBounds(instancesNeedingScaleCheck);
    // Same "only re-check what actually changed" reasoning as crop/z above
    // — an untouched x/y resent unchanged on an unrelated group move
    // shouldn't get re-validated against a bound that may have tightened
    // since (footprintScaleAtHeight shrinks with z, so a level added above
    // an instance after it was placed could otherwise brick it here).
    // Also re-checks on a crop/templateId/scale change — the XY check is
    // now footprint-aware, so those affect the bound too, not just x/y/z/
    // landletId.
    const instancesNeedingXYCheck = instances.filter((instance) => {
      const existing = existingInstances.get(instance.instanceId);
      return !existing || instance.x !== existing.x || instance.y !== existing.y || instance.z !== existing.z
        || instance.landletId !== existing.landletId || instance.scale !== existing.scale
        || instance.templateId !== existing.templateId || !cropsEqual(instance.crop, existing.crop);
    });
    await assertInstanceXYWithinLandlet(db, instancesNeedingXYCheck);
    const landletIdsToCheck = new Set(instances.map((instance) => instance.landletId));
    for (const existing of existingInstances.values()) landletIdsToCheck.add(existing.landletId);
    await requireOwnedLandlets(db, landletIdsToCheck, sessionBuilder.builder_id);
    const conflictClause = request.method === 'PUT' ? `
      ON CONFLICT(instance_id) DO UPDATE SET
        landlet_id = excluded.landlet_id, template_id = excluded.template_id,
        x_m = excluded.x_m, y_m = excluded.y_m, z_m = excluded.z_m,
        rotation_x_rad = excluded.rotation_x_rad, rotation_y_rad = excluded.rotation_y_rad,
        rotation_z_rad = excluded.rotation_z_rad, label = excluded.label, crop_json = excluded.crop_json,
        scale = excluded.scale, is_community_sign = excluded.is_community_sign,
        is_community_calendar = excluded.is_community_calendar,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ` : '';
    // #456: same reasoning as the single-create endpoint above — fold the
    // ownership re-check into each write instead of trusting the
    // point-in-time requireOwnedLandlets check above alone.
    const batchResults = await db.batch(instances.map((instance) => db.prepare(`
      INSERT INTO placed_instances
        (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
      ${conflictClause}
    `).bind(...instanceParams(instance), instance.landletId, sessionBuilder.builder_id)));
    // #1772: a batch can span multiple landlets (requireOwnedLandlets above
    // explicitly supports that), and db.batch() has no atomic rollback on a
    // WHERE-guard mismatch (same D1 semantics the single-instance PATCH
    // handler below's own #1022 comment documents) -- a guard failing for
    // one instance's landlet doesn't undo another instance's own write in
    // the same batch. Throwing a blanket 409 here used to claim the whole
    // request failed even when some of these writes were already durable.
    // Only when literally nothing landed is it safe to report a clean,
    // fully-retryable failure; otherwise report exactly which instanceIds
    // were rejected so the caller can reconcile instead of being lied to.
    const rejectedInstanceIds = instances
      .filter((_, i) => batchResults[i].meta.changes === 0)
      .map((instance) => instance.instanceId);
    if (rejectedInstanceIds.length === instances.length) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const rejectedSet = new Set(rejectedInstanceIds);
    const succeededInstanceIds = instanceIds.filter((instanceId) => !rejectedSet.has(instanceId));
    // #1675: the single-instance PATCH handler below has its own #1022
    // cleanup for exactly this transition -- this sibling batch endpoint
    // (what a multi-item group move or an undo/redo snapshot restore uses)
    // never had it, so unflagging a community sign/calendar through here
    // left its sign_posts/calendar_events rows sitting around
    // invisible-but-persistent, same resurrection risk #1022 fixed for the
    // single-instance path. existingInstances (built above, before the
    // write) already has each instance's prior flag value to diff against.
    // Skips any instance in rejectedSet -- its write above never actually
    // landed, so its stored flag value didn't change and this cleanup must
    // not run for it either.
    for (const instance of instances) {
      if (rejectedSet.has(instance.instanceId)) continue;
      const existing = existingInstances.get(instance.instanceId);
      if (existing?.isCommunitySign && !instance.isCommunitySign) {
        await db.prepare('DELETE FROM sign_posts WHERE instance_id = ?').bind(instance.instanceId).run();
      }
      if (existing?.isCommunityCalendar && !instance.isCommunityCalendar) {
        await db.prepare('DELETE FROM calendar_events WHERE instance_id = ?').bind(instance.instanceId).run();
      }
    }
    const stored = await getInstancesById(db, succeededInstanceIds);
    return json({
      instances: succeededInstanceIds.map((instanceId) => stored.get(instanceId)),
      rejectedInstanceIds,
    }, request.method === 'POST' ? 201 : 200);
  }

  if (request.method === 'GET' && route.length === 1) {
    const landletIdParam = url.searchParams.get('landletId');
    const landletId = landletIdParam === null ? 'starter-landlet' : stringValue(landletIdParam, 'landletId');
    const templateIdParam = url.searchParams.get('templateId');
    const templateId = templateIdParam === null ? null : stringValue(templateIdParam, 'templateId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = ['landlet_id = ?'];
    const bindings = [landletId];
    if (templateId) {
      conditions.push('template_id = ?');
      bindings.push(templateId);
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND instance_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    bindings.push(limit + 1);
    const { results } = await db.prepare(`
      SELECT * FROM placed_instances
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at, instance_id LIMIT ?
    `).bind(...bindings).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      instances: page.map(instanceFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.instance_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    return row ? json({ instance: instanceFromRow(row) }) : json({ error: 'Instance not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const instance = validateInstance(input, crypto.randomUUID());
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    await assertReferenceExists(db, 'catalog_templates', 'template_id', instance.templateId, 'templateId');
    await assertReferenceExists(db, 'landlets', 'landlet_id', instance.landletId, 'landletId');
    await requireOwnedLandlet(db, instance.landletId, sessionBuilder.builder_id);
    await assertCropWithinTemplateBounds(db, [instance]);
    await assertInstanceZWithinLevels(db, [instance]);
    // #1048: scale's own domain bound before the footprint-aware XY check.
    assertInstanceScaleWithinBounds([instance]);
    await assertInstanceXYWithinLandlet(db, [instance]);
    // #456: requireOwnedLandlet above is a point-in-time check — an auction
    // resolving (transferring ownership, wiping placed_instances) in the
    // await gap between it and this write would otherwise let this request
    // still plant an instance on a landlet that's no longer the caller's.
    // Same "fold the ownership re-check into the write itself" idiom #415
    // already used for handleLandletVersions/handleLandletDraft.
    const created = await db.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(...instanceParams(instance), instance.landletId, sessionBuilder.builder_id).run();
    if (created.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const stored = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(instance.instanceId).first();
    // #2392: not found here means a concurrent auction transfer (which
    // wipes every placed_instances row on the landlet, see
    // buildAuctionWinnerSettlementStatements) landed in the single await
    // gap between the guarded INSERT above and this re-SELECT -- a genuine
    // 404, same race shape #2334 already fixed for notifications, not an
    // uncaught instanceFromRow(undefined) crash.
    if (!stored) return json({ error: 'Instance not found' }, 404);
    return json({ instance: instanceFromRow(stored) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Instance not found' }, 404);
    const input = await readJson(request);
    const instance = validateInstance({ ...instanceFromRow(existing), ...input, instanceId: route[1] }, route[1]);
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    await assertReferenceExists(db, 'catalog_templates', 'template_id', instance.templateId, 'templateId');
    await assertReferenceExists(db, 'landlets', 'landlet_id', instance.landletId, 'landletId');
    await requireOwnedLandlet(db, existing.landlet_id, sessionBuilder.builder_id);
    if (instance.landletId !== existing.landlet_id) {
      await requireOwnedLandlet(db, instance.landletId, sessionBuilder.builder_id);
    }
    // Found via backlog audit (#338): re-validating crop unconditionally
    // here, even when neither crop nor templateId actually changed, meant a
    // template shrunk (or its extensible.minM raised) after an instance's
    // crop was already set could brick that instance — any later PATCH for
    // something wholly unrelated (moving it, renaming its label) would
    // re-check the *carried-over* stale crop against the template's
    // *current* bounds and 400, even though the caller never meant to
    // touch crop. A first attempt at this fix checked only whether `crop`/
    // `templateId` were *present* in the request body — but src/main.js's
    // syncUpdate always resends the mesh's full current state (crop
    // included) on every edit via instanceFromMesh, so that check was
    // always true for real frontend traffic and never actually skipped
    // anything. Comparing actual values against the stored row (via
    // cropsEqual) is what correctly distinguishes "this request resent the
    // same crop unchanged" from "this request is asserting a new crop/
    // template pairing that didn't already exist" — only the latter needs
    // re-validating.
    const cropOrTemplateChanged = instance.templateId !== existing.template_id
      || !cropsEqual(instance.crop, JSON.parse(existing.crop_json || '{}'));
    if (cropOrTemplateChanged) {
      await assertCropWithinTemplateBounds(db, [instance]);
    }
    // Same "only re-check what actually changed" reasoning as crop above:
    // an unrelated PATCH (renaming a label, say) always resends the
    // instance's full current state, so re-validating an untouched z
    // against the landlet's *current* levels would risk bricking existing
    // instances if a level was ever removed out from under them.
    if (instance.z !== existing.z_m || instance.landletId !== existing.landlet_id) {
      await assertInstanceZWithinLevels(db, [instance]);
    }
    // Same "only re-check what actually changed" reasoning as crop/z above.
    // #1048: scale's own domain bound is checked before the footprint-aware
    // XY check below (see that call site's own comment for why).
    if (instance.scale !== existing.scale) {
      assertInstanceScaleWithinBounds([instance]);
    }
    // Also re-checks on a crop/templateId/scale change — the XY check is
    // now footprint-aware, so those affect the bound too, not just x/y/z/
    // landletId.
    if (instance.x !== existing.x_m || instance.y !== existing.y_m
      || instance.z !== existing.z_m || instance.landletId !== existing.landlet_id
      || instance.scale !== existing.scale || cropOrTemplateChanged) {
      await assertInstanceXYWithinLandlet(db, [instance]);
    }
    // #456: fold the ownership re-check into the write itself — same
    // reasoning as the create endpoints above. Without this, a landlet
    // transfer (which deletes every placed_instances row on it — see
    // resolveAuction) landing in the await gap since existing was fetched
    // means this UPDATE's plain "WHERE instance_id = ?" would silently
    // affect zero rows, and (before this fix) that went unchecked: the
    // response still fed the stale `existing` id into a fresh SELECT that
    // now returns nothing, feeding a null row into instanceFromRow.
    // Re-checking ownership explicitly (rather than relying on the row
    // simply being gone) also closes the same gap for any other write that
    // might one day mutate a landlet's ownership without deleting its
    // instances.
    const updated = await db.prepare(`
      UPDATE placed_instances
      SET landlet_id = ?, template_id = ?, x_m = ?, y_m = ?, z_m = ?, rotation_x_rad = ?, rotation_y_rad = ?, rotation_z_rad = ?, label = ?, crop_json = ?, scale = ?, is_community_sign = ?, is_community_calendar = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE instance_id = ?
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationX, instance.rotationY, instance.rotationZ, instance.label, JSON.stringify(instance.crop), instance.scale, instance.isCommunitySign ? 1 : 0, instance.isCommunityCalendar ? 1 : 0, route[1], instance.landletId, sessionBuilder.builder_id).run();
    if (updated.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    // #1022: unflagging (true -> false) used to only ever touch this row's
    // own is_community_sign/is_community_calendar columns -- the sign's
    // sign_posts/calendar's calendar_events rows were never cleared, so
    // they sat around invisible-but-persistent and silently reappeared if
    // the same instance was ever re-flagged later. Only the ON DELETE
    // CASCADE (migrations/0041/0042) fires on actually deleting the
    // instance; unflagging needs its own explicit cleanup here. Run as
    // separate follow-up writes gated on the UPDATE above having actually
    // landed (not batched with it), same idiom as #1006's notification
    // fix -- db.batch() has no atomic rollback on a WHERE-guard mismatch,
    // so batching an unconditional delete alongside a write that might
    // still no-op on the ownership race above would delete real content
    // even when the PATCH itself ends up rejected with a 409.
    if (existing.is_community_sign && !instance.isCommunitySign) {
      await db.prepare('DELETE FROM sign_posts WHERE instance_id = ?').bind(route[1]).run();
    }
    if (existing.is_community_calendar && !instance.isCommunityCalendar) {
      await db.prepare('DELETE FROM calendar_events WHERE instance_id = ?').bind(route[1]).run();
    }
    const stored = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    // #2392: not found here means a concurrent auction transfer (which
    // wipes every placed_instances row on the landlet, see
    // buildAuctionWinnerSettlementStatements) landed in the await gap
    // between the guarded UPDATE above and this re-SELECT -- a genuine
    // 404, same race shape #2334 already fixed for notifications, not an
    // uncaught instanceFromRow(undefined) crash.
    if (!stored) return json({ error: 'Instance not found' }, 404);
    return json({ instance: instanceFromRow(stored) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT landlet_id FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Instance not found' }, 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    await checkRateLimit(db, `instance-write:${sessionBuilder.builder_id}`, INSTANCE_WRITE_RATE_LIMIT_MAX);
    await requireOwnedLandlet(db, existing.landlet_id, sessionBuilder.builder_id);
    // #929: requireOwnedLandlet above is a point-in-time check, unlike the
    // POST/PUT/PATCH siblings above, which fold their own ownership
    // re-check into the write itself. Without this, a landlet transfer
    // landing in the await gap since existing was fetched would let this
    // DELETE still remove a row the caller no longer owns, and unlike
    // POST/PATCH, nothing here checked meta.changes to catch that.
    const deleted = await db.prepare(`
      DELETE FROM placed_instances
      WHERE instance_id = ?
        AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
    `).bind(route[1], existing.landlet_id, sessionBuilder.builder_id).run();
    if (deleted.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    return json({ deleted: true });
  }

  if (route.length >= 3 && route[2] === 'posts') {
    return handleSignPosts(request, db, route);
  }

  if (route.length >= 3 && route[2] === 'events') {
    return handleCalendarEvents(request, db, route);
  }

  if (route.length >= 3 && route[2] === 'backups') {
    return handleInstanceBackups(request, db, route);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'purchase') {
    return handleInstancePurchase(request, env, route[1]);
  }

  return json({ error: 'Not found' }, 404);
}

// #2050 (sub-issue of #1952): a placed instance's own configured backup/
// replacement chain -- nested under /instances/:id/backups for the same
// "never exists independent of its instance" reasoning handleSignPosts/
// handleCalendarEvents already use. Every op here is gated to the
// instance's own hosting landlet's owner (builder-facing configuration,
// not shopper-facing content) -- there's no moderation/admin path the way
// sign posts have, since nobody but the owner has any business touching
// their own backup chain.
const INSTANCE_BACKUP_WRITE_RATE_LIMIT_MAX = 200;
// #2171: every other ordered/bulk-array endpoint in this file caps its
// length explicitly (e.g. PUT /landlets/:id/instances at 250, POST
// /land-candidates/batch at 100) -- this chain had no such cap. 20 matches
// the scale of a "backup chain" feature (a handful of fallback templates
// per instance, not a bulk list).
const INSTANCE_BACKUP_CHAIN_MAX = 20;

function backupFromRow(row) {
  return {
    backupId: row.backup_id,
    instanceId: row.instance_id,
    position: row.position,
    templateId: row.template_id,
    createdAt: row.created_at,
  };
}

export async function handleInstanceBackups(request, db, route) {
  const instanceId = route[1];
  const instance = await db.prepare('SELECT instance_id, landlet_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
  if (!instance) return json({ error: 'Instance not found' }, 404);
  const sessionBuilder = await requireSessionBuilder(request, db);
  await requireOwnedLandlet(db, instance.landlet_id, sessionBuilder.builder_id);

  if (request.method === 'GET' && route.length === 3) {
    const { results } = await db.prepare(
      'SELECT * FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind(instanceId).all();
    return json({ backups: results.map(backupFromRow) });
  }

  if (request.method === 'POST' && route.length === 3) {
    await checkRateLimit(db, `instance-backup-write:${sessionBuilder.builder_id}`, INSTANCE_BACKUP_WRITE_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const templateId = stringValue(input.templateId, 'templateId');
    await assertReferenceExists(db, 'catalog_templates', 'template_id', templateId, 'templateId');
    // An early, best-effort cap check -- not itself race-free (two
    // concurrent appends can both read a count one below the max and both
    // pass), but that only risks the chain briefly exceeding
    // INSTANCE_BACKUP_CHAIN_MAX by a small amount under a genuine race, not
    // the position-collision/gap bug #2183 is about. Position itself is no
    // longer derived from this read -- see the INSERT's own subquery below.
    const tail = await db.prepare(
      'SELECT COUNT(*) AS count FROM placed_instance_backups WHERE instance_id = ?',
    ).bind(instanceId).first();
    if (tail.count >= INSTANCE_BACKUP_CHAIN_MAX) {
      throw new HttpError(`A backup chain can contain at most ${INSTANCE_BACKUP_CHAIN_MAX} entries`, 400);
    }
    const backupId = `backup-${crypto.randomUUID()}`;
    // #929/#960 idiom (see handleInstances' own POST above): requireOwnedLandlet
    // above is a point-in-time check, and the awaits since then (readJson,
    // assertReferenceExists, the cap check above) are real gaps a landlet
    // transfer could land in -- fold the ownership re-check into the write
    // itself.
    //
    // #2183: position used to come from a COUNT(*) read in a statement
    // separate from this INSERT -- two concurrent appends could both read
    // the same count and both insert at the identical position, since
    // nothing else enforces uniqueness on (instance_id, position). Appends
    // to the end of the chain -- the new entry's position is the chain's own
    // current length, not a client-supplied index -- so folding that same
    // COUNT(*) into a live subquery inside this INSERT instead closes the
    // race the same way spawnCreditOrbIfDue's own comment describes: D1/
    // SQLite serializes writes, so a second concurrent append's own
    // subquery only ever runs after the first append's INSERT has already
    // committed, and sees the incremented count. (The cap check above still
    // uses its own separate, slightly-stale read -- see that comment.)
    const created = await db.prepare(`
      INSERT INTO placed_instance_backups (backup_id, instance_id, position, template_id)
      SELECT ?, ?, (SELECT COUNT(*) FROM placed_instance_backups WHERE instance_id = ?), ?
      WHERE EXISTS (
        SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
        WHERE pi.instance_id = ? AND l.owner_builder_id IS ?
      )
    `).bind(backupId, instanceId, instanceId, templateId, instanceId, sessionBuilder.builder_id).run();
    if (created.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const row = await db.prepare('SELECT * FROM placed_instance_backups WHERE backup_id = ?').bind(backupId).first();
    // #2428: not found here means a concurrent DELETE of the hosting
    // instance (migrations/0137's own ON DELETE CASCADE on instance_id)
    // landed in the single await gap between the guarded INSERT above and
    // this re-SELECT -- a genuine 404, same race shape #2334/#2392 already
    // fixed elsewhere, not an uncaught backupFromRow(undefined) crash.
    if (!row) return json({ error: 'Placed instance backup not found' }, 404);
    return json({ backup: backupFromRow(row) }, 201);
  }

  if (request.method === 'PUT' && route.length === 3) {
    const input = await readJson(request);
    if (!Array.isArray(input.order) || input.order.some((id) => typeof id !== 'string')) {
      throw new HttpError('order must be an array of backupIds', 400);
    }
    const { results: existingRows } = await db.prepare(
      'SELECT backup_id FROM placed_instance_backups WHERE instance_id = ?',
    ).bind(instanceId).all();
    const existingIds = new Set(existingRows.map((row) => row.backup_id));
    // Requires the full current set, not a partial reorder -- a partial
    // list would leave the omitted rows' own positions ambiguous (keep
    // their old slot? shift to the end?), so the caller always resends
    // every id it already has, same as src/main.js's own full-state resync
    // idiom elsewhere in this file (e.g. handleInstances' PATCH).
    if (input.order.length !== existingIds.size || new Set(input.order).size !== existingIds.size
      || !input.order.every((id) => existingIds.has(id))) {
      throw new HttpError("order must contain exactly this instance's current backup ids, each once", 400);
    }
    await checkRateLimit(db, `instance-backup-write:${sessionBuilder.builder_id}`, INSTANCE_BACKUP_WRITE_RATE_LIMIT_MAX);
    // #2091: same #929/#960 idiom as this handler's own POST above --
    // requireOwnedLandlet at the top is a point-in-time check, and readJson/
    // the existingIds SELECT/checkRateLimit above are real awaited gaps a
    // landlet transfer could land in. Fold the ownership re-check into each
    // UPDATE itself rather than trusting the earlier check.
    const updateResults = await db.batch(input.order.map((backupId, position) => db.prepare(`
      UPDATE placed_instance_backups SET position = ?
      WHERE backup_id = ? AND instance_id = ? AND EXISTS (
        SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
        WHERE pi.instance_id = ? AND l.owner_builder_id IS ?
      )
    `).bind(position, backupId, instanceId, instanceId, sessionBuilder.builder_id)));
    if (updateResults.some((result) => result.meta.changes === 0)) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const { results } = await db.prepare(
      'SELECT * FROM placed_instance_backups WHERE instance_id = ? ORDER BY position',
    ).bind(instanceId).all();
    return json({ backups: results.map(backupFromRow) });
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const backupId = route[3];
    const existing = await db.prepare(
      'SELECT position FROM placed_instance_backups WHERE backup_id = ? AND instance_id = ?',
    ).bind(backupId, instanceId).first();
    if (!existing) return json({ error: 'Backup not found' }, 404);
    await checkRateLimit(db, `instance-backup-write:${sessionBuilder.builder_id}`, INSTANCE_BACKUP_WRITE_RATE_LIMIT_MAX);
    // #2091: same #929/#960 idiom as this handler's own POST above / the
    // identical handleSignPosts moderation-DELETE guard -- fold the
    // ownership re-check into the DELETE itself rather than trusting the
    // top-of-handler requireOwnedLandlet, which is only a point-in-time
    // check against the awaits (readJson/SELECT/checkRateLimit) since then.
    //
    // #2174/PR #2179 (landed independently, mid-investigation of this
    // issue) already wrapped this DELETE and a position-shift UPDATE in
    // one db.batch for crash-safety between the two statements -- but kept
    // the shift's threshold bound from this same early `existing.position`
    // read, just now atomically with the DELETE. That closes the single-
    // request crash window #2174 was about, but not the cross-request race
    // #2183 is about: two different concurrent deletes' *batches* still
    // just serialize as two separate transactions, each trusting its own
    // now-possibly-stale threshold. Confirmed by hand-tracing and then
    // empirically (see this file's own test): when the batch for the
    // lower position threshold commits first, the other batch's stale,
    // already-bound higher threshold stops matching rows the first batch
    // already pulled below it, leaving a gap.
    //
    // Folding a live subquery (re-deriving the target row's current
    // position by backup_id) into the shift instead makes it correct
    // regardless of commit ordering -- not the possibly-stale
    // `existing.position` this still only uses for the early 404. The
    // shift is placed first in the batch so its own subquery re-derives
    // the row's position immediately before the delete that follows it in
    // the same transaction removes it, and carries the same ownership
    // guard as the delete so an invalid/transferred-landlet request can't
    // partially shift without actually deleting anything -- the delete
    // failing (0 changes, whether from a lost ownership race or the row
    // already being gone) also makes the shift's own subquery return
    // nothing to compare against, so it naturally matches 0 rows too,
    // without needing #2179's separate NOT-EXISTS-the-row guard.
    const [, deleted] = await db.batch([
      db.prepare(`
        UPDATE placed_instance_backups SET position = position - 1
        WHERE instance_id = ? AND position > (
          SELECT position FROM placed_instance_backups WHERE backup_id = ? AND instance_id = ?
        ) AND EXISTS (
          SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
          WHERE pi.instance_id = ? AND l.owner_builder_id IS ?
        )
      `).bind(instanceId, backupId, instanceId, instanceId, sessionBuilder.builder_id),
      db.prepare(`
        DELETE FROM placed_instance_backups WHERE backup_id = ? AND instance_id = ? AND EXISTS (
          SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
          WHERE pi.instance_id = ? AND l.owner_builder_id IS ?
        )
      `).bind(backupId, instanceId, instanceId, sessionBuilder.builder_id),
    ]);
    if (deleted.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Posts on a "community sign" instance (docs/SPEC.md §6, migrations/0041) —
// nested under /instances/:id/posts rather than a top-level /sign-posts
// collection since a post never exists independent of the sign it's on,
// the same reasoning /landlets/:id/versions already follows.
//
// #1830 (owner correction, 2026-10-13): POST used to be open to any
// shopper with a free-text authorLabel and "no account to check against
// anyway" — true before #678/N44, stale since: Shop mode's own entry gate
// (ensureShopperIdentity, src/main.js) has required a real logged-in,
// verified account for a while now, this handler was just never updated
// once that changed underneath it. authorLabel is now always derived
// server-side from the posting user's own username, and sign_posts.user_id
// (migrations/0125) records who actually posted — which both the DELETE
// branch (moderation OR the post's own author now) and the new PATCH
// branch (the post's own author only) check against.
// Found via backlog audit (#337): unlike every other public, repeatable
// mutation in this file (signup, password-reset, model-upload, purchase),
// posting to a community sign requires no session and had no
// checkRateLimit call at all — an anonymous caller could post an
// unlimited number of times per second, unboundedly growing sign_posts.
// Now that posting requires a session, bucketed by the user's own id
// rather than clientIp, matching CALENDAR_EVENT_RATE_LIMIT_MAX's own
// reasoning for an action gated on a real account instead of anonymous
// requests.
const SIGN_POST_RATE_LIMIT_MAX = 20;
// #944: the DELETE branch below is an authenticated, owner-gated,
// repeatable mutation with no rate limit at all -- unlike its own POST
// sibling above (SIGN_POST_RATE_LIMIT_MAX) and this file's other owner-
// gated CRUD DELETEs (friendship-mutate, bundle-mutate).
const SIGN_POST_DELETE_RATE_LIMIT_MAX = 20;
// #1830: same missing-rate-limit gap as SIGN_POST_DELETE_RATE_LIMIT_MAX,
// for the new author-only edit branch below.
const SIGN_POST_EDIT_RATE_LIMIT_MAX = 20;

// #1718: same "a lost response looks, from here, identical to the request
// never having reached us at all" protection as calendarEventIdempotencyKey
// above (#1716) / the purchase flow's own purchaseIdempotencyKey (#473) — a
// dropped POST response and the innocent manual retry it invites would
// otherwise create a second, fully duplicate sign_posts row with the same
// authorLabel/text. Namespaced with instanceId only, not a builder id like
// those two siblings — #1830 made posting require a session, but the
// client's own cached key (src/api.js's signPostIdempotencyKey) was never
// namespaced per-poster to begin with, and the POST branch's own
// content-match check below already covers a key reused across two
// different sessions the same way it covers one reused for a genuinely
// different note. A missing or malformed key degrades to no idempotency
// protection for this one request rather than failing the post outright.
function signPostIdempotencyKey(instanceId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `post:${instanceId}:${rawKey}`;
}

export async function handleSignPosts(request, db, route) {
  const instanceId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM sign_posts WHERE instance_id = ? ORDER BY created_at DESC LIMIT 200
    `).bind(instanceId).all();
    // #356: this was ORDER BY created_at with no DESC — ascending, so once
    // a sign passed 200 posts, the LIMIT window was always the *oldest*
    // 200, permanently hiding every post made after that point (the newest
    // ones always fell outside it). Selecting DESC picks the right window
    // (always the newest 200) but .reverse() restores the response's own
    // ascending order (oldest of that window first) — rebuildSignSprites'
    // `sign.posts.slice(-SIGN_MAX_VISIBLE_POSTS)` (src/main.js) depends on
    // that ordering to grab the *most recent* posts for in-world display,
    // so only the SQL window changes, not the array's own order. A real
    // COUNT (same pattern handlePurchases already uses) lets a client tell
    // the list is truncated at all, which the old shape never exposed.
    const total = await db.prepare('SELECT COUNT(*) AS count FROM sign_posts WHERE instance_id = ?').bind(instanceId).first();
    return json({ posts: results.reverse().map(signPostFromRow), totalCount: total.count });
  }

  if (request.method === 'POST' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id, is_community_sign FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    if (!instance.is_community_sign) {
      throw new HttpError('This placed instance is not marked as a community sign', 400);
    }
    // #1830: see this function's own top-of-section comment -- Shop mode's
    // entry gate already requires exactly this (requireVerifiedSession, not
    // just requireCurrentUser), so posting here can never happen without
    // having already cleared it. Checked after the instance/flag checks
    // above, same ordering as handleCalendarEvents' own structurally
    // identical POST branch, so a request against the wrong kind of
    // instance still gets that specific 400 rather than an unrelated 401.
    const user = await requireVerifiedSession(request, db);
    await checkRateLimit(db, `sign-post:${user.user_id}`, SIGN_POST_RATE_LIMIT_MAX);
    const input = await readJson(request);
    // #1830: no longer client-supplied -- always the posting user's own
    // username, so nobody can post under a name that isn't theirs.
    const authorLabel = user.username;
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // #1718: a retry that reuses the same (validated) client-supplied key
    // finds its own already-landed row here and returns it instead of
    // inserting a second, fully duplicate post.
    // #1778: that dedup is only a legitimate hit when the found row's own
    // content actually matches this request -- the key is cached
    // client-side per instanceId (src/api.js's signPostIdempotencyKey), not
    // per attempt, so a stale key reused for a genuinely different second
    // note (the author typed something new into the same prompt() flow
    // within the cache's TTL) must not silently return the FIRST post as if
    // it were this one. On a mismatch, mint a real id instead, same as the
    // "missing/malformed key" fallback below already does.
    const idempotencyKey = signPostIdempotencyKey(instanceId, input.idempotencyKey);
    let existing = null;
    if (idempotencyKey) {
      existing = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ? AND instance_id = ?').bind(idempotencyKey, instanceId).first();
      if (existing && existing.author_label === authorLabel && existing.text === text) {
        return json({ post: signPostFromRow(existing) });
      }
    }
    const postId = (idempotencyKey && !existing) ? idempotencyKey : `post-${crypto.randomUUID()}`;
    // #1327: the is_community_sign check above is a point-in-time read, and
    // readJson is a real awaited gap after it -- without re-checking here,
    // a concurrent PATCH unflagging this instance (whose own #1022 cleanup
    // deletes every existing sign_posts row for it, specifically so a post
    // can never resurface on re-flagging) could still let this INSERT land
    // afterward, resurrecting exactly what that cleanup exists to prevent.
    // Same #929/#960 idiom as this handler's own DELETE sibling below.
    const inserted = await db.prepare(`
      INSERT INTO sign_posts (post_id, instance_id, author_label, text, user_id)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM placed_instances WHERE instance_id = ? AND is_community_sign = 1
      )
    `).bind(postId, instanceId, authorLabel, text, user.user_id, instanceId).run();
    if (inserted.meta.changes === 0) {
      throw new HttpError('This placed instance is not marked as a community sign', 400);
    }
    const row = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ?').bind(postId).first();
    // #2429: same re-SELECT race #2354 fixed for this resource's PATCH
    // sibling, never applied to this POST/create branch -- a concurrent
    // admin delete, or a concurrent PATCH unflagging is_community_sign (see
    // #1327's own comment above), can remove the row before this re-SELECT
    // runs.
    if (!row) return json({ error: 'Post not found' }, 404);
    return json({ post: signPostFromRow(row) }, 201);
  }

  if (request.method === 'PATCH' && route.length === 4) {
    const postId = route[3];
    const existing = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ? AND instance_id = ?').bind(postId, instanceId).first();
    if (!existing) return json({ error: 'Post not found' }, 404);
    // #1830: editing is author-only -- there's no moderation equivalent for
    // PATCH the way DELETE has one (a builder moderating unwanted content
    // removes it; rewriting someone else's words under their own name isn't
    // the same kind of action). A pre-#1830 post with no user_id at all
    // (user_id IS NULL) can never match here, same as DELETE's own
    // author-path below -- there's nobody on record to own it.
    const user = await requireVerifiedSession(request, db);
    if (existing.user_id === null || existing.user_id !== user.user_id) {
      throw new HttpError('Not your post', 403);
    }
    await checkRateLimit(db, `sign-post-edit:${user.user_id}`, SIGN_POST_EDIT_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // Same #929/#960 idiom as this handler's own DELETE/POST siblings --
    // the existence/ownership check above is a point-in-time read, and
    // checkRateLimit/readJson are real awaited gaps after it.
    const updated = await db.prepare('UPDATE sign_posts SET text = ? WHERE post_id = ? AND user_id = ?')
      .bind(text, postId, user.user_id).run();
    if (updated.meta.changes === 0) {
      throw new HttpError('Post changed concurrently — refetch and retry', 409);
    }
    const row = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ?').bind(postId).first();
    // #2354: meta.changes above only confirms the UPDATE matched a row at
    // the moment it ran -- a concurrent admin-override DELETE (below) can
    // still land in the real awaited gap between that UPDATE committing
    // and this re-SELECT running, same shape #2334 already fixed for
    // notifications' own PATCH.
    if (!row) return json({ error: 'Post not found' }, 404);
    return json({ post: signPostFromRow(row) });
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const postId = route[3];
    const existing = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ? AND instance_id = ?').bind(postId, instanceId).first();
    if (!existing) return json({ error: 'Post not found' }, 404);
    const instance = await db.prepare('SELECT landlet_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    // #781: an admin can remove any sign post outright (harassment, doxxing,
    // other policy violations) regardless of whether the hosting landlet's
    // own owner ever acts on it -- same "checked first, via the non-throwing
    // currentUser lookup" shape as #1712's product-review admin override,
    // since an admin isn't necessarily the post's author or the landlet owner.
    const requester = await currentUser(request, db);
    const admin = requester && requester.is_admin ? requester : null;
    if (admin) {
      await checkRateLimit(db, `sign-post-delete:${admin.user_id}`, SIGN_POST_DELETE_RATE_LIMIT_MAX);
      const deletedByAdmin = await db.prepare('DELETE FROM sign_posts WHERE post_id = ?').bind(postId).run();
      if (deletedByAdmin.meta.changes === 0) {
        throw new HttpError('Post changed concurrently — refetch and retry', 409);
      }
      await adminActionLogStatement(db, admin.user_id, 'delete_sign_post_override', 'sign_post', postId).run();
      return json({ deleted: true });
    }
    // #1830: requireSessionBuilder (not requireVerifiedSession) so this one
    // call resolves both the real user_id a post's own author needs below,
    // and the builder_id the moderation fallback below that already needs
    // -- every account is automatically a builder (getOrCreateBuilderForUser),
    // so this never fails for a session that already passed the login the
    // GET-side /instances fetch itself already required to reach this page.
    const sessionBuilder = await requireSessionBuilder(request, db);
    // The post's own author can remove it directly now that a post records
    // who made it, alongside the existing moderation path below -- either
    // should be able to remove a post: the author directly, or the sign's
    // own hosting landlet's builder for moderation. A pre-#1830 post with
    // no user_id at all (user_id IS NULL) can never match here, so it falls
    // through to the moderation path exactly as it always has.
    if (existing.user_id !== null && existing.user_id === sessionBuilder.user_id) {
      await checkRateLimit(db, `sign-post-delete:${sessionBuilder.user_id}`, SIGN_POST_DELETE_RATE_LIMIT_MAX);
      const deletedByAuthor = await db.prepare('DELETE FROM sign_posts WHERE post_id = ? AND user_id = ?')
        .bind(postId, sessionBuilder.user_id).run();
      if (deletedByAuthor.meta.changes === 0) {
        throw new HttpError('Post changed concurrently — refetch and retry', 409);
      }
      return json({ deleted: true });
    }
    // Moderation: gated to the sign's own hosting landlet's owner, same as
    // always.
    await requireOwnedLandlet(db, instance.landlet_id, sessionBuilder.builder_id);
    await checkRateLimit(db, `sign-post-delete:${sessionBuilder.builder_id}`, SIGN_POST_DELETE_RATE_LIMIT_MAX);
    // #960: requireOwnedLandlet above is a point-in-time check, and
    // checkRateLimit is a real awaited write in between -- without this,
    // an auction resolving (transferring ownership) in that gap would let
    // this DELETE still moderate content on a landlet the caller no longer
    // owns, with no trace. Same #929 idiom as handleInstances' own single
    // DELETE.
    const deleted = await db.prepare(`
      DELETE FROM sign_posts WHERE post_id = ?
        AND EXISTS (
          SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
          WHERE pi.instance_id = ? AND l.owner_builder_id IS ?
        )
    `).bind(postId, instanceId, sessionBuilder.builder_id).run();
    if (deleted.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

export function signPostFromRow(row) {
  return {
    postId: row.post_id,
    instanceId: row.instance_id,
    authorLabel: row.author_label,
    text: row.text,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

// Events on a "community calendar" instance (docs/SPEC.md §6,
// migrations/0042) — nested under /instances/:id/events for the same
// "never exists independent of its instance" reasoning handleSignPosts
// above uses, and the same moderation-gated-to-the-hosting-landlet's-owner
// DELETE — but POST is deliberately NOT structurally identical to
// handleSignPosts: docs/SPEC.md §6 explicitly calls calendar events
// "builder-authored," unlike sign posts' "shopper-authored" free-text
// authorLabel. Only the hosting landlet's own owner may post one, and
// authorLabel comes from their real builder profile, not client input —
// otherwise anyone could post a "confetti-cannon" trigger (or any other
// event) on someone else's shop under that builder's own name.
// Found via backlog audit: unlike every other repeatable write in this
// file — including the structurally near-identical sign-post POST above
// (SIGN_POST_RATE_LIMIT_MAX, itself found via #337 for this exact class
// of gap) and friend requests (FRIEND_REQUEST_RATE_LIMIT_MAX) — posting a
// calendar event had no checkRateLimit call at all, letting an
// authenticated landlet owner insert unlimited calendar_events rows in a
// tight loop. Bucketed by builder id, not IP, since this is an
// authenticated action gating a real account's own request volume (same
// reasoning FRIEND_REQUEST_RATE_LIMIT_MAX's own comment gives).
const CALENDAR_EVENT_RATE_LIMIT_MAX = 20;
// #944: same missing-rate-limit gap as SIGN_POST_DELETE_RATE_LIMIT_MAX,
// found in this handler's own DELETE branch.
const CALENDAR_EVENT_DELETE_RATE_LIMIT_MAX = 20;
// #1023: the /trigger branch below is intentionally unauthenticated (any
// client racing to fire a due event, not just its landlet's owner) and
// idempotent, but every call still does at least one SELECT, and a winning
// call an UPDATE plus a re-SELECT -- real D1 load with no cap, the one
// remaining public repeatable mutation in this file with no checkRateLimit
// call at all. Bucketed by IP like SIGN_POST_RATE_LIMIT_MAX, since this
// route is unauthenticated like sign posts, not owner-gated like the POST
// above.
const EVENT_TRIGGER_RATE_LIMIT_MAX = 20;
// #1975: same missing-rate-limit gap as CALENDAR_EVENT_DELETE_RATE_LIMIT_MAX,
// for the new author-only edit branch below.
const CALENDAR_EVENT_EDIT_RATE_LIMIT_MAX = 20;

// #1716: same "a lost response looks, from here, identical to the request
// never having reached us at all" protection as the purchase flow's own
// purchaseIdempotencyKey above (#473) — a dropped POST response and the
// innocent manual retry it invites would otherwise create a second, fully
// duplicate calendar_events row that independently re-fires
// handleCalendarEventTrigger's own one-shot effect (that function is only
// idempotent per event_id, not per logical event). Namespaced with both
// instanceId and the calling builder id, same as purchaseIdempotencyKey's
// own #974 fix, so a key can never collide across two different calendars
// or (after an ownership transfer) two different owners. A missing or
// malformed key degrades to no idempotency protection for this one request
// rather than failing the create outright.
function calendarEventIdempotencyKey(instanceId, builderId, rawKey) {
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(rawKey)) return undefined;
  return `event:${instanceId}:${builderId}:${rawKey}`;
}

export async function handleCalendarEvents(request, db, route) {
  const instanceId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM calendar_events WHERE instance_id = ? ORDER BY created_at DESC LIMIT 200
    `).bind(instanceId).all();
    // #356: same ascending-window/no-count gap as handleSignPosts above,
    // fixed the same way — DESC for the right LIMIT window, .reverse() to
    // keep the response ascending (calendar.events.slice(-SIGN_MAX_VISIBLE_POSTS)
    // in src/main.js depends on that order too).
    const total = await db.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE instance_id = ?').bind(instanceId).first();
    return json({ events: results.reverse().map(calendarEventFromRow), totalCount: total.count });
  }

  if (request.method === 'POST' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id, is_community_calendar, landlet_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    if (!instance.is_community_calendar) {
      throw new HttpError('This placed instance is not marked as a community calendar', 400);
    }
    const sessionBuilder = await requireSessionBuilder(request, db);
    await requireOwnedLandlet(db, instance.landlet_id, sessionBuilder.builder_id);
    await checkRateLimit(db, `calendar-event:${sessionBuilder.builder_id}`, CALENDAR_EVENT_RATE_LIMIT_MAX);
    const input = await readJson(request);
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // scheduledAt is optional — most events are just a plain announcement
    // (docs/SPEC.md §6's "event postings"), with a real one-shot trigger
    // moment (the spec's own "confetti-cannon" example) an explicit extra
    // step, not the default.
    const scheduledAt = input.scheduledAt === undefined || input.scheduledAt === null
      ? null
      : isoDateString(input.scheduledAt, 'scheduledAt');
    // #1716: a retry that reuses the same (validated) client-supplied key
    // finds its own already-landed row here and returns it instead of
    // inserting a second, fully duplicate event.
    // #1751: that dedup is only a legitimate hit when the found row's own
    // content actually matches this request -- the key is cached client-side
    // per instanceId (src/api.js's calendarEventIdempotencyKey), not per
    // attempt, so a stale key reused for a genuinely different second event
    // (the author typed something new into the same prompt() flow within
    // the cache's TTL) must not silently return the FIRST event as if it
    // were this one. On a mismatch, mint a real id instead, same as the
    // "missing/malformed key" fallback below already does.
    const idempotencyKey = calendarEventIdempotencyKey(instanceId, sessionBuilder.builder_id, input.idempotencyKey);
    let existing = null;
    if (idempotencyKey) {
      existing = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ?').bind(idempotencyKey).first();
      if (existing && existing.text === text && existing.scheduled_at === scheduledAt) {
        return json({ event: calendarEventFromRow(existing) });
      }
    }
    const eventId = (idempotencyKey && !existing) ? idempotencyKey : `event-${crypto.randomUUID()}`;
    // #1327: both the is_community_calendar check and requireOwnedLandlet
    // above are point-in-time reads, with real awaited gaps (readJson,
    // checkRateLimit) after them -- without re-checking both here, a
    // concurrent PATCH unflagging this instance (whose own #1022 cleanup
    // deletes every existing calendar_events row for it, specifically so an
    // event can never resurface on re-flagging) or a landlet ownership
    // change (auction resolution, admin reassignment) could still let this
    // INSERT land afterward. Same #929/#960 idiom as this handler's own
    // DELETE sibling below.
    const inserted = await db.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text, scheduled_at, user_id)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
        WHERE pi.instance_id = ? AND pi.is_community_calendar = 1 AND l.owner_builder_id IS ?
      )
    `).bind(eventId, instanceId, sessionBuilder.label, text, scheduledAt, sessionBuilder.user_id, instanceId, sessionBuilder.builder_id).run();
    if (inserted.meta.changes === 0) {
      const current = await db.prepare('SELECT is_community_calendar FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
      if (!current?.is_community_calendar) {
        throw new HttpError('This placed instance is not marked as a community calendar', 400);
      }
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    const row = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ?').bind(eventId).first();
    // #2429: same re-SELECT race #2354 fixed for this resource's PATCH
    // sibling, never applied to this POST/create branch -- a concurrent
    // admin delete, or a concurrent PATCH unflagging is_community_calendar,
    // can remove the row before this re-SELECT runs.
    if (!row) return json({ error: 'Event not found' }, 404);
    return json({ event: calendarEventFromRow(row) }, 201);
  }

  if (request.method === 'PATCH' && route.length === 4) {
    const eventId = route[3];
    const existing = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ? AND instance_id = ?').bind(eventId, instanceId).first();
    if (!existing) return json({ error: 'Event not found' }, 404);
    // #1975: editing is author-only -- same reasoning as sign posts' own
    // PATCH (#1830): there's no moderation equivalent for rewriting
    // someone else's words under their own name. In the ordinary case the
    // event's author already IS the hosting landlet's current owner (POST
    // requires it), but this uses the event's own recorded user_id rather
    // than re-checking landlet ownership, so the original author keeps
    // editing rights even after the landlet changes hands (auction, admin
    // reassignment) -- the same guarantee sign posts/product reviews give.
    // A pre-#1975 event with no user_id at all (user_id IS NULL) can never
    // match here, same as DELETE's own author-path below.
    const sessionBuilder = await requireSessionBuilder(request, db);
    if (existing.user_id === null || existing.user_id !== sessionBuilder.user_id) {
      throw new HttpError('Not your event', 403);
    }
    await checkRateLimit(db, `calendar-event-edit:${sessionBuilder.user_id}`, CALENDAR_EVENT_EDIT_RATE_LIMIT_MAX);
    const input = await readJson(request);
    let text = existing.text;
    if (input.text !== undefined) {
      text = stringValue(input.text, 'text');
      if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    }
    let scheduledAt = existing.scheduled_at;
    if ('scheduledAt' in input) {
      scheduledAt = input.scheduledAt === undefined || input.scheduledAt === null
        ? null
        : isoDateString(input.scheduledAt, 'scheduledAt');
    }
    // A changed scheduledAt re-arms the one-shot trigger (#270) -- this is
    // logically a different scheduled moment, the same "genuinely
    // different event" distinction #1751's own idempotency-key content
    // match already draws, so it shouldn't stay permanently inert just
    // because some earlier scheduledAt on this same row already fired.
    const triggeredAt = scheduledAt === existing.scheduled_at ? existing.triggered_at : null;
    const updated = await db.prepare('UPDATE calendar_events SET text = ?, scheduled_at = ?, triggered_at = ? WHERE event_id = ? AND user_id = ?')
      .bind(text, scheduledAt, triggeredAt, eventId, sessionBuilder.user_id).run();
    if (updated.meta.changes === 0) {
      throw new HttpError('Event changed concurrently — refetch and retry', 409);
    }
    // #2122: logged only after the update is confirmed to have actually
    // happened, same "logged only after confirmed" idiom the
    // delete_calendar_event_override admin branch below uses.
    await recordContentEditHistory(db, 'calendar_events', eventId, 'edit', existing, sessionBuilder.user_id);
    const row = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ?').bind(eventId).first();
    // #2354: same concurrent-admin-override-DELETE race #2334 already
    // fixed for notifications' own PATCH -- the meta.changes check above
    // only confirms the UPDATE itself matched, not that the row still
    // exists by the time this re-SELECT runs.
    if (!row) return json({ error: 'Event not found' }, 404);
    return json({ event: calendarEventFromRow(row) });
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const eventId = route[3];
    const existing = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ? AND instance_id = ?').bind(eventId, instanceId).first();
    if (!existing) return json({ error: 'Event not found' }, 404);
    // #781: an admin can remove any calendar event outright, same reasoning
    // and shape as the sign-posts admin override above.
    const requester = await currentUser(request, db);
    const admin = requester && requester.is_admin ? requester : null;
    if (admin) {
      await checkRateLimit(db, `calendar-event-delete:${admin.user_id}`, CALENDAR_EVENT_DELETE_RATE_LIMIT_MAX);
      const deletedByAdmin = await db.prepare('DELETE FROM calendar_events WHERE event_id = ?').bind(eventId).run();
      if (deletedByAdmin.meta.changes === 0) {
        throw new HttpError('Event changed concurrently — refetch and retry', 409);
      }
      await adminActionLogStatement(db, admin.user_id, 'delete_calendar_event_override', 'calendar_event', eventId).run();
      return json({ deleted: true });
    }
    // Same moderation gate as sign posts above — the calendar's own hosting
    // landlet's owner, not the event's free-text author.
    const instance = await db.prepare('SELECT landlet_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    const sessionBuilder = await requireSessionBuilder(request, db);
    // #1975: the event's own author can remove it directly, independent of
    // current landlet ownership -- same reasoning as the new PATCH branch
    // above. A pre-#1975 event with no user_id at all (user_id IS NULL)
    // can never match here, so it falls through to the moderation path
    // exactly as it always has.
    if (existing.user_id !== null && existing.user_id === sessionBuilder.user_id) {
      await checkRateLimit(db, `calendar-event-delete:${sessionBuilder.user_id}`, CALENDAR_EVENT_DELETE_RATE_LIMIT_MAX);
      const deletedByAuthor = await db.prepare('DELETE FROM calendar_events WHERE event_id = ? AND user_id = ?')
        .bind(eventId, sessionBuilder.user_id).run();
      if (deletedByAuthor.meta.changes === 0) {
        throw new HttpError('Event changed concurrently — refetch and retry', 409);
      }
      // #2122: logged only after the delete is confirmed to have actually
      // happened, same reasoning as the PATCH branch above.
      await recordContentEditHistory(db, 'calendar_events', eventId, 'delete', existing, sessionBuilder.user_id);
      return json({ deleted: true });
    }
    await requireOwnedLandlet(db, instance.landlet_id, sessionBuilder.builder_id);
    await checkRateLimit(db, `calendar-event-delete:${sessionBuilder.builder_id}`, CALENDAR_EVENT_DELETE_RATE_LIMIT_MAX);
    // #960: same #929 idiom as the sign-posts DELETE above -- see its own
    // comment.
    const deleted = await db.prepare(`
      DELETE FROM calendar_events WHERE event_id = ?
        AND EXISTS (
          SELECT 1 FROM placed_instances pi JOIN landlets l ON l.landlet_id = pi.landlet_id
          WHERE pi.instance_id = ? AND l.owner_builder_id IS ?
        )
    `).bind(eventId, instanceId, sessionBuilder.builder_id).run();
    if (deleted.meta.changes === 0) {
      throw new HttpError('Landlet changed concurrently — refetch and retry', 409);
    }
    return json({ deleted: true });
  }

  // The one-shot creative-tool trigger itself (docs/API.md's "Community
  // calendar" — "scheduled confetti-cannon trigger"). Route:
  // /instances/:instanceId/events/:eventId/trigger, i.e. route =
  // ['instances', instanceId, 'events', eventId, 'trigger'] — route[3] is
  // the eventId here, one level deeper than DELETE's own route[3] above
  // (which IS the eventId for a 4-element route; this is a 5-element one).
  // Idempotent, like the auction resolve endpoint: calling it before
  // scheduledAt, on an event with no scheduledAt at all, or on one
  // already triggered is never an error, just a no-op — `triggered` in
  // the response tells the caller whether *this* call was the one that
  // actually fired it, since only that caller should play the effect
  // locally.
  if (request.method === 'POST' && route.length === 5 && route[4] === 'trigger') {
    return handleCalendarEventTrigger(request, db, instanceId, route[3]);
  }

  return json({ error: 'Not found' }, 404);
}

export async function handleCalendarEventTrigger(request, db, instanceId, eventId) {
  await checkRateLimit(db, `event-trigger:${clientIp(request)}`, EVENT_TRIGGER_RATE_LIMIT_MAX);
  const event = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ? AND instance_id = ?').bind(eventId, instanceId).first();
  if (!event) return json({ error: 'Event not found' }, 404);
  if (!event.scheduled_at || event.triggered_at || event.scheduled_at > new Date().toISOString()) {
    return json({ event: calendarEventFromRow(event), triggered: false });
  }
  // #270: the WHERE ... triggered_at IS NULL guard is what makes this safe
  // against a race (two callers both passing the earlier check at once) —
  // but only whichever UPDATE actually lands first changes any rows. A
  // losing caller's own UPDATE affects zero rows, yet a later re-SELECT
  // would still see the winner's non-null triggered_at and wrongly report
  // triggered: true too. Reading the result of this exact UPDATE (rather
  // than re-querying) is what actually distinguishes the one winner from
  // every loser.
  const result = await db.prepare(`
    UPDATE calendar_events SET triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE event_id = ? AND triggered_at IS NULL
  `).bind(eventId).run();
  const updated = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ?').bind(eventId).first();
  return json({ event: calendarEventFromRow(updated), triggered: result.meta.changes === 1 });
}

export function calendarEventFromRow(row) {
  return {
    eventId: row.event_id,
    instanceId: row.instance_id,
    authorLabel: row.author_label,
    text: row.text,
    scheduledAt: row.scheduled_at,
    triggeredAt: row.triggered_at,
    createdAt: row.created_at,
    userId: row.user_id,
  };
}
