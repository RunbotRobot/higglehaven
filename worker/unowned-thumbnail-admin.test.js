// #4437: a seeded placeholder has no owning seller, so no seller could ever store its thumbnail and
// grid and Prompt mode could never match it. A real admin's browser may; nobody else may.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let admin;
let viewer;
let person;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  admin = await signupAdmin('unowned-thumb-admin');
  viewer = await signupBuilder('unowned-thumb-viewer');
  await env.DB.prepare('UPDATE users SET is_admin_viewer = 1 WHERE email = ?').bind(viewer.email).run();
  person = await signupBuilder('unowned-thumb-person');
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({ templateId: 'unowned-thumb-template', name: 'Seeded thing', color: '#445566', dimensions: { width: 1, depth: 1, height: 1 } }),
  });
  expect(created.response.status).toBe(201);
});

const upload = (who) => api('/catalog/unowned-thumb-template/thumbnail', who.session({
  method: 'POST',
  body: JSON.stringify({ imageDataUrl: PNG, embedding: Array.from({ length: 192 }, () => 0.5) }),
}));

describe('POST /api/catalog/:id/thumbnail on a template with no owner (#4437)', () => {
  it('refuses a signed-in person and a look-only viewer', async () => {
    expect((await upload(person)).response.status).toBe(403);
    expect((await upload(viewer)).response.status).toBe(403);
  });
  it('lets an admin store the thumbnail and the grid', async () => {
    const done = await upload(admin);
    expect(done.response.status).toBe(200);
    const row = await env.DB.prepare('SELECT image_url, image_embedding FROM catalog_templates WHERE template_id = ?').bind('unowned-thumb-template').first();
    expect(row.image_url).toBe(done.body.imageUrl);
    expect(JSON.parse(row.image_embedding)).toHaveLength(192);
  });
});
