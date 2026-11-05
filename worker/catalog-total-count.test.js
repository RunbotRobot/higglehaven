// #1757: GET /api/catalog's first page reports totalCount (the rows matching
// the filters at that moment) so a paging client can notice a row that moved
// behind its cursor and re-fetch the gap. Later pages omit it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function createTemplate(templateId, category) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId, name: `Total ${templateId}`, category, color: '#654321',
      dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
    }),
  });
  expect(created.response.status).toBe(201);
}

describe('GET /api/catalog totalCount (#1757)', () => {
  it('reports the filtered total on the first page only, ignoring the page size', async () => {
    for (const id of ['tc-a', 'tc-b', 'tc-c']) await createTemplate(id, 'tc-category');
    await createTemplate('tc-other', 'tc-other-category');

    const first = await api('/catalog?category=tc-category&limit=2');
    expect(first.body.templates).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    expect(first.body.totalCount).toBe(3);

    const second = await api(`/catalog?category=tc-category&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.templates).toHaveLength(1);
    expect('totalCount' in second.body).toBe(false);
  });

  it('counts a single-page result too', async () => {
    const only = await api('/catalog?category=tc-other-category');
    expect(only.body.totalCount).toBe(1);
    expect(only.body.nextCursor).toBeNull();
  });
});
