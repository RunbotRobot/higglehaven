// #4094 (part of #4075): a builder lists their archived lándlet versions and restores one onto their own
// lándlet as a new saved version. Another builder's archived version is a 404, the draft and the active
// version are never touched, and an unclaimed lándlet cannot be restored onto.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin, createGreenbeltLandletAs } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('archived-versions-admin');
  adminSession = admin.session;
  await env.DB.prepare(`
    INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, price_cents)
    VALUES ('archived-versions-brick', 'Archived Brick', 'building', '#aa5533', 1, 1, 1, 100)
  `).run();
});

async function claimedLandlet(owner, landletId) {
  await createGreenbeltLandletAs(adminSession, landletId);
  const claimed = await api(`/landlets/${landletId}/claim`, owner.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
}

async function archive(builderId, versionId, items = 3, name = 'Old wall') {
  await env.DB.prepare(`
    INSERT INTO archived_landlet_versions (version_id, builder_id, source_landlet_id, version_number, name, metadata_json, created_at)
    VALUES (?, ?, NULL, 1, ?, '{}', '2026-11-01T00:00:00.000Z')
  `).bind(versionId, builderId, name).run();
  for (let i = 0; i < items; i += 1) {
    await env.DB.prepare(`
      INSERT INTO archived_version_instances (version_id, source_instance_id, template_id, x_m, y_m, z_m)
      VALUES (?, ?, 'archived-versions-brick', ?, 0, 0)
    `).bind(versionId, `${versionId}-item-${i}`, i).run();
  }
}

describe('archived lándlet versions (#4094)', () => {
  it('lists only the signed-in builder\'s own archived versions, with their item counts', async () => {
    const owner = await signupBuilder('archived-list-owner');
    const other = await signupBuilder('archived-list-other');
    await archive(owner.builderId, 'archived-list-mine', 3);
    await archive(other.builderId, 'archived-list-theirs', 2);

    const mine = await api('/builders/me/archived-versions', owner.session());
    expect(mine.response.status).toBe(200);
    expect(mine.body.archivedVersions.map((v) => v.versionId)).toEqual(['archived-list-mine']);
    expect(mine.body.archivedVersions[0]).toMatchObject({ name: 'Old wall', instanceCount: 3 });
  });

  it('needs a signed-in builder', async () => {
    const result = await api('/builders/me/archived-versions');
    expect(result.response.status).toBe(401);
  });

  it('restores onto the builder\'s own lándlet as a new saved version, touching neither the draft nor the live version', async () => {
    const owner = await signupBuilder('archived-restore-owner');
    await claimedLandlet(owner, 'archived-restore-landlet');
    await archive(owner.builderId, 'archived-restore-version', 3);
    const before = await api('/landlets/archived-restore-landlet', owner.session());

    const restored = await api('/builders/me/archived-versions/archived-restore-version/restore', owner.session({
      method: 'POST', body: JSON.stringify({ landletId: 'archived-restore-landlet' }),
    }));
    expect(restored.response.status).toBe(201);
    expect(restored.body.version).toMatchObject({ landletId: 'archived-restore-landlet', versionNumber: 1, name: 'Restored: Old wall', instanceCount: 3 });
    expect(restored.body.version.metadata.restoredFromArchivedVersionId).toBe('archived-restore-version');

    const detail = await api(`/landlets/archived-restore-landlet/versions/${restored.body.version.versionId}`);
    expect(detail.body.version.instances.map((i) => i.x).sort()).toEqual([0, 1, 2]);
    // The draft is untouched, and the live pointer did not move.
    const draft = await env.DB.prepare('SELECT COUNT(*) AS n FROM placed_instances WHERE landlet_id = ?').bind('archived-restore-landlet').first();
    expect(draft.n).toBe(0);
    const after = await api('/landlets/archived-restore-landlet', owner.session());
    expect(after.body.landlet.activeVersionId).toEqual(before.body.landlet.activeVersionId);
    // The archive itself is kept.
    const archived = await env.DB.prepare('SELECT COUNT(*) AS n FROM archived_version_instances WHERE version_id = ?').bind('archived-restore-version').first();
    expect(archived.n).toBe(3);
  });

  it('another builder cannot restore it: a 404, and nothing is copied', async () => {
    const owner = await signupBuilder('archived-steal-owner');
    const thief = await signupBuilder('archived-steal-thief');
    await claimedLandlet(thief, 'archived-steal-landlet');
    await archive(owner.builderId, 'archived-steal-version', 2);

    const result = await api('/builders/me/archived-versions/archived-steal-version/restore', thief.session({
      method: 'POST', body: JSON.stringify({ landletId: 'archived-steal-landlet' }),
    }));
    expect(result.response.status).toBe(404);
    const versions = await api('/landlets/archived-steal-landlet/versions');
    expect(versions.body.versions).toEqual([]);
  });

  it('cannot restore onto a lándlet the builder does not own', async () => {
    const owner = await signupBuilder('archived-notmine-owner');
    const neighbour = await signupBuilder('archived-notmine-neighbour');
    await claimedLandlet(neighbour, 'archived-notmine-landlet');
    await archive(owner.builderId, 'archived-notmine-version', 1);

    const result = await api('/builders/me/archived-versions/archived-notmine-version/restore', owner.session({
      method: 'POST', body: JSON.stringify({ landletId: 'archived-notmine-landlet' }),
    }));
    expect(result.response.status).toBe(403);
    const versions = await api('/landlets/archived-notmine-landlet/versions');
    expect(versions.body.versions).toEqual([]);
  });
});
