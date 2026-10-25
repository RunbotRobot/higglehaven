// #2764 (sub-issue of #2763, owner-requested): persistent Group/Ungroup for
// placed items. Covers POST /api/instances/group and POST
// /api/instances/ungroup — see docs/API.md's "Group/Ungroup (#2764)" and
// the two endpoint sections just above it for the full behavior these
// tests check.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, signupAdmin, signupBuilder, createGreenbeltLandletAs,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('groups-shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}

// Auto-assigns a small, distinct x per call (never y) so every test's own
// fixtures land at a unique, always-in-bounds spot without each call site
// picking its own coordinate — LANDLET_SIDE_M (worker/index.js) is a fixed
// sqrt(1000) ≈ 31.6m regardless of the areaM2 a landlet is created with, so
// a center must stay within roughly ±15.8m (minus the tree's own ~0.75m
// footprint half) of a landlet's own center. Each landlet in this file gets
// its own instance of this helper so two different landlets' fixtures can't
// collide, but neither needs its range anywhere near that bound.
function instancePlacer() {
  let nextX = 0;
  return async (session, { instanceId, landletId }) => {
    const x = nextX;
    nextX += 1;
    const created = await api('/instances', session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId, templateId: 'placeholder-tree', x, y: 0 }),
    }));
    expect(created.response.status).toBe(201);
    return created.body.instance;
  };
}

describe('Group/Ungroup (#2764)', () => {
  let builder;
  let landletId;
  let placeInstance;

  beforeAll(async () => {
    builder = await signupBuilder('groups-builder');
    landletId = 'instance-groups-landlet';
    await createGreenbeltLandlet(landletId);
    const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    placeInstance = instancePlacer();
  });

  it('groups 2+ instances under a freshly minted, shared groupId that round-trips on GET', async () => {
    await placeInstance(builder.session, { instanceId: 'group-a-1', landletId });
    await placeInstance(builder.session, { instanceId: 'group-a-2', landletId });
    await placeInstance(builder.session, { instanceId: 'group-a-3', landletId });

    const grouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-a-1', 'group-a-2', 'group-a-3'] }),
    }));
    expect(grouped.response.status).toBe(201);
    expect(typeof grouped.body.groupId).toBe('string');
    expect(grouped.body.instances.every((inst) => inst.groupId === grouped.body.groupId)).toBe(true);

    const fetched = await api('/instances/group-a-2');
    expect(fetched.body.instance.groupId).toBe(grouped.body.groupId);
  });

  it('rejects fewer than 2 instanceIds', async () => {
    await placeInstance(builder.session, { instanceId: 'group-b-1', landletId });
    const result = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-b-1'] }),
    }));
    expect(result.response.status).toBe(400);
  });

  it('rejects duplicate instanceIds', async () => {
    await placeInstance(builder.session, { instanceId: 'group-c-1', landletId });
    const result = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-c-1', 'group-c-1'] }),
    }));
    expect(result.response.status).toBe(400);
  });

  it('404s when any referenced instanceId does not exist, leaving the rest ungrouped', async () => {
    const existing = await placeInstance(builder.session, { instanceId: 'group-d-1', landletId });
    const result = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-d-1', 'does-not-exist'] }),
    }));
    expect(result.response.status).toBe(404);
    const stillUngrouped = await api(`/instances/${existing.instanceId}`);
    expect(stillUngrouped.body.instance.groupId).toBe(null);
  });

  it("403s grouping an instance on a landlet the caller doesn't own", async () => {
    const otherBuilder = await signupBuilder('groups-other-builder');
    const otherLandletId = 'instance-groups-other-landlet';
    await createGreenbeltLandlet(otherLandletId);
    const claimed = await api(`/landlets/${otherLandletId}/claim`, otherBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    const notMine = await instancePlacer()(otherBuilder.session, { instanceId: 'group-e-1', landletId: otherLandletId });
    await placeInstance(builder.session, { instanceId: 'group-e-2', landletId });

    const result = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-e-2', notMine.instanceId] }),
    }));
    expect(result.response.status).toBe(403);
  });

  it('fully dissolves a group back to independent items', async () => {
    await placeInstance(builder.session, { instanceId: 'group-f-1', landletId });
    await placeInstance(builder.session, { instanceId: 'group-f-2', landletId });
    const grouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-f-1', 'group-f-2'] }),
    }));
    expect(grouped.response.status).toBe(201);

    const ungrouped = await api('/instances/ungroup', builder.session({
      method: 'POST',
      body: JSON.stringify({ groupId: grouped.body.groupId }),
    }));
    expect(ungrouped.response.status).toBe(200);
    expect(new Set(ungrouped.body.ungroupedInstanceIds)).toEqual(new Set(['group-f-1', 'group-f-2']));
    expect(ungrouped.body.rejectedInstanceIds).toEqual([]);

    const first = await api('/instances/group-f-1');
    const second = await api('/instances/group-f-2');
    expect(first.body.instance.groupId).toBe(null);
    expect(second.body.instance.groupId).toBe(null);
  });

  it('404s ungrouping a groupId with no current members', async () => {
    const result = await api('/instances/ungroup', builder.session({
      method: 'POST',
      body: JSON.stringify({ groupId: 'no-such-group' }),
    }));
    expect(result.response.status).toBe(404);
  });

  it("403s ungrouping a group on a landlet the caller doesn't own", async () => {
    const otherBuilder = await signupBuilder('groups-ungroup-other-builder');
    const otherLandletId = 'instance-groups-ungroup-other-landlet';
    await createGreenbeltLandlet(otherLandletId);
    const claimed = await api(`/landlets/${otherLandletId}/claim`, otherBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    const placeOnOtherLandlet = instancePlacer();
    await placeOnOtherLandlet(otherBuilder.session, { instanceId: 'group-g-1', landletId: otherLandletId });
    await placeOnOtherLandlet(otherBuilder.session, { instanceId: 'group-g-2', landletId: otherLandletId });
    const grouped = await api('/instances/group', otherBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-g-1', 'group-g-2'] }),
    }));
    expect(grouped.response.status).toBe(201);

    const result = await api('/instances/ungroup', builder.session({
      method: 'POST',
      body: JSON.stringify({ groupId: grouped.body.groupId }),
    }));
    expect(result.response.status).toBe(403);
  });

  // #2764 (docs/API.md's own "never settable through POST/PATCH's own
  // generic field merge" note) -- an ordinary field-only PATCH must not
  // clear (or otherwise disturb) a groupId already set.
  it('preserves groupId across an unrelated PATCH, and PATCH cannot set/clear it directly', async () => {
    await placeInstance(builder.session, { instanceId: 'group-h-1', landletId });
    await placeInstance(builder.session, { instanceId: 'group-h-2', landletId });
    const grouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-h-1', 'group-h-2'] }),
    }));
    expect(grouped.response.status).toBe(201);

    const moved = await api('/instances/group-h-1', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ y: 2 }),
    }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.instance.groupId).toBe(grouped.body.groupId);

    const attemptClear = await api('/instances/group-h-1', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ groupId: null }),
    }));
    expect(attemptClear.response.status).toBe(200);
    expect(attemptClear.body.instance.groupId).toBe(grouped.body.groupId);
  });
});
