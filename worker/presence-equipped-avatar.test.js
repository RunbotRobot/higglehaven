// #2045: GET /api/presence tells a viewer which custom avatar each nearby
// builder has equipped, resolved server-side from that builder's own
// equipped_avatar_template_id, so other players are drawn as themselves
// instead of the generic default body.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, glbFile, signupAdmin, signupBuilder, signupSeller,
} from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('pea-admin')).session;
});

async function setPresence(builderId, landletId) {
  await env.DB.prepare(`
    INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, flying, updated_at)
    VALUES ((SELECT user_id FROM builders WHERE builder_id = ?), ?, 0, 0, 0, 0, 0, ?)
    ON CONFLICT (user_id) DO UPDATE SET landlet_id = excluded.landlet_id, updated_at = excluded.updated_at
  `).bind(builderId, landletId, new Date().toISOString()).run();
}

async function createAvatarTemplate(seller, templateId, category = 'avatar') {
  const form = new FormData();
  form.set('file', glbFile({ json: `{"presenceEquippedAvatar":"${templateId}"}` }));
  const uploaded = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
  expect(uploaded.status).toBe(201);
  const upload = await uploaded.json();
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId,
      sellerId: seller.sellerId,
      name: `Avatar ${templateId}`,
      color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 },
      priceCents: 500,
      category,
      modelUrl: upload.modelUrl,
      modelSizeBytes: upload.sizeBytes,
    }),
  }));
  expect(created.response.status).toBe(201);
  return upload.modelUrl;
}

async function equip(builder, templateId) {
  await env.DB.prepare('UPDATE builders SET equipped_avatar_template_id = ? WHERE builder_id = ?')
    .bind(templateId, builder.builderId).run();
}

async function equipAnimation(builder, templateId) {
  await env.DB.prepare('UPDATE builders SET equipped_animation_template_id = ? WHERE builder_id = ?')
    .bind(templateId, builder.builderId).run();
}

async function nearby(viewer, landletId) {
  await setPresence(viewer.builderId, landletId);
  const got = await api('/presence', viewer.session());
  expect(got.response.status).toBe(200);
  return got.body.avatars;
}

describe('nearby avatars carry the equipped custom avatar (#2045)', () => {
  it('reports the equipped template and model for a custom avatar, and null for the default body', async () => {
    const seller = await signupSeller('pea-seller');
    const modelUrl = await createAvatarTemplate(seller, 'pea-template');
    const viewer = await signupBuilder('pea-viewer');
    const custom = await signupBuilder('pea-custom');
    const plain = await signupBuilder('pea-plain');
    await equip(custom, 'pea-template');
    await setPresence(custom.builderId, 'pea-landlet');
    await setPresence(plain.builderId, 'pea-landlet');

    const avatars = await nearby(viewer, 'pea-landlet');
    const byId = Object.fromEntries(avatars.map((a) => [a.builderId, a]));
    expect(byId[custom.builderId].equippedAvatar).toEqual({ templateId: 'pea-template', modelUrl, skeletonSignature: null });
    expect(byId[plain.builderId].equippedAvatar).toBeNull();
  });

  it('falls back to the default body when the equipped template no longer exists', async () => {
    const viewer = await signupBuilder('pea-dangling-viewer');
    const other = await signupBuilder('pea-dangling-other');
    // Point it at a template id that doesn't exist (the state left after a seller deletes an equipped avatar).
    await equip(other, 'pea-deleted-template');
    await setPresence(other.builderId, 'pea-dangling-landlet');

    const avatars = await nearby(viewer, 'pea-dangling-landlet');
    expect(avatars.find((a) => a.builderId === other.builderId).equippedAvatar).toBeNull();
  });

  it('hides a suspended seller\'s avatar, and shows it again once the suspension is lifted', async () => {
    const seller = await signupSeller('pea-susp-seller');
    await createAvatarTemplate(seller, 'pea-susp-template');
    const viewer = await signupBuilder('pea-susp-viewer');
    const other = await signupBuilder('pea-susp-other');
    await equip(other, 'pea-susp-template');
    await setPresence(other.builderId, 'pea-susp-landlet');
    const equippedOf = async () => (await nearby(viewer, 'pea-susp-landlet'))
      .find((a) => a.builderId === other.builderId).equippedAvatar;

    expect(await equippedOf()).toMatchObject({ templateId: 'pea-susp-template' });

    const suspended = await api('/auth/suspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: seller.email, reason: 'pea test' }),
    }));
    expect(suspended.response.status).toBe(200);
    expect(await equippedOf()).toBeNull();

    const lifted = await api('/auth/unsuspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: seller.email }),
    }));
    expect(lifted.response.status).toBe(200);
    expect(await equippedOf()).toMatchObject({ templateId: 'pea-susp-template' });
  });
});

describe('nearby avatars carry the equipped animation (#2045)', () => {
  it('reports the equipped animation with its skeleton signature, and null when none is equipped', async () => {
    const seller = await signupSeller('pea-anim-seller');
    const modelUrl = await createAvatarTemplate(seller, 'pea-anim-template', 'animation');
    await env.DB.prepare('UPDATE catalog_templates SET skeleton_signature = ? WHERE template_id = ?')
      .bind('sig-humanoid-v1', 'pea-anim-template').run();
    const viewer = await signupBuilder('pea-anim-viewer');
    const animated = await signupBuilder('pea-anim-animated');
    const plain = await signupBuilder('pea-anim-plain');
    await equipAnimation(animated, 'pea-anim-template');
    await setPresence(animated.builderId, 'pea-anim-landlet');
    await setPresence(plain.builderId, 'pea-anim-landlet');

    const byId = Object.fromEntries((await nearby(viewer, 'pea-anim-landlet')).map((a) => [a.builderId, a]));
    expect(byId[animated.builderId].equippedAnimation)
      .toEqual({ templateId: 'pea-anim-template', modelUrl, skeletonSignature: 'sig-humanoid-v1' });
    expect(byId[plain.builderId].equippedAnimation).toBeNull();
  });

  it('is null for a deleted animation template, and hidden for a suspended seller until the suspension is lifted', async () => {
    const seller = await signupSeller('pea-anim-susp-seller');
    await createAvatarTemplate(seller, 'pea-anim-susp-template', 'animation');
    const viewer = await signupBuilder('pea-anim-susp-viewer');
    const other = await signupBuilder('pea-anim-susp-other');
    await setPresence(other.builderId, 'pea-anim-susp-landlet');
    const animationOf = async () => (await nearby(viewer, 'pea-anim-susp-landlet'))
      .find((a) => a.builderId === other.builderId).equippedAnimation;

    await equipAnimation(other, 'pea-anim-deleted-template');
    expect(await animationOf()).toBeNull();

    await equipAnimation(other, 'pea-anim-susp-template');
    expect(await animationOf()).toMatchObject({ templateId: 'pea-anim-susp-template' });

    const suspended = await api('/auth/suspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: seller.email, reason: 'pea anim test' }),
    }));
    expect(suspended.response.status).toBe(200);
    expect(await animationOf()).toBeNull();

    const lifted = await api('/auth/unsuspend-account', adminSession({
      method: 'POST', body: JSON.stringify({ email: seller.email }),
    }));
    expect(lifted.response.status).toBe(200);
    expect(await animationOf()).toMatchObject({ templateId: 'pea-anim-susp-template' });
  });
});
