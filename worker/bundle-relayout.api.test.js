// #3329 (leaf 6/7 of #3323): editing a saved bundle re-lays every placement
// linked to it, keeps each copy's own anchor and yaw, tells the other
// builders, detaches (never destroys) a copy that no longer matches, and
// serializes racing edits. Geometry is covered in bundle-relayout.test.js.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupBuilder, createGreenbeltLandletAs,
} from './test-helpers.js';

let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('brl-admin')).session;
});

async function builderWithLandlet(label) {
  const builder = await signupBuilder(`brl-${label}`);
  const landletId = `brl-${label}-landlet`;
  await createGreenbeltLandletAs(adminSession, landletId);
  expect((await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }))).response.status).toBe(200);
  const place = async (instanceId, x, y, rotationZ = 0) => {
    const created = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId: 'placeholder-tree', x, y, rotationZ }),
    }));
    expect(created.response.status).toBe(201);
  };
  return { builder, landletId, place };
}

const TREE = { templateId: 'placeholder-tree', dy: 0, dz: 0, rotationX: 0, rotationY: 0, rotationZ: 0 };
const ITEMS = [{ ...TREE, dx: 0 }, { ...TREE, dx: 1 }];
const EDITED = [{ ...TREE, dx: 0 }, { ...TREE, dx: 2 }];

async function linkedBundleWithCopies(label) {
  const creator = await builderWithLandlet(`${label}-creator`);
  const other = await builderWithLandlet(`${label}-other`);
  const created = await api('/bundles', creator.builder.session({
    method: 'POST', body: JSON.stringify({ name: `Wall ${label}`, items: ITEMS, shared: true }),
  }));
  const bundleId = created.body.bundle.bundleId;
  // The creator's own copy, unturned, at (10, 0).
  await creator.place(`${label}-c1`, 10, 0);
  await creator.place(`${label}-c2`, 11, 0);
  const own = await api('/instances/group', creator.builder.session({
    method: 'POST', body: JSON.stringify({ instanceIds: [`${label}-c1`, `${label}-c2`], bundleId }),
  }));
  // Another builder's copy, turned a quarter turn about z, at (-5, 3).
  await other.place(`${label}-o1`, -5, 3, Math.PI / 2);
  await other.place(`${label}-o2`, -5, 4, Math.PI / 2);
  const theirs = await api('/instances/group', other.builder.session({
    method: 'POST', body: JSON.stringify({ instanceIds: [`${label}-o1`, `${label}-o2`], bundleId }),
  }));
  expect(theirs.response.status).toBe(201);
  return { creator, other, bundleId, ownGroupId: own.body.groupId, theirGroupId: theirs.body.groupId };
}

const rowsOf = async (groupId) => (await env.DB.prepare(
  'SELECT instance_id, x_m, y_m, z_m, rotation_z_rad, bundle_id FROM placed_instances WHERE group_id = ? ORDER BY x_m, y_m',
).bind(groupId).all()).results;
const noticesOf = async (builder) => (await api('/notifications', builder.session())).body.notifications
  .filter((n) => n.message.includes('changed the bundle'));

describe('editing a saved bundle re-lays its linked copies (#3329)', () => {
  it("re-lays another builder's turned copy keeping its anchor and yaw, and tells them once", async () => {
    const { creator, other, bundleId, ownGroupId, theirGroupId } = await linkedBundleWithCopies('relay');
    const patched = await api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH',
      body: JSON.stringify({
        items: EDITED,
        placement: { groupId: ownGroupId, baselineItems: ITEMS },
      }),
    }));
    expect(patched.response.status).toBe(200);
    expect(patched.body.relayout.relaidCount).toBe(1);
    expect(patched.body.relayout.detachedCount).toBe(0);

    // The other copy: first member stays, second moves from dx=1 to dx=2,
    // which a quarter turn puts at y + 2.
    const rows = await rowsOf(theirGroupId);
    expect(rows).toHaveLength(2);
    expect(rows[0].x_m).toBeCloseTo(-5, 6);
    expect(rows[0].y_m).toBeCloseTo(3, 6);
    expect(rows[1].x_m).toBeCloseTo(-5, 6);
    expect(rows[1].y_m).toBeCloseTo(5, 6);
    expect(rows.every((row) => row.bundle_id === bundleId)).toBe(true);
    // Instance ids were kept (same product at the same position in the list).
    expect(rows.map((row) => row.instance_id).sort()).toEqual(['relay-o1', 'relay-o2']);

    // The edited copy is the editor's to move, so the server did not touch it.
    const own = await rowsOf(ownGroupId);
    expect(own.map((row) => row.x_m)).toEqual([10, 11]);

    const notices = await noticesOf(other.builder);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('changed the bundle "Wall relay"');
    expect(notices[0].message).toContain('brl-relay-other-landlet');
    expect(notices[0].message).toContain('Unbundle it if you want to keep your own copy.');
    expect(await noticesOf(creator.builder)).toHaveLength(0);
  });

  it('coalesces rapid edits into one notice but still re-lays every time', async () => {
    const { creator, other, bundleId, ownGroupId, theirGroupId } = await linkedBundleWithCopies('coalesce');
    const edit = (items, baselineItems) => api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH', body: JSON.stringify({ items, placement: { groupId: ownGroupId, baselineItems } }),
    }));
    expect((await edit(EDITED, ITEMS)).response.status).toBe(200);
    const third = [{ ...TREE, dx: 0 }, { ...TREE, dx: 3 }];
    const second = await edit(third, EDITED);
    expect(second.body).toBeDefined();
    expect(second.response.status, JSON.stringify(second.body)).toBe(200);
    expect((await rowsOf(theirGroupId))[1].y_m).toBeCloseTo(6, 6);
    expect(await noticesOf(other.builder)).toHaveLength(1);
  });

  it('detaches a copy that was rearranged by hand and tells its builder, leaving it untouched', async () => {
    const { creator, other, bundleId, ownGroupId, theirGroupId } = await linkedBundleWithCopies('detach');
    expect((await api('/instances/detach-o2', other.builder.session({
      method: 'PATCH', body: JSON.stringify({ x: -9 }),
    }))).response.status).toBeLessThan(500);
    await env.DB.prepare('UPDATE placed_instances SET x_m = -9 WHERE instance_id = ?').bind('detach-o2').run();
    const patched = await api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH', body: JSON.stringify({ items: EDITED, placement: { groupId: ownGroupId, baselineItems: ITEMS } }),
    }));
    expect(patched.response.status).toBe(200);
    expect(patched.body.relayout.detachedCount).toBe(1);
    const rows = await rowsOf(theirGroupId);
    expect(rows.map((row) => row.x_m).sort((a, b) => a - b)).toEqual([-9, -5]);
    expect(rows.every((row) => row.bundle_id === null)).toBe(true);
    const notices = await noticesOf(other.builder);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('no longer matched it');
    expect(notices[0].message).toContain('now your own bundle');
  });

  it('does not touch an unlinked paste of the same products', async () => {
    const { creator, other, bundleId, ownGroupId } = await linkedBundleWithCopies('paste');
    await other.place('paste-loose-1', -9, -9);
    await other.place('paste-loose-2', -8, -9);
    const patched = await api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH', body: JSON.stringify({ items: EDITED, placement: { groupId: ownGroupId, baselineItems: ITEMS } }),
    }));
    expect(patched.response.status).toBe(200);
    const loose = (await env.DB.prepare(
      "SELECT x_m FROM placed_instances WHERE instance_id LIKE 'paste-loose-%' ORDER BY x_m",
    ).all()).results.map((row) => row.x_m);
    expect(loose).toEqual([-9, -8]);
  });

  it('refuses the edit when the editor copy cannot be matched to the saved bundle', async () => {
    const { creator, bundleId, ownGroupId } = await linkedBundleWithCopies('baseline');
    const patched = await api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH',
      body: JSON.stringify({ items: EDITED, placement: { groupId: ownGroupId, baselineItems: [{ ...TREE, dx: 0 }, { ...TREE, dx: 5 }] } }),
    }));
    expect(patched.response.status).toBe(409);
    expect(patched.body.error).toContain('Unbundle it');
    const stored = (await api('/bundles', creator.builder.session())).body.bundles.find((b) => b.bundleId === bundleId);
    expect(stored.items).toEqual(ITEMS.map((item) => expect.objectContaining({ dx: item.dx })));
  });

  it("another builder still cannot edit the bundle, and a placement id that isn't theirs is refused", async () => {
    const { creator, other, bundleId, theirGroupId } = await linkedBundleWithCopies('guard');
    const byOther = await api(`/bundles/${bundleId}`, other.builder.session({
      method: 'PATCH', body: JSON.stringify({ items: EDITED }),
    }));
    expect(byOther.response.status).toBe(403);
    const foreign = await api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH', body: JSON.stringify({ items: EDITED, placement: { groupId: theirGroupId, baselineItems: ITEMS } }),
    }));
    expect(foreign.response.status).toBe(409);
  });

  it('two edits racing from the same starting point: one wins, the other is told to reopen', async () => {
    const { creator, bundleId, ownGroupId } = await linkedBundleWithCopies('race');
    const send = (items) => api(`/bundles/${bundleId}`, creator.builder.session({
      method: 'PATCH', body: JSON.stringify({ items, placement: { groupId: ownGroupId, baselineItems: ITEMS } }),
    }));
    const [a, b] = await Promise.all([send(EDITED), send([{ ...TREE, dx: 0 }, { ...TREE, dx: 4 }])]);
    expect([a.response.status, b.response.status].sort()).toEqual([200, 409]);
  });
});
