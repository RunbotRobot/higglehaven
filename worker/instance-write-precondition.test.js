import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, createGreenbeltLandletAs } from './test-helpers.js';

// #1062 (server half) / #3101: an optional expectedUpdatedAt precondition on
// the instance writes, so a stale tab can't silently overwrite a newer edit.
// Own file (own D1 isolate). updated_at is set explicitly where a test needs two
// distinguishable versions, because two real writes inside the same millisecond
// would otherwise produce the same timestamp.
let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('precondition-admin')).session;
});

const V1 = '2026-01-01T00:00:00.000Z';

async function setup(label, center) {
  const builder = await signupBuilder(`${label}-builder`);
  const landletId = `${label}-landlet`;
  await createGreenbeltLandletAs(adminSession, landletId, center);
  expect((await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }))).response.status).toBe(200);
  const item = (instanceId, x, extra = {}) => ({ instanceId, landletId, templateId: 'placeholder-chair', x, y: 2, ...extra });
  expect((await api('/instances/batch', builder.session({
    method: 'POST', body: JSON.stringify({ instances: [item(`${label}-a`, 1), item(`${label}-b`, 1)] }),
  }))).response.status).toBe(201);
  await env.DB.prepare('UPDATE placed_instances SET updated_at = ? WHERE landlet_id = ?').bind(V1, landletId).run();
  return { builder, landletId, item };
}

const stored = async (instanceId) => (await api(`/instances/${instanceId}`)).body.instance;

describe('PUT /instances/batch expectedUpdatedAt (#1062)', () => {
  it('writes an instance whose stored version matches and returns the new updatedAt', async () => {
    const { builder, item } = await setup('pre-match', { x: 9000, y: 0 });
    const saved = await api('/instances/batch', builder.session({
      method: 'PUT', body: JSON.stringify({ instances: [item('pre-match-a', 5, { expectedUpdatedAt: V1 })] }),
    }));
    expect(saved.response.status).toBe(200);
    expect(saved.body.staleInstanceIds).toEqual([]);
    expect(saved.body.instances[0].x).toBe(5);
    expect(saved.body.instances[0].updatedAt).not.toBe(V1);
  });

  it('skips a stale instance (never overwrites it) and reports its current state', async () => {
    const { builder, item } = await setup('pre-stale', { x: 9000, y: 3200 });
    // Another tab moves it first.
    expect((await api('/instances/pre-stale-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 3 }) }))).response.status).toBe(200);
    const saved = await api('/instances/batch', builder.session({
      method: 'PUT', body: JSON.stringify({ instances: [item('pre-stale-a', 5, { expectedUpdatedAt: V1 })] }),
    }));
    expect(saved.response.status).toBe(200);
    expect(saved.body.instances).toEqual([]);
    expect(saved.body.staleInstanceIds).toEqual(['pre-stale-a']);
    expect(saved.body.staleInstances).toHaveLength(1);
    expect(saved.body.staleInstances[0]).toMatchObject({ instanceId: 'pre-stale-a', x: 3 });
    expect((await stored('pre-stale-a')).x).toBe(3);
  });

  it('in a mixed batch writes the fresh item and skips only the stale one', async () => {
    const { builder, item } = await setup('pre-mixed', { x: 9000, y: 6400 });
    await api('/instances/pre-mixed-b', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 4 }) }));
    const saved = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [item('pre-mixed-a', 7, { expectedUpdatedAt: V1 }), item('pre-mixed-b', 8, { expectedUpdatedAt: V1 })] }),
    }));
    expect(saved.body.instances.map((i) => i.instanceId)).toEqual(['pre-mixed-a']);
    expect(saved.body.staleInstanceIds).toEqual(['pre-mixed-b']);
    expect((await stored('pre-mixed-a')).x).toBe(7);
    expect((await stored('pre-mixed-b')).x).toBe(4);
  });

  it('keeps last-write-wins when no expectedUpdatedAt is sent, and adds no new response fields', async () => {
    const { builder, item } = await setup('pre-none', { x: 9000, y: 9600 });
    await api('/instances/pre-none-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 3 }) }));
    const saved = await api('/instances/batch', builder.session({
      method: 'PUT', body: JSON.stringify({ instances: [item('pre-none-a', 5)] }),
    }));
    expect(saved.response.status).toBe(200);
    expect('staleInstanceIds' in saved.body).toBe(false);
    expect((await stored('pre-none-a')).x).toBe(5);
  });

  it('treats an id with no stored row as a create (nothing to be stale against) and ignores the field on POST', async () => {
    const { builder, item } = await setup('pre-create', { x: 12000, y: 0 });
    const putCreate = await api('/instances/batch', builder.session({
      method: 'PUT', body: JSON.stringify({ instances: [item('pre-create-new', 3, { expectedUpdatedAt: V1 })] }),
    }));
    expect(putCreate.response.status).toBe(200);
    expect(putCreate.body.instances.map((i) => i.instanceId)).toEqual(['pre-create-new']);
    const post = await api('/instances/batch', builder.session({
      method: 'POST', body: JSON.stringify({ instances: [item('pre-create-post', 3, { expectedUpdatedAt: V1 })] }),
    }));
    expect(post.response.status).toBe(201);
    expect('staleInstanceIds' in post.body).toBe(false);
  });

  it('rejects a malformed expectedUpdatedAt', async () => {
    const { builder, item } = await setup('pre-bad', { x: 12000, y: 3200 });
    for (const expectedUpdatedAt of [42, '', {}]) {
      const res = await api('/instances/batch', builder.session({
        method: 'PUT', body: JSON.stringify({ instances: [item('pre-bad-a', 5, { expectedUpdatedAt })] }),
      }));
      expect(res.response.status).toBe(400);
    }
  });

  it('combines with updateOnly: missing ids and stale ids are each reported', async () => {
    const { builder, item } = await setup('pre-combo', { x: 12000, y: 6400 });
    await api('/instances/pre-combo-b', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 4 }) }));
    await api('/instances/pre-combo-a', builder.session({ method: 'DELETE' }));
    const saved = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({ updateOnly: true, instances: [item('pre-combo-a', 7, { expectedUpdatedAt: V1 }), item('pre-combo-b', 8, { expectedUpdatedAt: V1 })] }),
    }));
    expect(saved.response.status).toBe(200);
    expect(saved.body.missingInstanceIds).toEqual(['pre-combo-a']);
    expect(saved.body.staleInstanceIds).toEqual(['pre-combo-b']);
    expect(saved.body.instances).toEqual([]);
  });
});

describe('PATCH /instances/:id expectedUpdatedAt (#1062)', () => {
  it('applies when the stored version matches', async () => {
    const { builder } = await setup('pat-match', { x: 15000, y: 0 });
    const res = await api('/instances/pat-match-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 6, expectedUpdatedAt: V1 }) }));
    expect(res.response.status).toBe(200);
    expect(res.body.instance.x).toBe(6);
    expect(res.body.instance.updatedAt).not.toBe(V1);
  });

  it('refuses a stale write with a 409 that carries the current stored state, and changes nothing', async () => {
    const { builder } = await setup('pat-stale', { x: 15000, y: 3200 });
    await api('/instances/pat-stale-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 3 }) }));
    const res = await api('/instances/pat-stale-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 6, expectedUpdatedAt: V1 }) }));
    expect(res.response.status).toBe(409);
    expect(res.body.staleInstanceId).toBe('pat-stale-a');
    expect(res.body.instance).toMatchObject({ instanceId: 'pat-stale-a', x: 3 });
    expect((await stored('pat-stale-a')).x).toBe(3);
  });

  it('is last-write-wins without the field, and rejects a malformed one', async () => {
    const { builder } = await setup('pat-none', { x: 15000, y: 6400 });
    await api('/instances/pat-none-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 3 }) }));
    expect((await api('/instances/pat-none-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 6 }) }))).response.status).toBe(200);
    expect((await stored('pat-none-a')).x).toBe(6);
    const bad = await api('/instances/pat-none-a', builder.session({ method: 'PATCH', body: JSON.stringify({ x: 6, expectedUpdatedAt: 7 }) }));
    expect(bad.response.status).toBe(400);
  });
});
