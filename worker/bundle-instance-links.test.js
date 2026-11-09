// #3327 (leaf 4/7 of #3323, "groups and bundles become one feature"): a placed
// bundle instance (the rows sharing one group_id) can be *linked* to the saved
// bundle it came from (placed_instances.bundle_id, migrations/0210). Covers
// who sets the link (POST /api/instances/group with `bundleId`: Save Bundle and
// placing from the picker), what never does (plain Group, paste), what clears
// it (Ungroup, grouping again), how snapshots and restores carry it, the
// creator-only PATCH /api/bundles/:id `items`, and what a template delete
// leaves behind. See docs/API.md's "POST /api/instances/group".
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupBuilder, createGreenbeltLandletAs,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('bil-shared-admin');
  adminSession = admin.session;
});

// One builder per landlet (a builder owns one claimed landlet at a time).
async function builderWithLandlet(label) {
  const builder = await signupBuilder(`bil-${label}`);
  const landletId = `bil-${label}-landlet`;
  await createGreenbeltLandletAs(adminSession, landletId);
  const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
  let nextX = 0;
  const place = async (instanceId) => {
    const x = nextX;
    nextX += 1;
    const created = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId: 'placeholder-tree', x, y: 0 }),
    }));
    expect(created.response.status).toBe(201);
    return created.body.instance;
  };
  return { builder, landletId, place };
}

async function createBundleAs(builder, overrides = {}) {
  const created = await api('/bundles', builder.session({
    method: 'POST',
    body: JSON.stringify({
      name: 'Link fixture',
      items: [{ templateId: 'placeholder-tree', dx: 0, dy: 0, dz: 0 }, { templateId: 'placeholder-tree', dx: 1, dy: 0, dz: 0 }],
      ...overrides,
    }),
  }));
  expect(created.response.status).toBe(201);
  return created.body.bundle;
}

async function group(builder, instanceIds, bundleId) {
  return api('/instances/group', builder.session({
    method: 'POST',
    body: JSON.stringify(bundleId ? { instanceIds, bundleId } : { instanceIds }),
  }));
}

const bundleIdOf = async (instanceId) => (await api(`/instances/${instanceId}`)).body.instance.bundleId;

describe('linking a placed bundle instance to its saved bundle (#3327)', () => {
  it('Save Bundle: grouping the saved-from instances with the bundle id links every member and round-trips on GET', async () => {
    const { builder, place } = await builderWithLandlet('save');
    await place('bil-save-1');
    await place('bil-save-2');
    const bundle = await createBundleAs(builder);

    const linked = await group(builder, ['bil-save-1', 'bil-save-2'], bundle.bundleId);
    expect(linked.response.status).toBe(201);
    expect(linked.body.bundleId).toBe(bundle.bundleId);
    expect(linked.body.instances.every((instance) => instance.bundleId === bundle.bundleId)).toBe(true);
    expect(await bundleIdOf('bil-save-1')).toBe(bundle.bundleId);
    expect(await bundleIdOf('bil-save-2')).toBe(bundle.bundleId);
  });

  it('placing from the picker: another builder links a placement to a shared bundle, not to a private one', async () => {
    const creator = await builderWithLandlet('place-creator');
    const placer = await builderWithLandlet('place-placer');
    const privateBundle = await createBundleAs(creator.builder, { name: 'Private set' });
    const sharedBundle = await createBundleAs(creator.builder, { name: 'Shared set', shared: true });
    await placer.place('bil-place-1');
    await placer.place('bil-place-2');

    // A private bundle that is someone else's is "not found" (no probing).
    const refused = await group(placer.builder, ['bil-place-1', 'bil-place-2'], privateBundle.bundleId);
    expect(refused.response.status).toBe(404);
    expect(await bundleIdOf('bil-place-1')).toBe(null);
    const missing = await group(placer.builder, ['bil-place-1', 'bil-place-2'], 'bundle-does-not-exist');
    expect(missing.response.status).toBe(404);

    const linked = await group(placer.builder, ['bil-place-1', 'bil-place-2'], sharedBundle.bundleId);
    expect(linked.response.status).toBe(201);
    expect(await bundleIdOf('bil-place-1')).toBe(sharedBundle.bundleId);
    expect(await bundleIdOf('bil-place-2')).toBe(sharedBundle.bundleId);
  });

  it('a plain Group is an unlinked bundle instance, and grouping linked members again clears their link', async () => {
    const { builder, place } = await builderWithLandlet('regroup');
    await place('bil-regroup-1');
    await place('bil-regroup-2');
    await place('bil-regroup-3');
    const bundle = await createBundleAs(builder);

    const plain = await group(builder, ['bil-regroup-1', 'bil-regroup-2']);
    expect(plain.body.bundleId).toBe(null);
    expect(await bundleIdOf('bil-regroup-1')).toBe(null);

    await group(builder, ['bil-regroup-1', 'bil-regroup-2'], bundle.bundleId);
    expect(await bundleIdOf('bil-regroup-2')).toBe(bundle.bundleId);

    // Merging the linked pair with a third item is a new, unsaved bundle instance.
    const merged = await group(builder, ['bil-regroup-1', 'bil-regroup-2', 'bil-regroup-3']);
    expect(merged.response.status).toBe(201);
    for (const id of ['bil-regroup-1', 'bil-regroup-2', 'bil-regroup-3']) expect(await bundleIdOf(id)).toBe(null);
  });

  it('Ungroup dissolves the link with the group', async () => {
    const { builder, place } = await builderWithLandlet('ungroup');
    await place('bil-ungroup-1');
    await place('bil-ungroup-2');
    const bundle = await createBundleAs(builder);
    const linked = await group(builder, ['bil-ungroup-1', 'bil-ungroup-2'], bundle.bundleId);
    const ungrouped = await api('/instances/ungroup', builder.session({
      method: 'POST', body: JSON.stringify({ groupId: linked.body.groupId }),
    }));
    expect(ungrouped.response.status).toBe(200);
    const row = await env.DB.prepare('SELECT group_id, bundle_id FROM placed_instances WHERE instance_id = ?').bind('bil-ungroup-1').first();
    expect(row).toEqual({ group_id: null, bundle_id: null });
  });

  it('paste never links: a plain batch create is unlinked, and a claimed link is ignored unless the live group already has it', async () => {
    const { builder, landletId, place } = await builderWithLandlet('paste');
    await place('bil-paste-1');
    await place('bil-paste-2');
    const bundle = await createBundleAs(builder);
    const other = await createBundleAs(builder, { name: 'Another set' });
    const linked = await group(builder, ['bil-paste-1', 'bil-paste-2'], bundle.bundleId);
    const createCopy = async (instanceId, extra) => {
      const created = await api('/instances/batch', builder.session({
        method: 'POST',
        body: JSON.stringify({ instances: [{ instanceId, landletId, templateId: 'placeholder-tree', x: 9, y: 3, ...extra }] }),
      }));
      expect(created.response.status).toBe(201);
      return created.body.instances[0];
    };

    // A copy/paste carries neither id.
    expect((await createCopy('bil-paste-copy-1', {})).bundleId).toBe(null);
    // A bundleId with no group, or with a group that is not linked to it, is dropped.
    expect((await createCopy('bil-paste-copy-2', { bundleId: bundle.bundleId })).bundleId).toBe(null);
    // Delete+Undo of a linked member: the exact pair of a live group is restored.
    const restored = await createCopy('bil-paste-copy-4', { groupId: linked.body.groupId, bundleId: bundle.bundleId });
    expect(restored.groupId).toBe(linked.body.groupId);
    expect(restored.bundleId).toBe(bundle.bundleId);
    // A pair that does not match the live group's link is stored unlinked.
    const wrong = await createCopy('bil-paste-copy-3', { groupId: linked.body.groupId, bundleId: other.bundleId });
    expect(wrong.groupId).toBe(linked.body.groupId);
    expect(wrong.bundleId).toBe(null);
  });
});

describe('PATCH /api/bundles/:bundleId items (#3327)', () => {
  it('lets the creator replace the members, refuses anyone else (even for a shared bundle), and validates', async () => {
    const creator = await signupBuilder('bil-patch-creator');
    const stranger = await signupBuilder('bil-patch-stranger');
    const bundle = await createBundleAs(creator, { shared: true });
    const items = [{ templateId: 'placeholder-tree', dx: 0, dy: 0, dz: 0 }, { templateId: 'placeholder-tree', dx: 2, dy: 1, dz: 0 }, { templateId: 'placeholder-tree', dx: 4, dy: 1, dz: 0 }];

    const refused = await api(`/bundles/${bundle.bundleId}`, stranger.session({ method: 'PATCH', body: JSON.stringify({ items }) }));
    expect(refused.response.status).toBe(403);

    const updated = await api(`/bundles/${bundle.bundleId}`, creator.session({ method: 'PATCH', body: JSON.stringify({ items }) }));
    expect(updated.response.status).toBe(200);
    expect(updated.body.bundle.items).toHaveLength(3);
    expect(updated.body.bundle.items[2].dx).toBe(4);
    expect(updated.body.bundle.name).toBe('Link fixture');

    // A rename alone does not touch the members.
    const renamed = await api(`/bundles/${bundle.bundleId}`, creator.session({ method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }));
    expect(renamed.body.bundle.items).toHaveLength(3);

    const notAnArray = await api(`/bundles/${bundle.bundleId}`, creator.session({ method: 'PATCH', body: JSON.stringify({ items: 'nope' }) }));
    expect(notAnArray.response.status).toBe(400);
    const unknownTemplate = await api(`/bundles/${bundle.bundleId}`, creator.session({
      method: 'PATCH', body: JSON.stringify({ items: [{ templateId: 'no-such-template', dx: 0, dy: 0, dz: 0 }] }),
    }));
    expect(unknownTemplate.response.status).toBeGreaterThanOrEqual(400);
    const unchanged = await api(`/bundles/${bundle.bundleId}`, creator.session({ method: 'PATCH', body: JSON.stringify({}) }));
    expect(unchanged.body.bundle.items).toHaveLength(3);
  });
});

describe('deleting a saved bundle leaves its placements in the world, unlinked (#3327)', () => {
  it('keeps every instance and its group, and clears only the link', async () => {
    const { builder, place } = await builderWithLandlet('delete');
    await place('bil-delete-1');
    await place('bil-delete-2');
    const bundle = await createBundleAs(builder);
    const linked = await group(builder, ['bil-delete-1', 'bil-delete-2'], bundle.bundleId);

    const deleted = await api(`/bundles/${bundle.bundleId}`, builder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);

    const rows = (await env.DB.prepare('SELECT instance_id, group_id, bundle_id FROM placed_instances WHERE instance_id IN (?, ?) ORDER BY instance_id')
      .bind('bil-delete-1', 'bil-delete-2').all()).results;
    expect(rows).toEqual([
      { instance_id: 'bil-delete-1', group_id: linked.body.groupId, bundle_id: null },
      { instance_id: 'bil-delete-2', group_id: linked.body.groupId, bundle_id: null },
    ]);
  });
});

describe('the creator\'s bundle list reports how many placements a delete would unlink (#3330)', () => {
  it('counts linked placed copies once each, and drops to 0 after Unbundle', async () => {
    const { builder, place } = await builderWithLandlet('count');
    await place('bil-count-1');
    await place('bil-count-2');
    await place('bil-count-3');
    await place('bil-count-4');
    const bundle = await createBundleAs(builder);
    const countOf = async () => {
      const list = await api('/bundles', builder.session());
      return list.body.bundles.find((b) => b.bundleId === bundle.bundleId).placementCount;
    };
    expect(await countOf()).toBe(0);
    const first = await group(builder, ['bil-count-1', 'bil-count-2'], bundle.bundleId);
    expect(await countOf()).toBe(1);
    await group(builder, ['bil-count-3', 'bil-count-4'], bundle.bundleId);
    expect(await countOf()).toBe(2);
    const ungrouped = await api('/instances/ungroup', builder.session({ method: 'POST', body: JSON.stringify({ groupId: first.body.groupId }) }));
    expect(ungrouped.response.status).toBe(200);
    expect(await countOf()).toBe(1);
  });
});

describe('version snapshots and Restore to Editor carry the link (#3327)', () => {
  async function snapshotThenReplace(label, { deleteBundleBeforeRestore }) {
    const { builder, landletId, place } = await builderWithLandlet(label);
    await place(`bil-${label}-1`);
    await place(`bil-${label}-2`);
    const bundle = await createBundleAs(builder);
    const linked = await group(builder, [`bil-${label}-1`, `bil-${label}-2`], bundle.bundleId);

    const saved = await api(`/landlets/${landletId}/versions`, builder.session({ method: 'POST', body: JSON.stringify({}) }));
    expect(saved.response.status).toBe(201);
    const fetched = await api(`/landlets/${landletId}/versions/${saved.body.version.versionId}`);
    const snapshotInstances = fetched.body.version.instances;
    // The snapshot itself carries the link.
    expect(snapshotInstances.every((instance) => instance.bundleId === bundle.bundleId)).toBe(true);

    // One member is deleted from the live draft; the other stays and vouches
    // for the group (the same shape #2968's own restore test uses).
    const deleted = await api('/instances/batch', builder.session({
      method: 'DELETE', body: JSON.stringify({ instanceIds: [`bil-${label}-2`] }),
    }));
    expect(deleted.response.status).toBe(200);
    if (deleteBundleBeforeRestore) {
      const gone = await api(`/bundles/${bundle.bundleId}`, builder.session({ method: 'DELETE' }));
      expect(gone.response.status).toBe(200);
    }

    const restored = await api(`/landlets/${landletId}/draft`, builder.session({
      method: 'PUT', body: JSON.stringify({ instances: snapshotInstances }),
    }));
    return { restored, bundle, groupId: linked.body.groupId, label };
  }

  it('restores a deleted member into its still-linked group with the link intact', async () => {
    const { restored, bundle, groupId, label } = await snapshotThenReplace('snap-keep', { deleteBundleBeforeRestore: false });
    expect(restored.response.status).toBe(200);
    const byId = new Map(restored.body.instances.map((instance) => [instance.instanceId, instance]));
    expect(byId.get(`bil-${label}-2`).groupId).toBe(groupId);
    expect(byId.get(`bil-${label}-2`).bundleId).toBe(bundle.bundleId);
    expect(byId.get(`bil-${label}-1`).bundleId).toBe(bundle.bundleId);
  });

  it('restores as unlinked, without failing, when the bundle was deleted after the snapshot', async () => {
    const { restored, groupId, label } = await snapshotThenReplace('snap-gone', { deleteBundleBeforeRestore: true });
    expect(restored.response.status).toBe(200);
    const byId = new Map(restored.body.instances.map((instance) => [instance.instanceId, instance]));
    expect(byId.get(`bil-${label}-2`).groupId).toBe(groupId);
    expect(byId.get(`bil-${label}-2`).bundleId).toBe(null);
    expect(byId.get(`bil-${label}-1`).bundleId).toBe(null);
  });
});
