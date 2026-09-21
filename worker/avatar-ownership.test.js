// #680 (sub-issue of #679, N53 — owner's Control Room direction: "I do want
// to allow users to upload whatever avatar model they want... also want
// them to be able to sell them as digital products"). Covers the backend
// half only: purchasing an "avatar"-category catalog template grants the
// buyer equippable ownership (owned_avatars, migrations/0083), and
// GET/PUT /api/builders/me/avatar sets/reads which one (if any) is
// currently equipped. Rendering the equipped model in-world is #681's own
// scope, not this file's.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin, signupBuilder } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('avatar-ownership-admin');
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

async function createAvatarTemplate(templateId, { priceCents = 500 } = {}) {
  const created = await api('/catalog', {
    method: 'POST',
    body: JSON.stringify({
      templateId,
      name: `Sellable avatar ${templateId}`,
      category: 'avatar',
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

// Purchasing is now gated on a real, verified session (N44) regardless of
// who's buying — the seller's own session here is just the simplest way
// to get one, same shortcut worker/commerce.test.js's own #683 test uses.
async function purchase(instanceId, buyer) {
  return api(`/instances/${instanceId}/purchase`, buyer.session({ method: 'POST' }));
}

describe('Avatar ownership (#680)', () => {
  it('does not grant ownership for an ordinary (non-avatar) purchase', async () => {
    const seller = await signupBuilder('avatar-ownership-ordinary-seller');
    await createGreenbeltLandlet('avatar-ownership-ordinary-landlet');
    await claim('avatar-ownership-ordinary-landlet', seller);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'avatar-ownership-ordinary-template', name: 'Plain product', color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance('avatar-ownership-ordinary-instance', 'avatar-ownership-ordinary-landlet', 'avatar-ownership-ordinary-template', seller);

    const purchased = await purchase('avatar-ownership-ordinary-instance', seller);
    expect(purchased.response.status).toBe(201);

    const owned = await env.DB.prepare('SELECT * FROM owned_avatars WHERE builder_id = ?').bind(seller.builderId).all();
    expect(owned.results).toHaveLength(0);
  });

  it('grants the buyer equippable ownership of an avatar-category purchase', async () => {
    const seller = await signupBuilder('avatar-ownership-seller');
    await createGreenbeltLandlet('avatar-ownership-landlet');
    await claim('avatar-ownership-landlet', seller);
    await createAvatarTemplate('avatar-ownership-template');
    await placeInstance('avatar-ownership-instance', 'avatar-ownership-landlet', 'avatar-ownership-template', seller);

    const purchased = await purchase('avatar-ownership-instance', seller);
    expect(purchased.response.status).toBe(201);

    const listed = await api('/builders/me/avatars', seller.session());
    expect(listed.response.status).toBe(200);
    expect(listed.body.avatars.map((a) => a.templateId)).toContain('avatar-ownership-template');
  });

  it('is idempotent across repeat purchases of the same avatar template', async () => {
    const seller = await signupBuilder('avatar-ownership-repeat-seller');
    await createGreenbeltLandlet('avatar-ownership-repeat-landlet');
    await claim('avatar-ownership-repeat-landlet', seller);
    await createAvatarTemplate('avatar-ownership-repeat-template');
    await placeInstance('avatar-ownership-repeat-instance-1', 'avatar-ownership-repeat-landlet', 'avatar-ownership-repeat-template', seller);
    await placeInstance('avatar-ownership-repeat-instance-2', 'avatar-ownership-repeat-landlet', 'avatar-ownership-repeat-template', seller);

    expect((await purchase('avatar-ownership-repeat-instance-1', seller)).response.status).toBe(201);
    expect((await purchase('avatar-ownership-repeat-instance-2', seller)).response.status).toBe(201);

    const owned = await env.DB.prepare(
      'SELECT * FROM owned_avatars WHERE builder_id = ? AND template_id = ?',
    ).bind(seller.builderId, 'avatar-ownership-repeat-template').all();
    expect(owned.results).toHaveLength(1);
  });

  it('grants ownership to the actual buyer, not the hosting lándlet owner', async () => {
    const seller = await signupBuilder('avatar-ownership-buyer-seller');
    const buyer = await signupBuilder('avatar-ownership-buyer-buyer');
    await createGreenbeltLandlet('avatar-ownership-buyer-landlet');
    await claim('avatar-ownership-buyer-landlet', seller);
    await createAvatarTemplate('avatar-ownership-buyer-template');
    await placeInstance('avatar-ownership-buyer-instance', 'avatar-ownership-buyer-landlet', 'avatar-ownership-buyer-template', seller);

    const purchased = await purchase('avatar-ownership-buyer-instance', buyer);
    expect(purchased.response.status).toBe(201);

    const buyerOwns = await api('/builders/me/avatars', buyer.session());
    expect(buyerOwns.body.avatars.map((a) => a.templateId)).toContain('avatar-ownership-buyer-template');
    const sellerOwns = await api('/builders/me/avatars', seller.session());
    expect(sellerOwns.body.avatars.map((a) => a.templateId)).not.toContain('avatar-ownership-buyer-template');
  });
});

describe('Equip endpoint (GET/PUT /api/builders/me/avatar, #680)', () => {
  it('requires a session for both GET and PUT', async () => {
    const got = await api('/builders/me/avatar');
    expect(got.response.status).toBe(401);
    const put = await api('/builders/me/avatar', { method: 'PUT', body: JSON.stringify({ templateId: 'x' }) });
    expect(put.response.status).toBe(401);
  });

  it('defaults to no equipped avatar (the hardcoded default) for a fresh account', async () => {
    const account = await signupBuilder('avatar-equip-fresh');
    const got = await api('/builders/me/avatar', account.session());
    expect(got.response.status).toBe(200);
    expect(got.body.avatar).toMatchObject({ equippedTemplateId: null, modelUrl: null });
  });

  it('rejects equipping a template the account does not own', async () => {
    const seller = await signupBuilder('avatar-equip-unowned-seller');
    await createGreenbeltLandlet('avatar-equip-unowned-landlet');
    await claim('avatar-equip-unowned-landlet', seller);
    await createAvatarTemplate('avatar-equip-unowned-template');

    const account = await signupBuilder('avatar-equip-unowned-account');
    const rejected = await api('/builders/me/avatar', account.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-equip-unowned-template' }),
    }));
    expect(rejected.response.status).toBe(403);
  });

  it('equips an owned avatar, returning its modelUrl', async () => {
    const seller = await signupBuilder('avatar-equip-owned-seller');
    await createGreenbeltLandlet('avatar-equip-owned-landlet');
    await claim('avatar-equip-owned-landlet', seller);
    await createAvatarTemplate('avatar-equip-owned-template');
    await placeInstance('avatar-equip-owned-instance', 'avatar-equip-owned-landlet', 'avatar-equip-owned-template', seller);
    await purchase('avatar-equip-owned-instance', seller);

    // Give the template a real modelUrl so the equip response has
    // something concrete to check — createAvatarTemplate itself leaves it
    // unset, matching every other template in this suite.
    await env.DB.prepare('UPDATE catalog_templates SET model_url = ? WHERE template_id = ?')
      .bind('/uploads/avatar-equip-owned-template.glb', 'avatar-equip-owned-template').run();

    const equipped = await api('/builders/me/avatar', seller.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-equip-owned-template' }),
    }));
    expect(equipped.response.status).toBe(200);
    expect(equipped.body.avatar).toMatchObject({
      equippedTemplateId: 'avatar-equip-owned-template', modelUrl: '/uploads/avatar-equip-owned-template.glb',
    });

    const got = await api('/builders/me/avatar', seller.session());
    expect(got.body.avatar).toMatchObject({
      equippedTemplateId: 'avatar-equip-owned-template', modelUrl: '/uploads/avatar-equip-owned-template.glb',
    });
  });

  it('reverts to the default avatar when equipped with a null templateId', async () => {
    const seller = await signupBuilder('avatar-equip-clear-seller');
    await createGreenbeltLandlet('avatar-equip-clear-landlet');
    await claim('avatar-equip-clear-landlet', seller);
    await createAvatarTemplate('avatar-equip-clear-template');
    await placeInstance('avatar-equip-clear-instance', 'avatar-equip-clear-landlet', 'avatar-equip-clear-template', seller);
    await purchase('avatar-equip-clear-instance', seller);
    await api('/builders/me/avatar', seller.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-equip-clear-template' }),
    }));

    const cleared = await api('/builders/me/avatar', seller.session({
      method: 'PUT', body: JSON.stringify({ templateId: null }),
    }));
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.avatar).toMatchObject({ equippedTemplateId: null, modelUrl: null });
  });

  it('falls back to the default avatar if the equipped template is later deleted', async () => {
    const seller = await signupBuilder('avatar-equip-deleted-seller');
    await createGreenbeltLandlet('avatar-equip-deleted-landlet');
    await claim('avatar-equip-deleted-landlet', seller);
    await createAvatarTemplate('avatar-equip-deleted-template');
    await placeInstance('avatar-equip-deleted-instance', 'avatar-equip-deleted-landlet', 'avatar-equip-deleted-template', seller);
    await purchase('avatar-equip-deleted-instance', seller);
    await api('/builders/me/avatar', seller.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-equip-deleted-template' }),
    }));

    // purchases.template_id is deliberately not a foreign key (migrations/
    // 0051's own comment), but placed_instances.template_id IS one with ON
    // DELETE RESTRICT (migrations/0001) — so the still-placed instance has
    // to go first before the template itself can be deleted. Removing both
    // directly at the DB layer here rather than via the real DELETE
    // endpoints, since that's not what this test is exercising.
    await env.DB.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind('avatar-equip-deleted-instance').run();
    await env.DB.prepare('DELETE FROM catalog_templates WHERE template_id = ?').bind('avatar-equip-deleted-template').run();

    const got = await api('/builders/me/avatar', seller.session());
    expect(got.response.status).toBe(200);
    expect(got.body.avatar).toMatchObject({ equippedTemplateId: null, modelUrl: null });
  });
});

describe('Refund revokes avatar ownership (#754)', () => {
  it('deletes the owned_avatars grant and clears an equipped avatar when its purchase is refunded', async () => {
    const seller = await signupBuilder('avatar-refund-seller');
    const buyer = await signupBuilder('avatar-refund-buyer');
    await createGreenbeltLandlet('avatar-refund-landlet');
    await claim('avatar-refund-landlet', seller);
    await createAvatarTemplate('avatar-refund-template');
    await placeInstance('avatar-refund-instance', 'avatar-refund-landlet', 'avatar-refund-template', seller);

    const purchased = await purchase('avatar-refund-instance', buyer);
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;

    const equipped = await api('/builders/me/avatar', buyer.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-refund-template' }),
    }));
    expect(equipped.response.status).toBe(200);

    // This template has no sellerId (createAvatarTemplate's own default),
    // so the refund falls to the admin fallback — same pattern as
    // worker/commerce.test.js's own refund tests.
    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);

    const owned = await env.DB.prepare(
      'SELECT * FROM owned_avatars WHERE builder_id = ? AND template_id = ?',
    ).bind(buyer.builderId, 'avatar-refund-template').all();
    expect(owned.results).toHaveLength(0);

    const got = await api('/builders/me/avatar', buyer.session());
    expect(got.body.avatar).toMatchObject({ equippedTemplateId: null, modelUrl: null });

    // Re-equipping is rejected — the grant is genuinely gone, not just the
    // equip cleared out from under it.
    const reEquip = await api('/builders/me/avatar', buyer.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-refund-template' }),
    }));
    expect(reEquip.response.status).toBe(403);
  });

  // #801: revocation used to be gated on the template's *live* category
  // instead of the purchase-time-locked owned_avatars row — a seller
  // changing category away from 'avatar' between purchase and refund
  // silently skipped revocation entirely, letting the buyer keep the item
  // (and their refund) forever.
  it('still revokes ownership on refund even if the template\'s category was changed away from avatar first', async () => {
    const seller = await signupBuilder('avatar-refund-recat-seller');
    const buyer = await signupBuilder('avatar-refund-recat-buyer');
    await createGreenbeltLandlet('avatar-refund-recat-landlet');
    await claim('avatar-refund-recat-landlet', seller);
    await createAvatarTemplate('avatar-refund-recat-template');
    await placeInstance('avatar-refund-recat-instance', 'avatar-refund-recat-landlet', 'avatar-refund-recat-template', seller);

    const purchased = await purchase('avatar-refund-recat-instance', buyer);
    expect(purchased.response.status).toBe(201);
    const { purchaseId } = purchased.body.purchase;

    const equipped = await api('/builders/me/avatar', buyer.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-refund-recat-template' }),
    }));
    expect(equipped.response.status).toBe(200);

    // The template has no sellerId (createAvatarTemplate's own default),
    // so this PATCH is reachable unauthenticated too — same as the real
    // exploit path (a seller who has since deleted their account).
    const recategorized = await api('/catalog/avatar-refund-recat-template', {
      method: 'PATCH', body: JSON.stringify({ category: 'furniture' }),
    });
    expect(recategorized.response.status).toBe(200);
    expect(recategorized.body.template.category).toBe('furniture');

    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);

    const owned = await env.DB.prepare(
      'SELECT * FROM owned_avatars WHERE builder_id = ? AND template_id = ?',
    ).bind(buyer.builderId, 'avatar-refund-recat-template').all();
    expect(owned.results).toHaveLength(0);

    const got = await api('/builders/me/avatar', buyer.session());
    expect(got.body.avatar).toMatchObject({ equippedTemplateId: null, modelUrl: null });
  });

  it('leaves a different builder\'s own equipped grant of the same template untouched', async () => {
    const seller = await signupBuilder('avatar-refund-scope-seller');
    const buyerA = await signupBuilder('avatar-refund-scope-buyer-a');
    const buyerB = await signupBuilder('avatar-refund-scope-buyer-b');
    await createGreenbeltLandlet('avatar-refund-scope-landlet');
    await claim('avatar-refund-scope-landlet', seller);
    await createAvatarTemplate('avatar-refund-scope-template');
    await placeInstance('avatar-refund-scope-instance-a', 'avatar-refund-scope-landlet', 'avatar-refund-scope-template', seller);
    await placeInstance('avatar-refund-scope-instance-b', 'avatar-refund-scope-landlet', 'avatar-refund-scope-template', seller);

    const purchasedA = await purchase('avatar-refund-scope-instance-a', buyerA);
    const { purchaseId: purchaseIdA } = purchasedA.body.purchase;
    await purchase('avatar-refund-scope-instance-b', buyerB);

    await api('/builders/me/avatar', buyerA.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-refund-scope-template' }),
    }));
    await api('/builders/me/avatar', buyerB.session({
      method: 'PUT', body: JSON.stringify({ templateId: 'avatar-refund-scope-template' }),
    }));

    await api(`/purchases/${purchaseIdA}/refund`, adminSession({ method: 'POST' }));

    const gotA = await api('/builders/me/avatar', buyerA.session());
    expect(gotA.body.avatar).toMatchObject({ equippedTemplateId: null, modelUrl: null });
    const gotB = await api('/builders/me/avatar', buyerB.session());
    expect(gotB.body.avatar.equippedTemplateId).toBe('avatar-refund-scope-template');

    const buyerBStillOwns = await env.DB.prepare(
      'SELECT * FROM owned_avatars WHERE builder_id = ? AND template_id = ?',
    ).bind(buyerB.builderId, 'avatar-refund-scope-template').all();
    expect(buyerBStillOwns.results).toHaveLength(1);
  });

  it('refunds an ordinary (non-avatar) purchase without touching owned_avatars at all', async () => {
    const seller = await signupBuilder('avatar-refund-ordinary-seller');
    await createGreenbeltLandlet('avatar-refund-ordinary-landlet');
    await claim('avatar-refund-ordinary-landlet', seller);
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'avatar-refund-ordinary-template', name: 'Plain product', color: '#222222',
        dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
      }),
    });
    expect(created.response.status).toBe(201);
    await placeInstance('avatar-refund-ordinary-instance', 'avatar-refund-ordinary-landlet', 'avatar-refund-ordinary-template', seller);
    const purchased = await purchase('avatar-refund-ordinary-instance', seller);
    const { purchaseId } = purchased.body.purchase;

    const refunded = await api(`/purchases/${purchaseId}/refund`, adminSession({ method: 'POST' }));
    expect(refunded.response.status).toBe(200);
  });
});
