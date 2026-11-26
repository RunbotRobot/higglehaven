// #4462 (area 9, found reading the buying flow): the card hid Buy for an avatar or animation the shopper
// already owns, but the server did not refuse a second purchase, so a stale card or a second tab could buy
// again. Digital goods stay with their buyer for good; physical products can be bought again.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, grantAdminTo } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('already-owned-admin')).session;
});

async function setup(tag, category) {
  const seller = await signupBuilder(`already-owned-seller-${tag}`);
  const landletId = `already-owned-landlet-${tag}`;
  expect((await api('/landlets', adminSession({ method: 'POST', body: JSON.stringify({ landletId, name: landletId, areaM2: 1000, status: 'greenbelt' }) }))).response.status).toBe(201);
  expect((await api(`/landlets/${landletId}/claim`, seller.session({ method: 'POST' }))).response.status).toBe(200);
  const templateId = `already-owned-template-${tag}`;
  expect((await api('/catalog', { method: 'POST', body: JSON.stringify({
    templateId, name: `Thing ${tag}`, category, color: '#654321', dimensions: { width: 1, depth: 1, height: 2 }, priceCents: 500,
  }) })).response.status).toBe(201);
  for (const n of [1, 2]) {
    expect((await api('/instances', seller.session({ method: 'POST', body: JSON.stringify({ instanceId: `already-owned-instance-${tag}-${n}`, landletId, templateId, x: n, y: 0 }) }))).response.status).toBe(201);
  }
  await grantAdminTo(seller);
  return { seller, instance: (n) => `already-owned-instance-${tag}-${n}`, templateId };
}

const buy = (instanceId, buyer) => api(`/instances/${instanceId}/purchase`, buyer.session({ method: 'POST' }));
const count = async (templateId) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE template_id = ?').bind(templateId).first()).n;

describe('already-owned digital goods (#4462)', () => {
  for (const category of ['avatar', 'animation']) {
    it(`refuses a second purchase of an ${category} the buyer owns, before anything is written`, async () => {
      const { seller, instance, templateId } = await setup(category, category);
      expect((await buy(instance(1), seller)).response.status).toBe(201);
      const second = await buy(instance(2), seller);
      expect(second.response.status).toBe(409);
      expect(second.body.code).toBe('already_owned');
      expect(await count(templateId)).toBe(1);
      const quote = await api(`/instances/${instance(2)}/purchase-quote`, seller.session());
      expect(quote.response.status).toBe(409);
    });
  }

  it('still lets someone buy a physical product again', async () => {
    const { seller, instance, templateId } = await setup('physical', 'furniture');
    expect((await buy(instance(1), seller)).response.status).toBe(201);
    expect((await buy(instance(2), seller)).response.status).toBe(201);
    expect(await count(templateId)).toBe(2);
  });

  it('gives a buyer whose seller is not set up a coded refusal', async () => {
    const { seller, instance } = await setup('notready', 'furniture');
    const shopper = await signupBuilder('already-owned-notready-shopper');
    const refused = await buy(instance(1), shopper);
    expect(refused.response.status).toBe(403);
    expect(refused.body.code).toBe('seller_not_ready');
    expect(seller).toBeTruthy();
  });
});
