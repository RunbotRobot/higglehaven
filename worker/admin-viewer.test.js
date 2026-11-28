// #4175: the look-only admin role. A viewer (users.is_admin_viewer) can read the admin routes that opted in and
// is refused everywhere else, by default: it is not an admin, so every admin check that reads is_admin turns it
// away, and the only way in is requireAdminOrViewer, which only ever lets GET and HEAD through.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';
import { maskEmail } from './lib/admin-viewer-mask.js';

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

// #4382: the dashboard's own read routes, decided one by one. A route is open to a look-only admin only when
// nothing personal, financial, ID or evidence comes back (a payload with an email carries it masked, see below).
// Moving a path between these two lists is a reviewed decision, and this is where a reviewer sees it.
const VIEWER_OPEN_READS = [
  '/auth/admins', // names and roles, emails masked
  '/models/storage', // byte counts against the storage cap
  '/land-candidates', // geometry only
  '/land-candidate-rings', // geometry and counts only
  '/tax-education', // authored text; the reviewing account's id is withheld
];
const VIEWER_CLOSED_READS = [
  '/models', // lists every upload with the product, video job and Control Room card that references it
  '/tax/admin-forms', // sellers' tax form detail
  '/purchases?danglingSeller=1', // buyers' and sellers' orders
  '/product-flags', // who flagged what
  '/self-dealing-flags', // who is suspected of what
  '/ncmec-reports', // evidence records
  '/auth/suspension-status?email=nobody@example.com', // looks an account up by its email
  '/admin-items-outside-landlets', // other builders' placed items
  '/admin-action-log', // the admin log
  '/auth/admin-purchase-disputes', // #4651: an order's seller, product and evidence state
];

describe('which dashboard reads a look-only admin gets (#4382)', () => {
  it('opens exactly the listed reads and refuses exactly the listed ones, and an ordinary person gets neither', async () => {
    for (const path of VIEWER_OPEN_READS) {
      expect((await api(path, viewer.session())).response.status, `viewer on GET ${path}`).toBe(200);
      expect((await api(path, admin.session())).response.status, `admin on GET ${path}`).toBe(200);
      expect((await api(path, target.session())).response.status, `person on GET ${path}`).toBe(403);
    }
    for (const path of VIEWER_CLOSED_READS) {
      expect((await api(path, viewer.session())).response.status, `viewer on GET ${path}`).toBe(403);
      expect((await api(path, target.session())).response.status, `person on GET ${path}`).toBe(403);
    }
  });

  it('masks an admin\'s email on the roster, and withholds the reviewer of a tax education entry', async () => {
    const adminId = await userIdOf(admin.email);
    const roster = (who) => api('/auth/admins', who.session()).then((r) => r.body.admins.find((a) => a.userId === adminId).email);
    expect(await roster(admin)).toBe(admin.email);
    expect(await roster(viewer)).toBe(maskEmail(admin.email));

    await env.DB.prepare(`INSERT INTO tax_education_content (content_id, country_code, state_code, title, body, reviewed_at, reviewed_by)
      VALUES ('tax-edu-viewer-test', 'US', NULL, 'Title', 'Body', '2026-11-01T00:00:00.000Z', ?)`).bind(adminId).run();
    const entry = (who) => api('/tax-education/tax-edu-viewer-test', who.session()).then((r) => r.body.entry);
    expect((await entry(admin)).reviewedBy).toBe(adminId);
    const seen = await entry(viewer);
    expect(seen.reviewedBy).toBeNull();
    expect(seen.title).toBe('Title');
    const listed = (await api('/tax-education', viewer.session())).body.entries.find((e) => e.id === 'tax-edu-viewer-test');
    expect(listed.reviewedBy).toBeNull();
  });

  it('still refuses a look-only admin every write on the routes it may read', async () => {
    for (const [method, path] of [['POST', '/tax-education'], ['PATCH', '/tax-education/x'], ['DELETE', '/tax-education/x'], ['POST', '/models/cleanup'], ['POST', '/world/expand'], ['PATCH', '/land-candidates/x'], ['DELETE', '/land-candidates/x'], ['POST', '/land-candidates/generate-ring'], ['POST', '/auth/revoke-admin']]) {
      const attempt = await api(path, viewer.session({ method, body: '{}' }));
      expect(attempt.response.status, `viewer on ${method} ${path}`).toBe(403);
    }
  });
});

describe('what a look-only admin does not see (#4175, slice b)', () => {
  it('masks an email so its shape reads and the address does not', () => {
    expect(maskEmail('jane.doe@gmail.com')).toBe('j***@g***.com');
    expect(maskEmail('a@b.co.uk')).toBe('a***@b***.uk');
    expect(maskEmail('weird@localhost')).toBe('w***@l***');
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('no-at-sign')).toBe('***');
  });

  it('shows the same rows to an admin in full and to a viewer masked, in every place an email appears', async () => {
    const id = await userIdOf(target.email);
    const masked = maskEmail(target.email);
    expect(masked).not.toBe(target.email);

    const table = (who) => api('/auth/admin-users', who.session()).then((r) => r.body.users.find((u) => u.userId === id));
    expect((await table(admin)).email).toBe(target.email);
    const viewerRow = await table(viewer);
    expect(viewerRow.email).toBe(masked);
    expect(viewerRow.username).toBe('viewer-test-target'); // everything else still reads

    const detail = (who) => api(`/auth/admin-user-detail?userId=${id}`, who.session()).then((r) => r.body.user.email);
    expect(await detail(admin)).toBe(target.email);
    expect(await detail(viewer)).toBe(masked);

    const preview = (who) => api(`/auth/admin-delete-account-preview?userId=${id}`, who.session()).then((r) => r.body.account.email);
    expect(await preview(admin)).toBe(target.email);
    expect(await preview(viewer)).toBe(masked);

    const search = (who, q) => api(`/auth/admin-user-search?q=${encodeURIComponent(q)}`, who.session()).then((r) => r.body.users.map((u) => ({ id: u.userId, email: u.email })));
    expect((await search(viewer, 'viewer-test-target')).find((u) => u.id === id).email).toBe(masked);
  });

  it('does not let a viewer find an account by its email, which would reveal that the address exists', async () => {
    const id = await userIdOf(target.email);
    const search = (who) => api(`/auth/admin-user-search?q=${encodeURIComponent(target.email)}`, who.session()).then((r) => r.body.users.map((u) => u.userId));
    expect(await search(admin)).toContain(id);
    expect(await search(viewer)).not.toContain(id);
  });

  it('hides card details, tax form details and free-text evidence notes from a viewer', async () => {
    const id = await userIdOf(target.email);
    await env.DB.prepare(`UPDATE users SET card_funding = 'credit', card_refusal_code = 'card_declined', card_refusal_count = 2,
      card_refusal_at = '2026-11-01T00:00:00.000Z', tax_form_type = 'w9', tax_form_completed_at = '2026-11-02T00:00:00.000Z' WHERE user_id = ?`).bind(id).run();
    await env.DB.prepare(`INSERT INTO account_suspensions (suspension_id, user_id, admin_user_id, reason, evidence_note, grace_period_ends_at, lifted_at)
      VALUES ('susp-viewer-test', ?, ?, 'test', 'private evidence text', '2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z')`).bind(id, await userIdOf(admin.email)).run();

    const adminRow = (await api('/auth/admin-users', admin.session())).body.users.find((u) => u.userId === id);
    expect(adminRow.cardFunding).toBe('credit');
    expect(adminRow.taxFormType).toBe('w9');
    const viewerRow = (await api('/auth/admin-users', viewer.session())).body.users.find((u) => u.userId === id);
    for (const key of ['cardFunding', 'cardRefusalCount', 'cardRefusalCode', 'cardRefusalAt', 'taxFormType', 'taxFormCompletedAt']) {
      expect(viewerRow[key], key).toBeNull();
    }

    const adminDetail = (await api(`/auth/admin-user-detail?userId=${id}`, admin.session())).body;
    expect(adminDetail.user.cardRefusal.code).toBe('card_declined');
    expect(adminDetail.suspensions[0].evidenceNote).toBe('private evidence text');
    const viewerDetail = (await api(`/auth/admin-user-detail?userId=${id}`, viewer.session())).body;
    expect(viewerDetail.user.cardRefusal).toBeNull();
    expect(viewerDetail.suspensions[0].evidenceNote).toBeNull();
    expect(viewerDetail.suspensions[0].reason).toBe('test'); // the reason is not personal data and still reads
    expect(JSON.stringify(viewerDetail)).not.toContain('private evidence text');
  });
});

describe('everything that changes something refuses a look-only admin (#4175)', () => {
  it('answers 403 on every admin write, and nothing changed', async () => {
    const id = await userIdOf(target.email);
    const writes = [
      ['POST', '/auth/admin-delete-account', { userId: id, confirmUsername: 'viewer-test-target' }],
      ['POST', '/auth/admin-rename-account', { userId: id, newUsername: 'ViewerRenamed' }], // #4407
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
    './lib/admin-viewer-grant.js', // GET admin-role, which the dashboard page asks when it opens
    './lib/control-room.js', // the /admin/dashboard page gate only (the Control Room API and its page stay admin-only)
    './lib/counterfeit-refunds.js', // #4376: GET only, what Refund buyers would do; the POST needs a full admin
    './lib/models.js', // GET models/storage only (the upload listing stays closed)
    './lib/tax-education.js', // the two GET reads (#4382)
    './lib/world-generation.js', // the land candidate and ring GET reads (#4382)
  ];

  it('only the listed files call requireAdminOrViewer', () => {
    const callers = Object.entries(sources)
      .filter(([path, text]) => path !== './lib/auth.js' && /requireAdminOrViewer\(/.test(text))
      .map(([path]) => path)
      .sort();
    expect(callers).toEqual(OPTED_IN);
  });

  it('and each calls it exactly as many times as listed, so a new opt-in inside a listed file fails here too', () => {
    // models.js holds handleModelListing, which lists the product, video job and Control Room card behind every upload
    // and stays closed to a viewer; tax-education.js and world-generation.js hold writes. A second call in any of them
    // is a new route a viewer can read, and is decided here, on purpose (#4382).
    const COUNTS = {
      './lib/account-moderation.js': 3, './lib/admin-delete-account.js': 1, './lib/admin-landlet-search.js': 1,
      './lib/admin-users-table.js': 1, './lib/admin-video-jobs.js': 1, './lib/models.js': 1, './lib/tax-education.js': 2,
      './lib/world-generation.js': 4, './lib/admin-viewer-grant.js': 1, './lib/control-room.js': 2, './lib/counterfeit-refunds.js': 1,
    };
    expect(Object.keys(COUNTS).sort()).toEqual(OPTED_IN);
    for (const path of OPTED_IN) {
      expect(sources[path].match(/requireAdminOrViewer\(/g)?.length, path).toBe(COUNTS[path]);
    }
  });

  it('every call site is in a handler that is reached by a GET route or guards its own writes', () => {
    // The helper itself refuses any non-GET, so a handler that opts in can never let a viewer write; this
    // asserts the helper still says so, so a later edit that relaxes it fails here.
    expect(sources['./lib/auth.js']).toMatch(/user\.is_admin_viewer && \(request\.method === 'GET' \|\| request\.method === 'HEAD'\)/);
  });
});
