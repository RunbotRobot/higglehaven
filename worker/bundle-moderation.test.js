// #921: bundle names get the same baseline prohibited-content check catalog
// templates use, and an admin can remove any bundle (with a moderation
// category and a retained snapshot) instead of only the original author.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

let adminSession;
let adminUserId;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('bm-admin');
  adminSession = admin.session;
  adminUserId = (await api('/auth/me', adminSession())).body.user.userId;
});

function bundleBody(overrides = {}) {
  return {
    name: 'Tidy shelf set',
    items: [{ templateId: 'placeholder-chair', dx: 0, dy: 0, dz: 0 }],
    ...overrides,
  };
}

async function createBundle(builder, overrides = {}) {
  const created = await api('/bundles', builder.session({
    method: 'POST', body: JSON.stringify(bundleBody(overrides)),
  }));
  expect(created.response.status).toBe(201);
  return created.body.bundle;
}

describe('bundle name content check (#921)', () => {
  it('rejects a prohibited phrase in a bundle name on create and on rename, and accepts an ordinary one', async () => {
    const builder = await signupBuilder('bm-name');
    const rejected = await api('/bundles', builder.session({
      method: 'POST', body: JSON.stringify(bundleBody({ name: 'Counterfeit designer shop' })),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toContain('bundle');
    expect(rejected.body.error).toContain('counterfeit');

    const bundle = await createBundle(builder);
    const renameRejected = await api(`/bundles/${bundle.bundleId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Live animal market stall' }),
    }));
    expect(renameRejected.response.status).toBe(400);

    const renamed = await api(`/bundles/${bundle.bundleId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ name: 'Cosy corner' }),
    }));
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.bundle.name).toBe('Cosy corner');

    // A share-toggle that doesn't send a name is not re-checked.
    const toggled = await api(`/bundles/${bundle.bundleId}`, builder.session({
      method: 'PATCH', body: JSON.stringify({ shared: true }),
    }));
    expect(toggled.response.status).toBe(200);
  });
});

describe('admin removal of a bundle (#921)', () => {
  it('lets an admin delete someone else\'s bundle with a category, leaving a snapshot and an action-log row', async () => {
    const author = await signupBuilder('bm-author');
    const bundle = await createBundle(author, { shared: true });

    const noCategory = await api(`/bundles/${bundle.bundleId}`, adminSession({ method: 'DELETE', body: JSON.stringify({}) }));
    expect(noCategory.response.status).toBe(400);
    const stillThere = await env.DB.prepare('SELECT 1 AS found FROM bundles WHERE bundle_id = ?').bind(bundle.bundleId).first();
    expect(stillThere).toEqual({ found: 1 });

    const removed = await api(`/bundles/${bundle.bundleId}`, adminSession({
      method: 'DELETE', body: JSON.stringify({ category: 'spam' }),
    }));
    expect(removed.response.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    expect(await env.DB.prepare('SELECT 1 AS found FROM bundles WHERE bundle_id = ?').bind(bundle.bundleId).first()).toBeNull();

    const snapshot = await env.DB.prepare(
      'SELECT removed_category, snapshot_json, removed_by_user_id FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?',
    ).bind('bundles', bundle.bundleId).first();
    expect(snapshot.removed_category).toBe('spam');
    expect(snapshot.removed_by_user_id).toBe(adminUserId);
    expect(JSON.parse(snapshot.snapshot_json).name).toBe('Tidy shelf set');

    const log = await env.DB.prepare(
      'SELECT action_type, target_type FROM admin_action_log WHERE target_id = ?',
    ).bind(bundle.bundleId).first();
    expect(log).toEqual({ action_type: 'delete_bundle_override', target_type: 'bundle' });
  });

  it('retains nothing for a sexual_content removal, per the keep-nothing rule', async () => {
    const author = await signupBuilder('bm-sexual');
    const bundle = await createBundle(author, { shared: true });
    const removed = await api(`/bundles/${bundle.bundleId}`, adminSession({
      method: 'DELETE', body: JSON.stringify({ category: 'sexual_content' }),
    }));
    expect(removed.response.status).toBe(200);
    const snapshot = await env.DB.prepare(
      'SELECT snapshot_json FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?',
    ).bind('bundles', bundle.bundleId).first();
    expect(snapshot.snapshot_json).toBeNull();
  });

  it('still lets the author delete their own bundle with no body and no snapshot, and refuses a different non-admin builder', async () => {
    const author = await signupBuilder('bm-self');
    const stranger = await signupBuilder('bm-stranger');
    const bundle = await createBundle(author);

    const refused = await api(`/bundles/${bundle.bundleId}`, stranger.session({ method: 'DELETE' }));
    expect(refused.response.status).toBe(403);

    const deleted = await api(`/bundles/${bundle.bundleId}`, author.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    const snapshot = await env.DB.prepare(
      'SELECT 1 AS found FROM moderation_removal_snapshots WHERE source_table = ? AND source_id = ?',
    ).bind('bundles', bundle.bundleId).first();
    expect(snapshot).toBeNull();
  });

  it('treats an admin deleting their own bundle as an ordinary self-delete, with no category required', async () => {
    const adminBuilder = await signupAdmin('bm-admin-own');
    const bundle = await createBundle(adminBuilder);
    const deleted = await api(`/bundles/${bundle.bundleId}`, adminBuilder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
  });
});
