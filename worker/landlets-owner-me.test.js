// #3873: GET /api/landlets?ownerBuilderId=me answers from the session, so Build can ask for "my lándlet" while the
// builder id is still on its way instead of after it. Same answer as naming the builder's own id, same gate as every
// builder-owned call, and nobody can read anyone else's lándlets through it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, createGreenbeltLandletAs } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('landlets-me-admin')).session;
});

describe('GET /api/landlets?ownerBuilderId=me (#3873)', () => {
  it('lists the signed-in builder\'s own claimed lándlets, the same as naming their id', async () => {
    const landletId = `landlets-me-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const owner = await signupBuilder('landlets-me-owner');
    const claimed = await api(`/landlets/${landletId}/claim`, owner.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const viaMe = await api('/landlets?status=claimed&ownerBuilderId=me&limit=1', owner.session());
    const viaId = await api(`/landlets?status=claimed&ownerBuilderId=${owner.builderId}&limit=1`, owner.session());
    expect(viaMe.response.status).toBe(200);
    expect(viaMe.body.landlets.map((l) => l.landletId)).toEqual([landletId]);
    expect(viaMe.body.landlets).toEqual(viaId.body.landlets);
  });

  it('is the caller\'s own lándlets only: another builder asking gets their own (none), never the first one\'s', async () => {
    const landletId = `landlets-me-other-${crypto.randomUUID()}`;
    await createGreenbeltLandletAs(adminSession, landletId);
    const owner = await signupBuilder('landlets-me-owner-2');
    await api(`/landlets/${landletId}/claim`, owner.session({ method: 'POST' }));
    const other = await signupBuilder('landlets-me-other');
    const mine = await api('/landlets?status=claimed&ownerBuilderId=me&limit=1', other.session());
    expect(mine.response.status).toBe(200);
    expect(mine.body.landlets).toEqual([]);
  });

  it('needs a session: 401 without one', async () => {
    const response = await api('/landlets?ownerBuilderId=me');
    expect(response.response.status).toBe(401);
  });
});
