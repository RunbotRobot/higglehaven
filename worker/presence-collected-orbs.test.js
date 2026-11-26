// #4387: GET /api/presence also names the orbs that someone else collected in the last half minute within range of
// where the caller stands (ids only), so an onlooker can show the same pop. Orbs live on greenbelt lándlets, where
// presence names no lándlet, so range is by position. Not the caller's own collects, not older ones, not far ones,
// and never who collected.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const postPresence = (builder, body) => api('/presence', builder.session({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}));

// A greenbelt lándlet whose centre is far from the origin, so an orb's lándlet-local x/y and its world position are
// told apart (the same reason credit-orbs.test.js does it).
async function seedLandlet(centerX, centerY) {
  const landletId = `presence-orbs-landlet-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO landlets (landlet_id, name, status, center_x_m, center_y_m) VALUES (?, ?, ?, ?, ?)')
    .bind(landletId, landletId, 'greenbelt', centerX, centerY).run();
  return landletId;
}

async function seedOrb(landletId, { collectedBy = null, ageMs = 1000, x = 2, y = -1 } = {}) {
  const orbId = `presence-orb-${crypto.randomUUID()}`;
  const at = new Date(Date.now() - ageMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO credit_orbs (orb_id, landlet_id, x_m, y_m, z_m, spawned_at, collected_at, collected_by_builder_id)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).bind(orbId, landletId, x, y, at, collectedBy ? at : null, collectedBy).run();
  return orbId;
}

describe('collectedOrbs in GET /api/presence (#4387)', () => {
  it('names an orb another person just collected within range of me, and nothing else', async () => {
    const near = await seedLandlet(3000, -2000);
    const far = await seedLandlet(3000, -2500); // 500 m away
    const me = await signupBuilder('presence-orbs-me');
    const other = await signupBuilder('presence-orbs-other');
    // standing on a greenbelt lándlet: no lándlet id in the report, as the client sends it
    await postPresence(me, { x: 3005, y: -2005, z: 0 });

    const byOther = await seedOrb(near, { collectedBy: other.builderId });
    await seedOrb(near, { collectedBy: me.builderId }); // my own: I already popped it
    await seedOrb(near, { collectedBy: other.builderId, ageMs: 5 * 60 * 1000 }); // long ago
    await seedOrb(far, { collectedBy: other.builderId }); // out of range
    await seedOrb(near); // standing, not collected

    const { response, body } = await api('/presence', me.session());
    expect(response.status).toBe(200);
    expect(body.avatars).toEqual([]);
    expect(body.collectedOrbs).toEqual([byOther]);
    expect(JSON.stringify(body)).not.toContain(other.builderId);
  });

  it('is an empty list for someone who has reported no position', async () => {
    const stranger = await signupBuilder('presence-orbs-nowhere');
    const { response, body } = await api('/presence', stranger.session());
    expect(response.status).toBe(200);
    expect(body).toEqual({ avatars: [], collectedOrbs: [] });
  });

  it('is empty when my last position is old', async () => {
    const near = await seedLandlet(4000, -2000);
    const me = await signupBuilder('presence-orbs-stale');
    const other = await signupBuilder('presence-orbs-stale-other');
    await postPresence(me, { x: 4005, y: -2005, z: 0 });
    await env.DB.prepare(`UPDATE avatar_presence SET updated_at = ? WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)`)
      .bind(new Date(Date.now() - 5 * 60 * 1000).toISOString(), me.builderId).run();
    await seedOrb(near, { collectedBy: other.builderId });
    const { body } = await api('/presence', me.session());
    expect(body.collectedOrbs).toEqual([]);
  });
});
