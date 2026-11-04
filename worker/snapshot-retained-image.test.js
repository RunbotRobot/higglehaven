// #3058: the retained product image of a still-pending suspended-seller
// snapshot (suspended_seller_instance_snapshots.template_image_url,
// migrations/0175) must survive the R2 orphan sweep and the admin
// single-object delete, even when no live row holds the same URL any more.
// Once the builder clears the slot (or it restores), the image is no longer
// retained and is sweepable again.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupUnreferencedModels } from './lib/models.js';
import { api, glbFile, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('snapshot-retained-image-admin');
  adminSession = admin.session;
});

async function uploadModel(marker) {
  const form = new FormData();
  form.set('file', glbFile({ json: `{"snapshotRetainedImage":"${marker}"}` }));
  const upload = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
  expect(upload.status).toBe(201);
  return (await upload.json()).modelUrl;
}

async function insertSnapshot(snapshotId, imageUrl) {
  await env.DB.prepare(`
    INSERT INTO suspended_seller_instance_snapshots
      (snapshot_id, seller_id, builder_id, landlet_id, template_id, instance_json, template_image_url)
    VALUES (?, 'sri-seller', 'sri-builder', 'sri-landlet', 'sri-template', '{}', ?)
  `).bind(snapshotId, imageUrl).run();
}

describe('retained snapshot images and the R2 orphan sweep (#3058)', () => {
  it('keeps a pending snapshot-only image out of the sweep, the listing delete flag, and the direct delete', async () => {
    const modelUrl = await uploadModel('pending');
    await insertSnapshot('sri-pending', modelUrl);

    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: true, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).not.toContain(modelUrl);

    const listing = await api('/models?limit=100', adminSession());
    expect(listing.body.models).toContainEqual(expect.objectContaining({
      modelUrl,
      referencedBySuspendedSnapshotIds: ['sri-pending'],
      deletable: false,
    }));

    const directDelete = await SELF.fetch(`https://higglehaven.test${modelUrl}`, adminSession({ method: 'DELETE' }));
    expect(directDelete.status).toBe(409);
    expect((await SELF.fetch(`https://higglehaven.test${modelUrl}`)).status).toBe(200);
  });

  it('releases the image once the builder has cleared the slot', async () => {
    const modelUrl = await uploadModel('cleared');
    await insertSnapshot('sri-cleared', modelUrl);
    await env.DB.prepare(
      "UPDATE suspended_seller_instance_snapshots SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE snapshot_id = ?",
    ).bind('sri-cleared').run();

    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: true, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).toContain(modelUrl);

    const directDelete = await SELF.fetch(`https://higglehaven.test${modelUrl}`, adminSession({ method: 'DELETE' }));
    expect(directDelete.status).toBe(200);
  });
});
