// #4198: GET /api/admin-items-outside-landlets, the read-only list of items standing off their lándlet's outline.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';

let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('outside-items-admin')).session;
});

const SQUARE_20 = JSON.stringify([{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }]);

async function template(id, width, depth) {
  await env.DB.prepare(`
    INSERT INTO catalog_templates (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents)
    VALUES (?, ?, 'building', 'misc', '#aaaaaa', ?, ?, 1, 0)
  `).bind(id, id, width, depth).run();
}

async function landlet(id, ownerBuilderId, polygon) {
  await env.DB.prepare(`
    INSERT INTO landlets (landlet_id, name, owner_builder_id, status, polygon_json) VALUES (?, ?, ?, 'claimed', ?)
  `).bind(id, id, ownerBuilderId, polygon).run();
}

async function place(id, landletId, templateId, x, y, extra = {}) {
  await env.DB.prepare(`
    INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, scale, rotation_z_rad)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).bind(id, landletId, templateId, x, y, extra.scale ?? 1, extra.rotationZ ?? 0).run();
}

describe('GET /admin-items-outside-landlets (#4198)', () => {
  it('refuses a signed-out caller and a signed-in non-admin', async () => {
    expect((await api('/admin-items-outside-landlets')).response.status).toBe(401);
    const builder = await signupBuilder('outside-items-non-admin');
    expect((await api('/admin-items-outside-landlets', builder.session())).response.status).toBe(403);
  });

  it('counts only the items whose footprint is off the outline, per lándlet, and leaves everything in place', async () => {
    const owner = await signupBuilder('outside-items-owner');
    await template('outside-items-brick', 2, 2);
    await landlet('outside-items-lot', owner.builderId, SQUARE_20);
    await place('oi-inside', 'outside-items-lot', 'outside-items-brick', 0, 0);
    await place('oi-edge', 'outside-items-lot', 'outside-items-brick', 9, 0); // right edge exactly on the outline
    await place('oi-over', 'outside-items-lot', 'outside-items-brick', 9.5, 0); // sticks out by half a metre
    await place('oi-scaled', 'outside-items-lot', 'outside-items-brick', 8, 0, { scale: 3 }); // 6 m wide: reaches 11
    await place('oi-turned', 'outside-items-lot', 'outside-items-brick', 9, 0, { rotationZ: Math.PI / 4 }); // corner reaches 10.41
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM placed_instances').first()).n;
    const result = await api('/admin-items-outside-landlets', adminSession());
    expect(result.response.status).toBe(200);
    const lot = result.body.landlets.find((row) => row.landletId === 'outside-items-lot');
    expect(lot.outside).toBe(3);
    expect(lot.examples.map((e) => e.instanceId).sort()).toEqual(['oi-over', 'oi-scaled', 'oi-turned']);
    expect(lot.owner).toBe('outside-items-owner');
    expect(result.body.outsideItems).toBeGreaterThanOrEqual(3);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM placed_instances').first()).n).toBe(before);
  });

  it('does not list a lándlet with nothing outside, or one with no usable outline', async () => {
    const owner = await signupBuilder('outside-items-clean-owner');
    await template('outside-items-clean-brick', 1, 1);
    await landlet('outside-items-clean-lot', owner.builderId, SQUARE_20);
    await place('oi-clean', 'outside-items-clean-lot', 'outside-items-clean-brick', 1, 1);
    await landlet('outside-items-no-outline-lot', owner.builderId, '[]');
    await place('oi-far', 'outside-items-no-outline-lot', 'outside-items-clean-brick', 500, 500);
    const result = await api('/admin-items-outside-landlets', adminSession());
    expect(result.body.landlets.find((row) => row.landletId === 'outside-items-clean-lot')).toBeUndefined();
    expect(result.body.landlets.find((row) => row.landletId === 'outside-items-no-outline-lot')).toBeUndefined();
  });
});
