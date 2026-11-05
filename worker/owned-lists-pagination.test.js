// #1132 / #1303: GET /api/builders/me/avatars and /animations used to return
// every owned row in one unbounded SELECT. They are now cursor-paginated
// (newest purchase first), like the sibling list endpoints.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createTemplate(templateId, category) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId, name: `Owned ${templateId}`, category, color: '#654321',
      dimensions: { width: 1, depth: 1, height: 2 }, priceCents: 500,
    }),
  });
  expect(created.response.status).toBe(201);
}

async function builderIdFor(account) {
  const me = await api('/builders/me', account.session());
  return me.body.builder.builderId;
}

// Three rows: two share a purchased_at (the template_id tiebreak decides),
// one is older. Newest first: c, b (same timestamp, id order desc), a.
async function seedOwned(table, category, prefix, builderId) {
  const ids = ['a', 'b', 'c'].map((suffix) => `${prefix}-${suffix}`);
  for (const id of ids) await createTemplate(id, category);
  const stamps = ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'];
  for (let i = 0; i < ids.length; i += 1) {
    await env.DB.prepare(`INSERT INTO ${table} (builder_id, template_id, purchased_at) VALUES (?, ?, ?)`)
      .bind(builderId, ids[i], stamps[i]).run();
  }
  return ids;
}

describe.each([
  { path: '/builders/me/avatars', key: 'avatars', table: 'owned_avatars', category: 'avatar', prefix: 'pg-avatar' },
  { path: '/builders/me/animations', key: 'animations', table: 'owned_animations', category: 'animation', prefix: 'pg-anim' },
])('Owned list pagination ($path)', ({ path, key, table, category, prefix }) => {
  it('pages newest-first with a stable cursor and ends with a null nextCursor', async () => {
    const account = await signupBuilder(`${prefix}-owner`);
    const [a, b, c] = await seedOwned(table, category, prefix, await builderIdFor(account));

    const first = await api(`${path}?limit=2`, account.session());
    expect(first.response.status).toBe(200);
    expect(first.body[key].map((t) => t.templateId)).toEqual([c, b]);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await api(`${path}?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, account.session());
    expect(second.response.status).toBe(200);
    expect(second.body[key].map((t) => t.templateId)).toEqual([a]);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body[key][0].purchasedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns everything with a null nextCursor when it fits one page, and rejects a bad limit or cursor', async () => {
    const account = await signupBuilder(`${prefix}-small`);
    await seedOwned(table, category, `${prefix}-s`, await builderIdFor(account));

    const all = await api(path, account.session());
    expect(all.body[key]).toHaveLength(3);
    expect(all.body.nextCursor).toBeNull();

    expect((await api(`${path}?limit=0`, account.session())).response.status).toBe(400);
    expect((await api(`${path}?cursor=not-a-cursor`, account.session())).response.status).toBe(400);
  });

  it('never leaks another builder\'s rows into a page', async () => {
    const owner = await signupBuilder(`${prefix}-priv-owner`);
    const stranger = await signupBuilder(`${prefix}-priv-stranger`);
    await seedOwned(table, category, `${prefix}-p`, await builderIdFor(owner));

    const listed = await api(`${path}?limit=2`, stranger.session());
    expect(listed.body[key]).toEqual([]);
    expect(listed.body.nextCursor).toBeNull();
  });
});
