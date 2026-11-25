// #4287: seller-less catalog creation is limited per address, and a batch may carry only so many of them.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const template = (id) => ({ templateId: id, name: id, category: 'limit-test', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 100 });

describe('seller-less catalog creation (#4287)', () => {
  it('429s a single create once the address has used its allowance', async () => {
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 120 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind('catalog-create-anonymous:anon-limit-ip', now)));
    const refused = await api('/catalog', { method: 'POST', headers: { 'cf-connecting-ip': 'anon-limit-ip' }, body: JSON.stringify(template('anon-limit-a')) });
    expect(refused.response.status).toBe(429);
  });

  it('refuses a batch with more seller-less products than the cap', async () => {
    const templates = Array.from({ length: 51 }, (_, i) => template(`anon-batch-${i}`));
    const refused = await api('/catalog/batch', { method: 'POST', body: JSON.stringify({ templates }) });
    expect(refused.response.status).toBe(400);
    expect(refused.body.error).toMatch(/at most 50/);
  });
});
