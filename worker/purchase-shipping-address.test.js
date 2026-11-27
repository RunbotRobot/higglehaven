import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder, signupSeller, grantAdminTo, glbFile, TEST_SHIPPING_ADDRESS } from './test-helpers.js';
import { finalizeSucceededPaymentIntent } from './lib/purchase-creation.js';

// #4599 (shipping, 2/8; owner decision 2026-11-27, option B): a shipped product is bought with an address. The server
// refuses a purchase with none, or an incomplete one, or one to a country the seller does not send to, all before any
// card is touched; the order keeps its own copy; digital goods never ask. Admin no-card path here (the card path's
// metadata is checked below with Stripe mocked).
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('shipaddr-admin')).session;
});

async function setup(tag, { category = 'furniture', metadata, withModel } = {}) {
  let modelUrl;
  if (withModel) {
    const form = new FormData();
    form.set('file', glbFile());
    modelUrl = (await (await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form })).json()).modelUrl;
  }
  const seller = await signupBuilder(`shipaddr-seller-${tag}`);
  const landletId = `shipaddr-landlet-${tag}`;
  expect((await api('/landlets', adminSession({ method: 'POST', body: JSON.stringify({ landletId, name: landletId, areaM2: 1000, status: 'greenbelt' }) }))).response.status).toBe(201);
  expect((await api(`/landlets/${landletId}/claim`, seller.session({ method: 'POST' }))).response.status).toBe(200);
  const templateId = `shipaddr-template-${tag}`;
  const created = await api('/catalog', { method: 'POST', body: JSON.stringify({
    templateId, name: `Thing ${tag}`, category, color: '#654321', dimensions: { width: 1, depth: 1, height: 2 }, priceCents: 500, ...(metadata ? { metadata } : {}), ...(modelUrl ? { modelUrl } : {}),
  }) });
  expect(created.response.status, JSON.stringify(created.body)).toBe(201);
  const instanceId = `shipaddr-instance-${tag}`;
  expect((await api('/instances', seller.session({ method: 'POST', body: JSON.stringify({ instanceId, landletId, templateId, x: 1, y: 0 }) }))).response.status).toBe(201);
  await grantAdminTo(seller);
  return { seller, instanceId, templateId };
}
const buy = (instanceId, buyer, body) => api(`/instances/${instanceId}/purchase`, buyer.session({ method: 'POST', body: JSON.stringify(body) }));
const orders = async (templateId) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases WHERE template_id = ?').bind(templateId).first()).n;

describe('a shipped product is bought with an address (#4599)', () => {
  it('refuses a purchase with no address, saying why and that nothing was charged, and writes nothing', async () => {
    const { seller, instanceId, templateId } = await setup('none');
    const refused = await buy(instanceId, seller, { shippingAddress: null });
    expect(refused.response.status).toBe(400);
    expect(refused.body.code).toBe('shipping_address_required');
    expect(refused.body.error).toContain('not charged');
    expect(await orders(templateId)).toBe(0);
  });

  it('refuses an incomplete or unknown address with the missing line named', async () => {
    const { seller, instanceId, templateId } = await setup('bad');
    const attempt = (change) => buy(instanceId, seller, { shippingAddress: { ...TEST_SHIPPING_ADDRESS, ...change } });
    for (const [change, words] of [
      [{ name: '' }, 'name'], [{ line1: '  ' }, 'street'], [{ city: '' }, 'city'], [{ postalCode: '' }, 'postal'],
      [{ region: '' }, 'state'], [{ country: '' }, 'country'], [{ country: 'ZZ' }, 'country from the list'],
      [{ line1: 'x'.repeat(81) }, 'Shorten'],
    ]) {
      const refused = await attempt(change);
      expect(refused.response.status, JSON.stringify(change)).toBe(400);
      expect(refused.body.code).toBe('shipping_address_invalid');
      expect(refused.body.error).toContain(words);
    }
    expect(await orders(templateId)).toBe(0);
  });

  it('keeps the address on the order as its own copy, cleaned, and shows it to the buyer in My purchases', async () => {
    const { seller, instanceId, templateId } = await setup('keep');
    const bought = await buy(instanceId, seller, { shippingAddress: { ...TEST_SHIPPING_ADDRESS, name: '  Ada   Lovelace ', country: 'us', line2: 'Apt 4' } });
    expect(bought.response.status).toBe(201);
    const row = await env.DB.prepare('SELECT shipping_address_json FROM purchases WHERE template_id = ?').bind(templateId).first();
    expect(JSON.parse(row.shipping_address_json)).toEqual({ ...TEST_SHIPPING_ADDRESS, name: 'Ada Lovelace', country: 'US', line2: 'Apt 4' });
    const mine = await api('/purchases/mine', seller.session());
    expect(mine.body.purchases[0].shippingAddress).toMatchObject({ name: 'Ada Lovelace', line1: '1 Test Street', country: 'US' });
    // The order is its own record: nothing done to any saved address later reaches it (there is only this copy).
    const again = await api('/purchases/mine', seller.session());
    expect(again.body.purchases[0].shippingAddress.line2).toBe('Apt 4');
  });

  it('refuses a country the seller does not send to, before anything is written, and allows the United States', async () => {
    const { seller, instanceId, templateId } = await setup('domestic', { metadata: { domesticOnly: true } });
    const quote = await api(`/instances/${instanceId}/purchase-quote`, seller.session());
    expect(quote.body).toMatchObject({ requiresShippingAddress: true, domesticOnly: true });
    const refused = await buy(instanceId, seller, { shippingAddress: { ...TEST_SHIPPING_ADDRESS, country: 'FR', region: '' } });
    expect(refused.response.status).toBe(409);
    expect(refused.body.code).toBe('not_shippable_there');
    expect(await orders(templateId)).toBe(0);
    expect((await buy(instanceId, seller, { shippingAddress: TEST_SHIPPING_ADDRESS })).response.status).toBe(201);
  });

  it('never asks for an address for an avatar or an animation, or a product marked a digital good', async () => {
    for (const [tag, options] of [['avatar', { category: 'avatar' }], ['animation', { category: 'animation' }], ['digital', { metadata: { digitalGoodDisclaimer: 'art-file' }, withModel: true }]]) {
      const { seller, instanceId, templateId } = await setup(`d-${tag}`, options);
      const quote = await api(`/instances/${instanceId}/purchase-quote`, seller.session());
      expect(quote.body.requiresShippingAddress).toBe(false);
      expect((await buy(instanceId, seller, { shippingAddress: null })).response.status).toBe(201);
      const row = await env.DB.prepare('SELECT shipping_address_json FROM purchases WHERE template_id = ?').bind(templateId).first();
      expect(row.shipping_address_json).toBeNull();
    }
  });
});

describe('the card path carries the address from checkout to the order (#4599)', () => {
  it('puts it in the PaymentIntent metadata and writes it from there at finalize', async () => {
    const seller = await signupSeller('shipaddr-card-seller');
    const buyer = await signupAdmin('shipaddr-card-buyer');
    const landletId = 'shipaddr-card-landlet';
    expect((await api('/landlets', adminSession({ method: 'POST', body: JSON.stringify({ landletId, name: landletId, areaM2: 1000, status: 'greenbelt' }) }))).response.status).toBe(201);
    expect((await api(`/landlets/${landletId}/claim`, buyer.session({ method: 'POST' }))).response.status).toBe(200);
    const templateId = 'shipaddr-card-template';
    expect((await api('/catalog', seller.session({ method: 'POST', body: JSON.stringify({
      templateId, name: 'Card thing', color: '#123456', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500, sellerId: seller.sellerId,
    }) }))).response.status).toBe(201);
    const instanceId = 'shipaddr-card-instance';
    expect((await api('/instances', buyer.session({ method: 'POST', body: JSON.stringify({ instanceId, landletId, templateId, x: 1, y: 0 }) }))).response.status).toBe(201);
    // The seller is connected for card payments (the same fixture the quote tests use).
    await env.DB.prepare("UPDATE sellers SET stripe_account_id = 'acct_shipaddr', stripe_onboarding_status = 'complete', stripe_updated_at = ? WHERE seller_id = ?")
      .bind(new Date().toISOString(), seller.sellerId).run();
    const originalFetch = globalThis.fetch;
    env.STRIPE_SECRET_KEY = 'test-stripe-key';
    let created = null;
    globalThis.fetch = async (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (url.includes('stripe.com')) {
        if (url.endsWith('/payment_intents')) created = String(init?.body || '');
        return new Response(JSON.stringify({ id: 'pi_shipaddr', client_secret: 'cs_shipaddr' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    };
    let metadataAddress;
    try {
      const refused = await buy(instanceId, buyer, { shippingAddress: null });
      expect(refused.response.status).toBe(400);
      expect(created).toBeNull(); // refused before any payment was created
      const started = await buy(instanceId, buyer, { shippingAddress: TEST_SHIPPING_ADDRESS });
      expect(started.response.status, JSON.stringify(started.body)).toBe(200);
      expect(created).not.toBeNull();
      metadataAddress = new URLSearchParams(created).get('metadata[shippingAddress]');
    } finally {
      globalThis.fetch = originalFetch;
      env.STRIPE_SECRET_KEY = undefined;
    }
    expect(JSON.parse(metadataAddress)).toEqual(TEST_SHIPPING_ADDRESS);
    // Finalize writes the order from the PaymentIntent's own metadata, address included.
    const buyerBuilder = (await api('/builders/me', buyer.session())).body.builder;
    await finalizeSucceededPaymentIntent(env, {
      id: 'pi_shipaddr', status: 'succeeded',
      metadata: {
        instanceId, templateId, builderId: buyerBuilder.builderId, sellerId: seller.sellerId, quantity: '1', buyerLabel: '', unitPriceCents: '500', totalCents: '500',
        commissionCents: '10', builderShareCents: '5', platformShareCents: '5', isDigitalGood: 'false', buyerBuilderId: buyerBuilder.builderId,
        isAvatarCategory: 'false', isAnimationCategory: 'false', shippingAddress: metadataAddress,
      },
    });
    const row = await env.DB.prepare('SELECT shipping_address_json FROM purchases WHERE payment_intent_id = ?').bind('pi_shipaddr').first();
    expect(JSON.parse(row.shipping_address_json)).toEqual(TEST_SHIPPING_ADDRESS);
  });
});
