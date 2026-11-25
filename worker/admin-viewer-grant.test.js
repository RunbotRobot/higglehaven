// #4175 (slice c): the owner's switch for the look-only admin role. Only a full admin can turn it on or off,
// only for a fleet account that is not an assistant, and each change is in the admin log.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';

let admin;
const post = (who, body) => api('/auth/admin-set-viewer', who.session({ method: 'POST', body: JSON.stringify(body) }));
const idOf = async (account) => (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(account.email).first()).user_id;
const logRows = async (action, id) => (await env.DB.prepare('SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?').bind(action, id).all()).results;
async function fleetAccount(label) {
  const account = await signupBuilder(label);
  await env.DB.prepare('UPDATE users SET is_fleet = 1 WHERE email = ?').bind(account.email).run();
  return account;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('viewer-grant-admin');
});

describe('POST /auth/admin-set-viewer (#4175)', () => {
  it('is for a full admin only', async () => {
    const fleet = await fleetAccount('viewer-grant-who');
    const id = await idOf(fleet);
    const anon = await api('/auth/admin-set-viewer', { method: 'POST', body: JSON.stringify({ userId: id, enabled: true }) });
    expect(anon.response.status).toBe(401);
    expect((await post(fleet, { userId: id, enabled: true })).response.status).toBe(403); // not even for itself
    const person = await signupBuilder('viewer-grant-person');
    expect((await post(person, { userId: id, enabled: true })).response.status).toBe(403);
    const row = await env.DB.prepare('SELECT is_admin_viewer FROM users WHERE user_id = ?').bind(id).first();
    expect(row.is_admin_viewer).toBe(0);
  });

  it('gives and removes the role, writes each change to the admin log, and the account then reads (and cannot write)', async () => {
    const fleet = await fleetAccount('viewer-grant-fleet');
    const id = await idOf(fleet);
    expect((await api('/auth/admin-users', fleet.session())).response.status).toBe(403);

    const granted = await post(admin, { userId: id, enabled: true });
    expect(granted.response.status).toBe(200);
    expect(granted.body).toMatchObject({ adminViewer: true, changed: true });
    expect((await logRows('admin_viewer_granted', id))).toHaveLength(1);
    expect((await api('/auth/admin-users', fleet.session())).response.status).toBe(200);
    const write = await api('/auth/admin-delete-account', fleet.session({ method: 'POST', body: JSON.stringify({ userId: id, confirmUsername: 'x' }) }));
    expect(write.response.status).toBe(403);

    const detail = await api(`/auth/admin-user-detail?userId=${id}`, admin.session());
    expect(detail.body.user).toMatchObject({ adminViewer: true, adminViewerRefusal: null });

    const again = await post(admin, { userId: id, enabled: true });
    expect(again.body.changed).toBe(false); // nothing to change, so no second log row
    expect(await logRows('admin_viewer_granted', id)).toHaveLength(1);

    const removed = await post(admin, { userId: id, enabled: false });
    expect(removed.body).toMatchObject({ adminViewer: false, changed: true });
    expect(await logRows('admin_viewer_removed', id)).toHaveLength(1);
    expect((await api('/auth/admin-users', fleet.session())).response.status).toBe(403);
  });

  it('refuses a person, an admin, an assistant and a deleted account, each with its reason, and changes nothing', async () => {
    const person = await signupBuilder('viewer-grant-ordinary');
    const personId = await idOf(person);
    const refused = await post(admin, { userId: personId, enabled: true });
    expect(refused.response.status).toBe(409);
    expect(refused.body.error).toMatch(/only for a fleet account/i);

    const adminRefused = await post(admin, { userId: await idOf(admin), enabled: true });
    expect(adminRefused.response.status).toBe(409);
    expect(adminRefused.body.error).toMatch(/already has full access/i);

    // An assistant's name is reserved at sign-up, so make an ordinary fleet account and give it one directly.
    const assistant = await fleetAccount('viewer-grant-assistant');
    await env.DB.prepare("UPDATE users SET username = 'Juniper' WHERE email = ?").bind(assistant.email).run();
    const assistantRefused = await post(admin, { userId: await idOf(assistant), enabled: true });
    expect(assistantRefused.response.status).toBe(409);
    expect(assistantRefused.body.error).toMatch(/assistant/i);

    const gone = await fleetAccount('viewer-grant-gone');
    const goneId = await idOf(gone);
    await env.DB.prepare("UPDATE users SET deleted_at = '2026-11-01T00:00:00.000Z' WHERE user_id = ?").bind(goneId).run();
    expect((await post(admin, { userId: goneId, enabled: true })).response.status).toBe(409);

    const rows = await env.DB.prepare('SELECT count(*) AS n FROM users WHERE is_admin_viewer = 1 AND email IN (?, ?)').bind(person.email, assistant.email).first();
    expect(rows.n).toBe(0);
  });

  it('can always remove the role, even from an account that no longer qualifies', async () => {
    const fleet = await fleetAccount('viewer-grant-lapsed');
    const id = await idOf(fleet);
    await post(admin, { userId: id, enabled: true });
    await env.DB.prepare('UPDATE users SET is_fleet = 0 WHERE user_id = ?').bind(id).run();
    const detail = await api(`/auth/admin-user-detail?userId=${id}`, admin.session());
    expect(detail.body.user.adminViewer).toBe(true);
    expect(detail.body.user.adminViewerRefusal).toMatch(/fleet account/i);
    expect((await post(admin, { userId: id, enabled: false })).response.status).toBe(200);
  });

  it('checks its input', async () => {
    expect((await post(admin, { enabled: true })).response.status).toBe(400);
    const fleet = await fleetAccount('viewer-grant-input');
    expect((await post(admin, { userId: await idOf(fleet), enabled: 'yes' })).response.status).toBe(400);
    expect((await post(admin, { userId: 'no-such-user', enabled: true })).response.status).toBe(404);
  });
});

describe('the look-only admin on the dashboard page (#4175, slice d)', () => {
  const page = (who, path = '/admin/dashboard') => SELF.fetch(`https://higglehaven.test${path}`, who.session());
  const opens = async (id) => (await env.DB.prepare("SELECT count(*) AS n FROM admin_action_log WHERE action_type = 'admin_viewer_page_open' AND admin_user_id = ? AND target_id = '/admin/dashboard'").bind(id).first()).n;

  it('is let past the dashboard gate only once given the role', async () => {
    const fleet = await fleetAccount('viewer-page-fleet');
    expect((await page(fleet)).status).toBe(403);
    await post(admin, { userId: await idOf(fleet), enabled: true });
    const opened = await page(fleet);
    expect(opened.status).not.toBe(401);
    expect(opened.status).not.toBe(403);
  });

  it('is told which dashboard it has, and each ask by a viewer is written to the admin log', async () => {
    const fleet = await fleetAccount('viewer-page-role');
    const id = await idOf(fleet);
    expect((await api('/auth/admin-role', fleet.session())).response.status).toBe(403);
    await post(admin, { userId: id, enabled: true });
    const asked = await api('/auth/admin-role', fleet.session());
    expect(asked.body).toEqual({ role: 'viewer' });
    expect(await opens(id)).toBe(1);
    await api('/auth/admin-role', fleet.session());
    expect(await opens(id)).toBe(2);
    // An admin is told so and is not logged as a viewer.
    expect((await api('/auth/admin-role', admin.session())).body).toEqual({ role: 'admin' });
    expect(await opens(await idOf(admin))).toBe(0);
  });

  it('is not let into the other admin pages', async () => {
    const fleet = await fleetAccount('viewer-page-other');
    await post(admin, { userId: await idOf(fleet), enabled: true });
    expect((await page(fleet, '/admin/control-room')).status).toBe(403);
    expect((await page(fleet, '/admin/action-log')).status).toBe(403);
  });
});
