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

  // #2788: a partial-failure rollback must restore each succeeded member to
  // its own PRIOR group_id (here, group-i-1 and group-i-2's existing group),
  // not blanket-null it -- blanket-null would silently dissolve that
  // pre-existing group as a side effect of a request reported as a total
  // 409 failure. Same race idiom as worker-api.test.js's own #1772/#1773
  // multi-landlet-batch test: a second landlet's ownership changes in the
  // exact window between the upfront requireOwnedLandlets check and the
  // db.batch() write that follows it.
  it('restores a succeeded member to its own prior group, not null, on a partial-failure rollback', async () => {
    const otherLandletId = 'instance-groups-landlet-2788';
    await createGreenbeltLandlet(otherLandletId);
    // Self-claim only ever grants one landlet at a time (same invariant
    // worker-api.test.js's own #1772/#1773 multi-landlet-batch race test
    // works around) -- builder already claimed landletId above, so grant
    // this second landlet directly instead.
    await env.DB.prepare("UPDATE landlets SET owner_builder_id = ?, status = 'claimed' WHERE landlet_id = ?")
      .bind(builder.builderId, otherLandletId).run();
    const placeOnOtherLandlet = instancePlacer();

    await placeInstance(builder.session, { instanceId: 'group-i-1', landletId });
    await placeInstance(builder.session, { instanceId: 'group-i-2', landletId });
    await placeOnOtherLandlet(builder.session, { instanceId: 'group-i-3', landletId: otherLandletId });

    const preGrouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-i-1', 'group-i-2'] }),
    }));
    expect(preGrouped.response.status).toBe(201);
    const priorGroupId = preGrouped.body.groupId;

    const otherBuilder = await signupBuilder('groups-rollback-other-builder');
    const originalBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements) => {
      await env.DB.prepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
        .bind(otherBuilder.builderId, otherLandletId).run();
      return originalBatch(statements);
    };
    let result;
    try {
      // group-i-1 is already grouped (above); re-grouping it with group-i-3
      // is allowed per this handler's own documented merge design. Only
      // group-i-3's write is rejected by the race above.
      result = await api('/instances/group', builder.session({
        method: 'POST',
        body: JSON.stringify({ instanceIds: ['group-i-1', 'group-i-3'] }),
      }));
    } finally {
      env.DB.batch = originalBatch;
    }
    expect(result.response.status).toBe(409);

    const first = await api('/instances/group-i-1');
    const second = await api('/instances/group-i-2');
    const third = await api('/instances/group-i-3');
    expect(first.body.instance.groupId).toBe(priorGroupId);
    expect(second.body.instance.groupId).toBe(priorGroupId);
    expect(third.body.instance.groupId).toBe(null);
  });

  // #2959: Build mode's Delete+Undo cycle recreates a deleted instance via
  // a fresh POST /api/instances/batch call (src/build/scene.js's
  // restoreSnapshot) -- the client knows the instance's own pre-delete
  // groupId (captured in its undo snapshot) and now sends it along, but the
  // server must still independently decide whether to trust it.
  it('restores groupId on a batch-create that supplies a groupId the caller already owns a member of (undo-recreate)', async () => {
    // Own local instancePlacer() rather than the shared, suite-wide
    // placeInstance -- see the PUT-update test below's own comment on why.
    const placeHere = instancePlacer();
    await placeHere(builder.session, { instanceId: 'group-j-1', landletId });
    await placeHere(builder.session, { instanceId: 'group-j-2', landletId });
    const grouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-j-1', 'group-j-2'] }),
    }));
    expect(grouped.response.status).toBe(201);
    const groupId = grouped.body.groupId;

    // Simulates a Delete+Undo cycle: group-j-2 is hard-deleted, then
    // recreated with the same instanceId via the batch create endpoint,
    // carrying the groupId its own undo snapshot captured before the
    // delete.
    const deleted = await api('/instances/batch', builder.session({
      method: 'DELETE',
      body: JSON.stringify({ instanceIds: ['group-j-2'] }),
    }));
    expect(deleted.response.status).toBe(200);

    const recreated = await api('/instances/batch', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{ instanceId: 'group-j-2', landletId, templateId: 'placeholder-tree', x: 5, y: 0, groupId }],
      }),
    }));
    expect(recreated.response.status).toBe(201);
    expect(recreated.body.instances[0].groupId).toBe(groupId);

    const refetched = await api('/instances/group-j-2');
    expect(refetched.body.instance.groupId).toBe(groupId);
    // group-j-1 (never deleted) is unaffected either way.
    const stillGrouped = await api('/instances/group-j-1');
    expect(stillGrouped.body.instance.groupId).toBe(groupId);
  });

  // Sibling of the test above: a groupId the caller has no member of at all
  // (someone else's real group, here) must be silently ignored rather than
  // trusted, closing the griefing path docs/API.md's own #2959 note
  // describes (a crafted create attaching a new instance to a victim's
  // group, breaking their later ungroup).
  it("ignores a batch-create's groupId naming a group the caller has no member of", async () => {
    const otherBuilder = await signupBuilder('groups-foreign-group-builder');
    const otherLandletId = 'instance-groups-foreign-landlet';
    await createGreenbeltLandlet(otherLandletId);
    const otherClaimed = await api(`/landlets/${otherLandletId}/claim`, otherBuilder.session({ method: 'POST' }));
    expect(otherClaimed.response.status).toBe(200);
    const placeOnOtherLandlet = instancePlacer();
    await placeOnOtherLandlet(otherBuilder.session, { instanceId: 'group-k-1', landletId: otherLandletId });
    await placeOnOtherLandlet(otherBuilder.session, { instanceId: 'group-k-2', landletId: otherLandletId });
    const foreignGroup = await api('/instances/group', otherBuilder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-k-1', 'group-k-2'] }),
    }));
    expect(foreignGroup.response.status).toBe(201);

    const created = await api('/instances/batch', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{
          instanceId: 'group-l-1', landletId, templateId: 'placeholder-tree', x: 6, y: 0, groupId: foreignGroup.body.groupId,
        }],
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.instances[0].groupId).toBe(null);

    const refetched = await api('/instances/group-l-1');
    expect(refetched.body.instance.groupId).toBe(null);
    // The foreign group itself is untouched -- still exactly its own 2 members.
    const firstForeign = await api('/instances/group-k-1');
    const secondForeign = await api('/instances/group-k-2');
    expect(firstForeign.body.instance.groupId).toBe(foreignGroup.body.groupId);
    expect(secondForeign.body.instance.groupId).toBe(foreignGroup.body.groupId);
  });

  // Sibling of the ordinary-PATCH test above (#2764's own note): an
  // ordinary PUT /instances/batch *update* (an instanceId that already
  // exists) must not let a client-supplied groupId touch the stored value
  // either -- #2959's new INSERT-time-only carve-out must not widen to
  // cover updates.
  it('ignores a groupId on an ordinary PUT /instances/batch update of an already-existing instance', async () => {
    // Own local instancePlacer() (same shape the "otherLandlet" fixtures
    // above already use) rather than the shared, suite-wide placeInstance
    // -- its x keeps growing across every test in this file and group-m's
    // two placements alone would otherwise push a later test's x past the
    // landlet's own walkable bound. No overlap/collision check exists
    // between placed instances (#846), so reusing x=0 here is safe.
    const placeHere = instancePlacer();
    await placeHere(builder.session, { instanceId: 'group-m-1', landletId });
    await placeHere(builder.session, { instanceId: 'group-m-2', landletId });
    const grouped = await api('/instances/group', builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceIds: ['group-m-1', 'group-m-2'] }),
    }));
    expect(grouped.response.status).toBe(201);
    const groupId = grouped.body.groupId;

    const moved = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{ instanceId: 'group-m-1', landletId, templateId: 'placeholder-tree', x: 7, y: 0, groupId: null }],
      }),
    }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.instances[0].groupId).toBe(groupId);
  });
});
