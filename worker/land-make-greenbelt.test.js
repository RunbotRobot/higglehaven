import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupBuilder, signupAdmin, createGreenbeltLandletAs,
} from './test-helpers.js';

// #4075: admin "Make greenbelt".
let adminSession;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('make-greenbelt-admin')).session;
});

async function claimed(landletId, name) {
  const owner = await signupBuilder(name);
  await createGreenbeltLandletAs(adminSession, landletId);
  await api(`/landlets/${landletId}/claim`, owner.session({ method: 'POST' }));
  return owner;
}
const post = (id, session) => api(`/landlets/${id}/make-greenbelt`, session({ method: 'POST', body: '{}' }));

describe('Admin make-greenbelt (#4075)', () => {
  it('releases the lándlet, keeps the build as a saved layout, logs and notifies', async () => {
    const owner = await claimed('mg-happy', 'mg-happy-owner');
    await env.DB.prepare(
      "INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m) VALUES ('mg-tpl', 'Fixture', 'mg', '#123456', 1, 1, 1)",
    ).run();
    await env.DB.prepare('INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m) VALUES (?, ?, ?, 1, 1)')
      .bind('mg-inst', 'mg-happy', 'mg-tpl').run();

    const res = await post('mg-happy', adminSession);
    expect(res.response.status).toBe(200);
    expect(res.body.landlet).toMatchObject({ status: 'greenbelt', ownerBuilderId: null });
    expect(res.body.savedInstanceCount).toBe(1);

    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM placed_instances WHERE landlet_id = ?').bind('mg-happy').first();
    expect(left.n).toBe(0);
    const saved = await env.DB.prepare('SELECT * FROM saved_layout_instances WHERE saved_layout_id = ?').bind(res.body.savedLayoutId).all();
    expect(saved.results).toHaveLength(1);
    const layout = await env.DB.prepare('SELECT builder_id FROM saved_level_layouts WHERE saved_layout_id = ?').bind(res.body.savedLayoutId).first();
    expect(layout.builder_id).toBe(owner.builderId);
    const log = await env.DB.prepare('SELECT detail_json FROM admin_action_log WHERE action_type = ? AND target_id = ?')
      .bind('landlet_made_greenbelt', 'mg-happy').first();
    expect(JSON.parse(log.detail_json)).toMatchObject({ previousOwnerBuilderId: owner.builderId, instanceCount: 1 });
    const notes = await env.DB.prepare('SELECT message FROM notifications WHERE builder_id = ?').bind(owner.builderId).all();
    expect(notes.results.some((n) => /returned to the greenbelt/.test(n.message))).toBe(true);

    // The previous owner is free to claim again; anyone can claim this one.
    const other = await signupBuilder('mg-happy-claimer');
    const claim = await api('/landlets/mg-happy/claim', other.session({ method: 'POST' }));
    expect(claim.response.status).toBe(200);
  });

  it('is admin-only', async () => {
    const owner = await claimed('mg-auth', 'mg-auth-owner');
    const res = await post('mg-auth', owner.session);
    expect(res.response.status).toBe(403);
  });

  it('refuses a lándlet that is already greenbelt', async () => {
    await createGreenbeltLandletAs(adminSession, 'mg-already');
    const res = await post('mg-already', adminSession);
    expect(res.response.status).toBe(409);
  });

  it('refuses while an auction is active', async () => {
    const owner = await claimed('mg-auction', 'mg-auction-owner');
    await env.DB.prepare(`
      INSERT INTO auctions (auction_id, landlet_id, seller_builder_id, starting_bid_cents, ends_at)
      VALUES ('mg-auc', 'mg-auction', ?, 0, ?)
    `).bind(owner.builderId, new Date(Date.now() + 3600_000).toISOString()).run();
    const res = await post('mg-auction', adminSession);
    expect(res.response.status).toBe(409);
    const still = await env.DB.prepare('SELECT status FROM landlets WHERE landlet_id = ?').bind('mg-auction').first();
    expect(still.status).toBe('claimed');
  });
});
