import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupSeller } from './test-helpers.js';

// #4541: the seller's Orders list used to stop at the newest 100 with no way to the older ones, so a seller with more
// sales than that could not Mark shipped or Refund an old order. It pages by cursor now, newest first.
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('GET /purchases?mine=seller pages by cursor (#4541)', () => {
  it('walks every order newest first with nothing skipped or repeated, and refuses a bad limit or cursor', async () => {
    const seller = await signupSeller('orders-page-seller');
    const host = await signupBuilder('orders-page-host');
    await api('/catalog', seller.session({
      method: 'POST',
      body: JSON.stringify({ templateId: 'orders-page-t', name: 'Paged product', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 100, sellerId: seller.sellerId }),
    }));
    for (let n = 1; n <= 7; n += 1) {
      await env.DB.prepare(`
        INSERT INTO purchases (purchase_id, instance_id, template_id, seller_id, builder_id, unit_price_cents, quantity,
          total_cents, commission_cents, builder_share_cents, platform_share_cents, created_at)
        VALUES (?, 'orders-page-i', 'orders-page-t', ?, ?, 100, 1, 100, 2, 1, 1, ?)
      `).bind(`orders-page-p${n}`, seller.sellerId, host.builderId, `2026-01-0${n}T00:00:00.000Z`).run();
    }
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const query = new URLSearchParams({ mine: 'seller', limit: '3' });
      if (cursor) query.set('cursor', cursor);
      const page = await api(`/purchases?${query}`, seller.session());
      expect(page.response.status).toBe(200);
      expect(page.body.totalCount).toBe(7);
      seen.push(...page.body.purchases.map((p) => p.purchaseId));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1].map((n) => `orders-page-p${n}`));

    // Without a limit the first page is the usual 100, and the whole list fits, so no cursor.
    const all = await api('/purchases?mine=seller', seller.session());
    expect(all.body.purchases).toHaveLength(7);
    expect(all.body.nextCursor).toBeNull();
    expect((await api('/purchases?mine=seller&limit=0', seller.session())).response.status).toBe(400);
    expect((await api('/purchases?mine=seller&cursor=nope', seller.session())).response.status).toBe(400);
  });
});
