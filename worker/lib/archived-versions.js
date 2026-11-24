// #4094 (part of #4075): a builder's own archived lándlet versions.
//
// When a lándlet is released by the no-bid inactivity path its versions are not deleted: they move to
// archived_landlet_versions/archived_version_instances, keyed to the builder (migrations/0140), and until
// now only the data export could read them. Two routes, both for the signed-in builder only:
//
//   GET  /api/builders/me/archived-versions                         the list, newest first
//   POST /api/builders/me/archived-versions/:versionId/restore      { landletId } copies one onto a lándlet
//                                                                   the caller owns, as a NEW saved version
//
// A restore never touches the live draft or the active version: it adds one more entry to the lándlet's
// version history, which the existing "Restore to Editor" / "Set Live" then work on, with their own
// confirmation. Another builder's archived version is a plain 404 (nothing says it exists).
import { json, HttpError, ERROR_CODES } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { readJson, stringValue, queryLimit } from './validation.js';
import { requireSessionBuilder, assertOwner } from './auth.js';
import { requireLandlet, getVersion, archivedVersionFromRow } from '../index.js';

// The same per-builder bucket POST .../versions uses: each restore duplicates every item into a new snapshot.
const ARCHIVED_RESTORE_RATE_LIMIT_MAX = 20;
const RESTORED_NAME_MAX = 100;

export async function handleArchivedVersions(request, db, route, url) {
  const sessionBuilder = await requireSessionBuilder(request, db);
  const builderId = sessionBuilder.builder_id;

  if (request.method === 'GET' && route.length === 3) {
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const { results } = await db.prepare(`
      SELECT v.*, COUNT(i.source_instance_id) AS instance_count
      FROM archived_landlet_versions v
      LEFT JOIN archived_version_instances i ON i.version_id = v.version_id
      WHERE v.builder_id = ?
      GROUP BY v.version_id
      ORDER BY v.created_at DESC, v.version_id
      LIMIT ?
    `).bind(builderId, limit).all();
    return json({ archivedVersions: results.map(archivedVersionFromRow) });
  }

  if (request.method === 'POST' && route.length === 5 && route[4] === 'restore') {
    const input = await readJson(request);
    const landletId = stringValue(input.landletId, 'landletId');
    const landlet = await requireLandlet(db, landletId);
    assertOwner(landlet.owner_builder_id, builderId, 'Not your lándlet');
    const archived = await db.prepare(`
      SELECT * FROM archived_landlet_versions WHERE version_id = ? AND builder_id = ?
    `).bind(route[3], builderId).first();
    if (!archived) return json({ error: 'Archived version not found' }, 404);
    await checkRateLimit(db, `landlet-version:${builderId}`, ARCHIVED_RESTORE_RATE_LIMIT_MAX);

    const versionId = crypto.randomUUID();
    const name = `Restored: ${archived.name}`.slice(0, RESTORED_NAME_MAX);
    const metadata = JSON.stringify({ restoredFromArchivedVersionId: archived.version_id });
    // The same guarded batch POST .../versions uses: a leading no-op that re-pins the owner, and the same
    // ownership condition folded into each write, since D1 runs every statement of a batch regardless.
    const results = await db.batch([
      db.prepare(`
        UPDATE landlets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ? AND owner_builder_id IS ?
      `).bind(landletId, builderId),
      db.prepare(`
        INSERT INTO landlet_versions (version_id, landlet_id, version_number, name, metadata_json)
        SELECT ?, ?, next_version_number, ?, ?
        FROM (
          SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number
          FROM landlet_versions WHERE landlet_id = ?
        )
        WHERE EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
      `).bind(versionId, landletId, name, metadata, landletId, landletId, builderId),
      db.prepare(`
        INSERT INTO version_instances
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id, bundle_id)
        SELECT ?, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar, group_id, bundle_id
        FROM archived_version_instances WHERE version_id = ?
          AND EXISTS (SELECT 1 FROM landlets WHERE landlet_id = ? AND owner_builder_id IS ?)
      `).bind(versionId, archived.version_id, landletId, builderId),
    ]);
    if (results[0].meta.changes === 0) {
      throw new HttpError('Lándlet changed concurrently — refetch and retry', 409, { code: ERROR_CODES.CHANGED_CONCURRENTLY });
    }
    return json({ version: await getVersion(db, landletId, versionId) }, 201);
  }

  return json({ error: 'Not found' }, 404);
}
