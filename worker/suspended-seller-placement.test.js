// #3034 (found via #3029): after a seller is suspended, #2985 hides their
// listings and #2986 removes their placed instances -- but the instance
// write paths must also refuse to put one back (POST /instances, the batch
// endpoint, a template swap via PUT, and "Restore to Editor" via PUT
// /landlets/:id/draft).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupSeller } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('ssp-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId) {
  const created = await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
  }));
  expect(created.response.status).toBe(201);
}

async function claim(landletId, builder) {
  const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
}

async function createSellerTemplate(seller, templateId) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `SSP fixture ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
  return templateId;
}

async function suspend(email) {
  const suspended = await api('/auth/suspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email, reason: 'test suspension (#3034)' }),
  }));
  expect(suspended.response.status).toBe(200);
}

async function unsuspend(email) {
  const lifted = await api('/auth/unsuspend-account', adminSession({
    method: 'POST', body: JSON.stringify({ email }),
  }));
  expect(lifted.response.status).toBe(200);
}

async function setup(prefix) {
  const suspendedSeller = await signupSeller(`${prefix}-suspended-seller`);
  const activeSeller = await signupSeller(`${prefix}-active-seller`);
  const builder = await signupAdmin(`${prefix}-builder`);
  const landletId = `${prefix}-landlet`;
  await createGreenbeltLandlet(landletId);
  await claim(landletId, builder);
  const suspendedTemplate = await createSellerTemplate(suspendedSeller, `${prefix}-suspended-template`);
  const activeTemplate = await createSellerTemplate(activeSeller, `${prefix}-active-template`);
  return { suspendedSeller, builder, landletId, suspendedTemplate, activeTemplate };
}

async function placedIds(landletId, builder) {
  const listed = await api(`/instances?landletId=${landletId}`, builder.session());
  return listed.body.instances.map((i) => i.instanceId);
}

describe('A builder cannot place a suspended seller\'s product (#3034)', () => {
  it('rejects POST /instances for a suspended seller\'s template, and allows it again after unsuspend', async () => {
    const s = await setup('ssp-post');
    await suspend(s.suspendedSeller.email);

    const rejected = await api('/instances', s.builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'ssp-post-inst', landletId: s.landletId, templateId: s.suspendedTemplate, x: 1, y: 1 }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/seller is suspended/);
    expect(await placedIds(s.landletId, s.builder)).not.toContain('ssp-post-inst');

    const activeOk = await api('/instances', s.builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'ssp-post-active', landletId: s.landletId, templateId: s.activeTemplate, x: 2, y: 2 }),
    }));
    expect(activeOk.response.status).toBe(201);

    await unsuspend(s.suspendedSeller.email);
    const allowed = await api('/instances', s.builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'ssp-post-inst', landletId: s.landletId, templateId: s.suspendedTemplate, x: 1, y: 1 }),
    }));
    expect(allowed.response.status).toBe(201);
  });

  it('rejects POST and PUT /instances/batch containing a suspended seller\'s template, writing nothing', async () => {
    const s = await setup('ssp-batch');
    await suspend(s.suspendedSeller.email);

    for (const method of ['POST', 'PUT']) {
      const rejected = await api('/instances/batch', s.builder.session({
        method,
        body: JSON.stringify({
          instances: [
            { instanceId: `ssp-batch-active-${method}`, landletId: s.landletId, templateId: s.activeTemplate, x: 1, y: 1 },
            { instanceId: `ssp-batch-susp-${method}`, landletId: s.landletId, templateId: s.suspendedTemplate, x: 3, y: 3 },
          ],
        }),
      }));
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toMatch(/seller is suspended/);
    }
    expect(await placedIds(s.landletId, s.builder)).toEqual([]);
  });

  it('rejects swapping an existing instance to a suspended seller\'s template via PUT /instances/:id', async () => {
    const s = await setup('ssp-swap');
    const placed = await api('/instances', s.builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'ssp-swap-inst', landletId: s.landletId, templateId: s.activeTemplate, x: 1, y: 1 }),
    }));
    expect(placed.response.status).toBe(201);
    await suspend(s.suspendedSeller.email);

    const swapped = await api('/instances/ssp-swap-inst', s.builder.session({
      method: 'PUT',
      body: JSON.stringify({ templateId: s.suspendedTemplate }),
    }));
    expect(swapped.response.status).toBe(400);
    expect(swapped.body.error).toMatch(/seller is suspended/);

    // An unrelated edit to the untouched instance still works.
    const moved = await api('/instances/ssp-swap-inst', s.builder.session({
      method: 'PATCH', body: JSON.stringify({ x: 4 }),
    }));
    expect(moved.response.status).toBe(200);
  });

  it('PUT /landlets/:id/draft ("Restore to Editor") skips a suspended seller\'s product and reports it', async () => {
    const s = await setup('ssp-draft');
    await suspend(s.suspendedSeller.email);

    const restored = await api(`/landlets/${s.landletId}/draft`, s.builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          { instanceId: 'ssp-draft-active', templateId: s.activeTemplate, x: 1, y: 1 },
          { instanceId: 'ssp-draft-susp', templateId: s.suspendedTemplate, x: 3, y: 3 },
        ],
      }),
    }));
    expect(restored.response.status).toBe(200);
    expect(restored.body.instances.map((i) => i.instanceId)).toEqual(['ssp-draft-active']);
    expect(restored.body.skippedInstances).toEqual([
      { instanceId: 'ssp-draft-susp', templateId: s.suspendedTemplate },
    ]);
    expect(await placedIds(s.landletId, s.builder)).toEqual(['ssp-draft-active']);

    // The version snapshot taken by the same save doesn't carry the skipped item either.
    const versionCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM version_instances WHERE version_id = ? AND template_id = ?',
    ).bind(restored.body.version.versionId, s.suspendedTemplate).first();
    expect(versionCount.n).toBe(0);
  });

  it('PUT /landlets/:id/draft reports no skipped items when nothing is suspended', async () => {
    const s = await setup('ssp-draft-ok');
    const saved = await api(`/landlets/${s.landletId}/draft`, s.builder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [{ instanceId: 'ssp-draft-ok-inst', templateId: s.activeTemplate, x: 1, y: 1 }] }),
    }));
    expect(saved.response.status).toBe(200);
    expect(saved.body.skippedInstances).toEqual([]);
  });
  // #3050: the #1947 backup chain is a deferred placement -- adding a
  // suspended seller's product to it, or letting a sell-out activate one
  // already in it, would put a removed product back on the builder's land.
  it('refuses a suspended seller\'s product as a backup-chain entry', async () => {
    const s = await setup('ssp-backup-add');
    const placed = await api('/instances', s.builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'ssp-backup-add-inst', landletId: s.landletId, templateId: s.activeTemplate, x: 1, y: 1 }),
    }));
    expect(placed.response.status).toBe(201);
    await suspend(s.suspendedSeller.email);

    const added = await api('/instances/ssp-backup-add-inst/backups', s.builder.session({
      method: 'POST', body: JSON.stringify({ templateId: s.suspendedTemplate }),
    }));
    expect(added.response.status).toBe(400);
    const listed = await api('/instances/ssp-backup-add-inst/backups', s.builder.session());
    expect(listed.body.backups).toEqual([]);
  });

  it('a sell-out skips a backup whose seller became suspended instead of activating it', async () => {
    const s = await setup('ssp-backup-sweep');
    const primary = await api('/catalog', s.builder.session({
      method: 'POST',
      body: JSON.stringify({
        templateId: 'ssp-backup-sweep-primary', name: 'Primary', color: '#123456',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, stockQuantity: 1,
      }),
    }));
    expect(primary.response.status).toBe(201);
    const placed = await api('/instances', s.builder.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'ssp-backup-sweep-inst', landletId: s.landletId, templateId: 'ssp-backup-sweep-primary', x: 1, y: 1 }),
    }));
    expect(placed.response.status).toBe(201);
    // Added while the seller is still active, then suspended afterwards.
    const added = await api('/instances/ssp-backup-sweep-inst/backups', s.builder.session({
      method: 'POST', body: JSON.stringify({ templateId: s.suspendedTemplate }),
    }));
    expect(added.response.status).toBe(201);
    await suspend(s.suspendedSeller.email);

    const sale = await api('/instances/ssp-backup-sweep-inst/purchase', s.builder.session({ method: 'POST' }));
    expect(sale.response.status).toBe(201);

    const after = await api('/instances/ssp-backup-sweep-inst');
    expect(after.response.status).toBe(404);
    expect(await placedIds(s.landletId, s.builder)).not.toContain('ssp-backup-sweep-inst');
  });
});
