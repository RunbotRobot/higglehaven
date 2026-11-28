// #4232: the admin pages' own static files (the pages, scripts and styles) are served only to an admin, or to a
// look-only admin for the dashboard's files. Everyone else gets the plain 404 any unknown path gets.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { signupBuilder, signupAdmin } from './test-helpers.js';
import { gateAdminStaticFile } from './lib/control-room.js';

let admin;
let person;
let viewer;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('static-gate-admin');
  person = await signupBuilder('static-gate-person');
  viewer = await signupBuilder('static-gate-viewer');
  await env.DB.prepare('UPDATE users SET is_admin_viewer = 1 WHERE email = ?').bind(viewer.email).run();
});

const gate = async (path, who) => {
  const url = new URL(`https://higglehaven.test${path}`);
  const init = who ? who.session() : {};
  return gateAdminStaticFile(new Request(url, init), env, url);
};

const PATHS = ['/admin-dashboard', '/admin-dashboard.html', '/admin-dashboard.css', '/admin-dashboard-1.js', '/admin-dashboard-10.js', '/admin-tables.js', '/admin-money.js'];
const STRICT = ['/admin-control-room', '/admin-control-room.html', '/admin-control-room.js', '/admin-action-log', '/admin-action-log.css'];

describe('the admin pages static files (#4232)', () => {
  it('refuses a signed-out caller and an ordinary person with a plain 404, and serves an admin', async () => {
    for (const path of [...PATHS, ...STRICT]) {
      const signedOut = await gate(path);
      expect(signedOut.status, `signed out ${path}`).toBe(404);
      expect((await gate(path, person)).status, `person ${path}`).toBe(404);
      expect(await gate(path, admin), `admin ${path}`).toBeNull();
    }
  });

  it("lets a look-only admin have the dashboard's files and not the Control Room's or the Action Log's", async () => {
    for (const path of PATHS) expect(await gate(path, viewer), `viewer ${path}`).toBeNull();
    for (const path of STRICT) expect((await gate(path, viewer)).status, `viewer ${path}`).toBe(404);
  });

  it('leaves every other path alone', async () => {
    for (const path of ['/', '/index.html', '/admin-something-else.js', '/administrator.html', '/assets/admin-dashboard.js']) {
      expect(await gate(path), path).toBeNull();
    }
  });

  it('is applied by the Worker itself, ahead of the static file', async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin-dashboard-5.js');
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Not found'); // the gate's answer, not the missing-asset page
  });
});
