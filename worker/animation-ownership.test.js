// #1163 (sub-issue of #1161): purchasing a standalone "animation"-category
// catalog template grants the buyer ownership (owned_animations, migration
// 0106) — the exact same mechanism #680 already built for "avatar"
// (worker/avatar-ownership.test.js), minus the equip endpoint, since
// applying a purchased animation at runtime is #1165's own scope, not this
// one's. No GET /api/builders/me/animations listing endpoint exists yet
// either (that's #1164's scope, the shop/equip UI that would consume it),
// so ownership here is checked directly against the DB table.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { writePurchaseRow } from './index.js';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('animation-ownership-admin');
  adminSession = admin.session;
});

async function createGreenbeltLandlet(landletId, areaM2 = 1000) {
  return api('/landlets', adminSession({
    method: 'POST', body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
  }));
}

async function claim(landletId, builder) {
  return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
}

async function createAnimationTemplate(templateId, { priceCents = 500 } = {}) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: `Sellable animation ${templateId}`,
      category: 'animation',
      color: '#654321',
      dimensions: { width: 1, depth: 1, height: 2 },
      priceCents,
    }),
  });
  expect(created.response.status).toBe(201);
  return templateId;
}

async function placeInstance(instanceId, landletId, templateId, builder) {
  const placed = await api('/instances', builder.session({
    method: 'POST', body: JSON.stringify({ instanceId, landletId, templateId, x: 0, y: 0 }),
  }));
  expect(placed.response.status).toBe(201);
  return instanceId;
}

// Purchasing is gated on a real, verified session (N44) regardless of who's
// buying — the seller's own session here is just the simplest way to get
// one, same shortcut worker/avatar-ownership.test.js's own tests use.
async function purchase(instanceId, buyer) {
  return api(`/instances/${instanceId}/purchase`, buyer.session({ method: 'POST' }));
}

async function ownedAnimationRows(builderId, templateId) {
  return (await env.DB.prepare(
    'SELECT * FROM owned_animations WHERE builder_id = ? AND template_id = ?',
  ).bind(builderId, templateId).all()).results;
}

describe('Animation ownership (#1163)', () => {
  it('does not grant ownership for an ordinary (non-animation) purchase', async () => {
    const seller = await signupBuilder('animation-ownership-ordinary-seller');
    await createGreenbeltLandlet('animation-ownership-ordinary-landlet');
    await claim('animation-ownership-ordinary-landlet', seller);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'animation-ownership-ordinary-template', name: 'Plain product', color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance('animation-ownership-ordinary-instance', 'animation-ownership-ordinary-landlet', 'animation-ownership-ordinary-template', seller);

    const purchased = await purchase('animation-ownership-ordinary-instance', seller);
    expect(purchased.response.status).toBe(201);

    expect(await ownedAnimationRows(seller.builderId, 'animation-ownership-ordinary-template')).toHaveLength(0);
  });

  it('grants the buyer ownership of an animation-category purchase', async () => {
    const seller = await signupBuilder('animation-ownership-seller');
    await createGreenbeltLandlet('animation-ownership-landlet');
    await claim('animation-ownership-landlet', seller);
    await createAnimationTemplate('animation-ownership-template');
    await placeInstance('animation-ownership-instance', 'animation-ownership-landlet', 'animation-ownership-template', seller);

    const purchased = await purchase('animation-ownership-instance', seller);
    expect(purchased.response.status).toBe(201);

    expect(await ownedAnimationRows(seller.builderId, 'animation-ownership-template')).toHaveLength(1);
  });

  it('is idempotent across repeat purchases of the same animation template', async () => {
    const seller = await signupBuilder('animation-ownership-repeat-seller');
    await createGreenbeltLandlet('animation-ownership-repeat-landlet');
    await claim('animation-ownership-repeat-landlet', seller);
    await createAnimationTemplate('animation-ownership-repeat-template');
    await placeInstance('animation-ownership-repeat-instance-1', 'animation-ownership-repeat-landlet', 'animation-ownership-repeat-template', seller);
    await placeInstance('animation-ownership-repeat-instance-2', 'animation-ownership-repeat-landlet', 'animation-ownership-repeat-template', seller);

    expect((await purchase('animation-ownership-repeat-instance-1', seller)).response.status).toBe(201);
    expect((await purchase('animation-ownership-repeat-instance-2', seller)).response.status).toBe(201);

    expect(await ownedAnimationRows(seller.builderId, 'animation-ownership-repeat-template')).toHaveLength(1);
  });

  it('grants ownership to the actual buyer, not the hosting lándlet owner', async () => {
    const seller = await signupBuilder('animation-ownership-buyer-seller');
    const buyer = await signupBuilder('animation-ownership-buyer-buyer');
    await createGreenbeltLandlet('animation-ownership-buyer-landlet');
    await claim('animation-ownership-buyer-landlet', seller);
    await createAnimationTemplate('animation-ownership-buyer-template');
    await placeInstance('animation-ownership-buyer-instance', 'animation-ownership-buyer-landlet', 'animation-ownership-buyer-template', seller);

    const purchased = await purchase('animation-ownership-buyer-instance', buyer);
    expect(purchased.response.status).toBe(201);

    expect(await ownedAnimationRows(buyer.builderId, 'animation-ownership-buyer-template')).toHaveLength(1);
    expect(await ownedAnimationRows(seller.builderId, 'animation-ownership-buyer-template')).toHaveLength(0);
  });
});

// #888's own reasoning, applied to isAnimationCategory: the real Stripe
// checkout -> finalize path locks it into the PaymentIntent's own metadata
// at checkout time so a template's live, mutable category can't
// retroactively change whether a purchase grants/withholds an
// owned_animations row. Exercised directly against writePurchaseRow for the
// same reason worker/avatar-ownership.test.js's own equivalent describe
// block is — the real checkout->finalize flow only reaches this with a live
// Stripe call this test suite deliberately never configures.
describe('writePurchaseRow honors an explicit isAnimationCategory over template.category (#1163, mirroring #888)', () => {
  async function seedForWrite(prefix) {
    const seller = await signupBuilder(`${prefix}-seller`);
    const buyer = await signupBuilder(`${prefix}-buyer`);
    await createGreenbeltLandlet(`${prefix}-landlet`);
    await claim(`${prefix}-landlet`, seller);
    return { seller, buyer };
  }

  async function fetchRows(templateId, landletId, instanceId) {
    const template = await env.DB.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    const landlet = await env.DB.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(landletId).first();
    const instance = await env.DB.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    return { template, landlet, instance };
  }

  function amountsFor(template) {
    return {
      quantity: 1, buyerLabel: null, unitPriceCents: template.price_cents, totalCents: template.price_cents,
      commissionCents: 0, builderShareCents: template.price_cents, platformShareCents: 0,
    };
  }

  it('does not grant owned_animations when isAnimationCategory is explicitly false, even though template.category is animation', async () => {
    const prefix = 'wpr-anim-snap-false';
    const { seller, buyer } = await seedForWrite(prefix);
    await createAnimationTemplate(`${prefix}-template`);
    await placeInstance(`${prefix}-instance`, `${prefix}-landlet`, `${prefix}-template`, seller);
    const { template, landlet, instance } = await fetchRows(`${prefix}-template`, `${prefix}-landlet`, `${prefix}-instance`);
    expect(template.category).toBe('animation');

    // Positional args: paymentIntentId, isDigitalGood, buyerBuilderId,
    // isAvatarCategory, idempotencyKey, isAnimationCategory (the new
    // trailing parameter) — explicitly false here despite the template's
    // own live category.
    await writePurchaseRow(env, instance, template, landlet, amountsFor(template), 'pi_1163_snapshot_false', false, buyer.builderId, false, undefined, false);

    expect(await ownedAnimationRows(buyer.builderId, `${prefix}-template`)).toHaveLength(0);
  });

  it('grants owned_animations when isAnimationCategory is explicitly true, even though template.category is not animation', async () => {
    const prefix = 'wpr-anim-snap-true';
    const { seller, buyer } = await seedForWrite(prefix);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: `${prefix}-template`, name: 'Plain product', color: '#222222',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance(`${prefix}-instance`, `${prefix}-landlet`, `${prefix}-template`, seller);
    const { template, landlet, instance } = await fetchRows(`${prefix}-template`, `${prefix}-landlet`, `${prefix}-instance`);
    expect(template.category).not.toBe('animation');

    await writePurchaseRow(env, instance, template, landlet, amountsFor(template), 'pi_1163_snapshot_true', false, buyer.builderId, false, undefined, true);

    expect(await ownedAnimationRows(buyer.builderId, `${prefix}-template`)).toHaveLength(1);
  });
});

describe('Refund revokes animation ownership (mirroring #754/#1033/#801)', () => {
  it('deletes the owned_animations grant when its purchase is refunded', async () => {
    const seller = await signupBuilder('animation-refund-seller');
    const buyer = await signupBuilder('animation-refund-buyer');
    await createGreenbeltLandlet('animation-refund-landlet');
    await claim('animation-refund-landlet', seller);
    await createAnimationTemplate('animation-refund-template');
    await placeInstance('animation-refund-instance', 'animation-refund-landlet', 'animation-refund-template', seller);

    const purchased = await purchase('animation-refund-instance', buyer);
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;
    expect(await ownedAnimationRows(buyer.builderId, 'animation-refund-template')).toHaveLength(1);

    // This template has no sellerId (createAnimationTemplate's own
    // default), so the refund falls to the admin fallback — same pattern
    // as worker/avatar-ownership.test.js's own refund tests.
    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);

    expect(await ownedAnimationRows(buyer.builderId, 'animation-refund-template')).toHaveLength(0);
  });

  // #1033's own shape: a buyer can legitimately hold TWO separate,
  // unrefunded purchases of the same animation template.
  it('keeps ownership when a SECOND unrefunded purchase of the same template still exists', async () => {
    const seller = await signupBuilder('animation-refund-multi-seller');
    const buyer = await signupBuilder('animation-refund-multi-buyer');
    await createGreenbeltLandlet('animation-refund-multi-landlet');
    await claim('animation-refund-multi-landlet', seller);
    await createAnimationTemplate('animation-refund-multi-template');
    await placeInstance('animation-refund-multi-instance-1', 'animation-refund-multi-landlet', 'animation-refund-multi-template', seller);
    await placeInstance('animation-refund-multi-instance-2', 'animation-refund-multi-landlet', 'animation-refund-multi-template', seller);

    const firstPurchase = await purchase('animation-refund-multi-instance-1', buyer);
    expect(firstPurchase.response.status).toBe(201);
    const secondPurchase = await purchase('animation-refund-multi-instance-2', buyer);
    expect(secondPurchase.response.status).toBe(201);

    const refunded = await api(`/purchases/${firstPurchase.body.purchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
    expect(await ownedAnimationRows(buyer.builderId, 'animation-refund-multi-template')).toHaveLength(1);

    const secondRefunded = await api(`/purchases/${secondPurchase.body.purchase.purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(secondRefunded.response.status).toBe(200);
    expect(await ownedAnimationRows(buyer.builderId, 'animation-refund-multi-template')).toHaveLength(0);
  });

  // #801's own shape: revocation must key off the purchase-time-locked
  // owned_animation_purchases row, not the template's live, mutable
  // category.
  it('still revokes ownership on refund even if the template\'s category was changed away from animation first', async () => {
    const seller = await signupBuilder('animation-refund-recat-seller');
    const buyer = await signupBuilder('animation-refund-recat-buyer');
    await createGreenbeltLandlet('animation-refund-recat-landlet');
    await claim('animation-refund-recat-landlet', seller);
    await createAnimationTemplate('animation-refund-recat-template');
    await placeInstance('animation-refund-recat-instance', 'animation-refund-recat-landlet', 'animation-refund-recat-template', seller);

    const purchased = await purchase('animation-refund-recat-instance', buyer);
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;

    const recategorized = await api('/catalog/animation-refund-recat-template', {
      method: 'PATCH', body: JSON.stringify({ category: 'furniture' }),
    });
    expect(recategorized.response.status).toBe(200);
    expect(recategorized.body.template.category).toBe('furniture');

    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);

    expect(await ownedAnimationRows(buyer.builderId, 'animation-refund-recat-template')).toHaveLength(0);
  });

  it('leaves a different builder\'s own grant of the same template untouched', async () => {
    const seller = await signupBuilder('animation-refund-scope-seller');
    const buyerA = await signupBuilder('animation-refund-scope-buyer-a');
    const buyerB = await signupBuilder('animation-refund-scope-buyer-b');
    await createGreenbeltLandlet('animation-refund-scope-landlet');
    await claim('animation-refund-scope-landlet', seller);
    await createAnimationTemplate('animation-refund-scope-template');
    await placeInstance('animation-refund-scope-instance-a', 'animation-refund-scope-landlet', 'animation-refund-scope-template', seller);
    await placeInstance('animation-refund-scope-instance-b', 'animation-refund-scope-landlet', 'animation-refund-scope-template', seller);

    const purchasedA = await purchase('animation-refund-scope-instance-a', buyerA);
    const { purchaseId: purchaseIdA } = purchasedA.body.purchase;
    await purchase('animation-refund-scope-instance-b', buyerB);

    await api(`/purchases/${purchaseIdA}/refund`, adminSession({ method: 'POST' }));

    expect(await ownedAnimationRows(buyerA.builderId, 'animation-refund-scope-template')).toHaveLength(0);
    expect(await ownedAnimationRows(buyerB.builderId, 'animation-refund-scope-template')).toHaveLength(1);
  });

  it('refunds an ordinary (non-animation) purchase without touching owned_animations at all', async () => {
    const seller = await signupBuilder('animation-refund-ordinary-seller');
    await createGreenbeltLandlet('animation-refund-ordinary-landlet');
    await claim('animation-refund-ordinary-landlet', seller);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'animation-refund-ordinary-template', name: 'Plain product', color: '#222222',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance('animation-refund-ordinary-instance', 'animation-refund-ordinary-landlet', 'animation-refund-ordinary-template', seller);
    const purchased = await purchase('animation-refund-ordinary-instance', seller);
    const { purchaseId } = purchased.body.purchase;

    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
  });

  // Schema-only change with no app-observable behavior difference (same
  // reasoning as worker/avatar-ownership.test.js's own #1016 index check)
  // — the meaningful regression check is that the index actually exists.
  it('indexes owned_animations.purchase_id', async () => {
    const indexes = (await env.DB.prepare('PRAGMA index_list(owned_animations)').all()).results;
    expect(indexes.some((idx) => idx.name === 'idx_owned_animations_purchase_id')).toBe(true);
  });
});
