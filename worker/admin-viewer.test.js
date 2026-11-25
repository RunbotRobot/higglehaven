// #4175: the look-only admin role. A viewer (users.is_admin_viewer) can read the admin routes that opted in and
// is refused everywhere else, by default: it is not an admin, so every admin check that reads is_admin turns it
// away, and the only way in is requireAdminOrViewer, which only ever lets GET and HEAD through.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';

const sources = import.meta.glob(['./index.js', './lib/*.js'], { query: '?raw', import: 'default', eager: true });

let viewer;
let target;
let admin;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('viewer-test-admin');
  target = await signupBuilder('viewer-test-target');
  viewer = await signupBuilder('viewer-test-viewer');
  await env.DB.prepare('UPDATE users SET is_admin_viewer = 1 WHERE email = ?').bind(viewer.email).run();
});

const userIdOf = async (email) => (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(email).first()).user_id;

describe('the read routes a look-only admin may open (#4175)', () => {
  it('opens each one, and a plain signed-in person is still refused on each', async () => {
    const id = await userIdOf(target.email);
    const paths = [
      '/auth/admin-users',
      '/auth/admin-user-search?q=viewer-test',
      `/auth/admin-user-detail?userId=${id}`,
      '/auth/admin-landlet-search?q=a',
      `/auth/admin-delete-account-preview?userId=${id}`,
      '/admin-video-jobs',
    ];
    for (const path of paths) {
      const asViewer = await api(path, viewer.session());
      expect(asViewer.response.status, `viewer on GET ${path}`).toBe(200);
      const asPerson = await api(path, target.session());
      expect(asPerson.response.status, `person on GET ${path}`).toBe(403);
    }
  });
});

describe('everything that changes something refuses a look-only admin (#4175)', () => {
  it('answers 403 on every admin write, and nothing changed', async () => {
    const id = await userIdOf(target.email);
    const writes = [
      ['POST', '/auth/admin-delete-account', { userId: id, confirmUsername: 'viewer-test-target' }],
      ['POST', '/auth/grant-admin', { email: target.email }],
      ['POST', '/auth/suspend-account', { email: target.email }],
      ['POST', '/auth/unsuspend-account', { email: target.email }],
      ['POST', '/admin-video-jobs/anything/check', {}],
    ];
    for (const [method, path, body] of writes) {
      const attempt = await api(path, viewer.session({ method, body: JSON.stringify(body) }));
      expect(attempt.response.status, `viewer on ${method} ${path}`).toBe(403);
    }
    const still = await env.DB.prepare('SELECT is_admin, deleted_at FROM users WHERE user_id = ?').bind(id).first();
    expect(still.is_admin).toBe(0);
    expect(still.deleted_at).toBeNull();
  });

  it('is not an admin: it cannot become one or reach the owner-only routes that never opted in', async () => {
    const control = await api('/control-room/tasks', viewer.session());
    expect([401, 403]).toContain(control.response.status);
    const row = await env.DB.prepare('SELECT is_admin FROM users WHERE email = ?').bind(viewer.email).first();
    expect(row.is_admin).toBe(0);
  });

  it('requireAdminOrViewer lets a viewer through on GET and HEAD only, and always lets an admin through', async () => {
    const { requireAdminOrViewer } = await import('./lib/auth.js');
    const request = (account, method) => new Request('https://higglehaven.test/x', { method, headers: { cookie: account.session().headers.cookie } });
    for (const method of ['GET', 'HEAD']) {
      expect((await requireAdminOrViewer(request(viewer, method), env.DB)).adminViewer, method).toBe(true);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(requireAdminOrViewer(request(viewer, method), env.DB), method).rejects.toMatchObject({ status: 403 });
      expect((await requireAdminOrViewer(request(admin, method), env.DB)).adminViewer, method).toBeUndefined();
    }
  });
});

describe('opting a route in is a deliberate, listed act (#4175)', () => {
  // A new admin route is closed to a viewer unless its author calls requireAdminOrViewer. This list is the
  // whole set of files that do. Adding a file means adding it here, which is where a reviewer looks for
  // what a look-only admin can read (and, with the masking slice, what is hidden from one).
  const OPTED_IN = [
    './lib/account-moderation.js',
    './lib/admin-delete-account.js',
    './lib/admin-landlet-search.js',
    './lib/admin-users-table.js',
    './lib/admin-video-jobs.js',
  ];

  it('only the listed files call requireAdminOrViewer', () => {
    const callers = Object.entries(sources)
      .filter(([path, text]) => path !== './lib/auth.js' && /requireAdminOrViewer\(/.test(text))
      .map(([path]) => path)
      .sort();
    expect(callers).toEqual(OPTED_IN);
  });

  it('every call site is in a handler that is reached by a GET route or guards its own writes', () => {
    // The helper itself refuses any non-GET, so a handler that opts in can never let a viewer write; this
    // asserts the helper still says so, so a later edit that relaxes it fails here.
    expect(sources['./lib/auth.js']).toMatch(/user\.is_admin_viewer && \(request\.method === 'GET' \|\| request\.method === 'HEAD'\)/);
  });
});
