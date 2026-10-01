// #1099 (sub-issue of #1095, the multiplayer-presence tracking issue):
// GET /presence, the read side of live avatar positions. #1098's own POST
// endpoint (the only writer of avatar_presence) isn't built yet, so these
// tests seed rows directly via env.DB, the same "insert the state a real
// write would have produced" shortcut worker/seller-feedback.test.js's own
// createPurchase helper already uses for a dependency that doesn't exist
// yet.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, signupBuilder,
} from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function setPresence(builderId, {
  landletId, x = 0, y = 0, z = 0, heading = 0, updatedAt = new Date().toISOString(),
} = {}) {
  await env.DB.prepare(`
    INSERT INTO avatar_presence (builder_id, landlet_id, x, y, z, heading, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (builder_id) DO UPDATE SET
      landlet_id = excluded.landlet_id, x = excluded.x, y = excluded.y, z = excluded.z,
      heading = excluded.heading, updated_at = excluded.updated_at
  `).bind(builderId, landletId, x, y, z, heading, updatedAt).run();
}

describe('Avatar presence (#1095)', () => {
  describe('GET /presence', () => {
    it('requires a session', async () => {
      const anon = await api('/presence?landletId=presence-landlet-anon');
      expect(anon.response.status).toBe(401);
    });

    it('requires a landletId', async () => {
      const builder = await signupBuilder('presence-missing-landlet');
      const missing = await api('/presence', builder.session());
      expect(missing.response.status).toBe(400);
    });

    it('returns another builder\'s position in the same landlet, excluding the caller\'s own row', async () => {
      const viewer = await signupBuilder('presence-viewer');
      const other = await signupBuilder('presence-other');
      const elsewhere = await signupBuilder('presence-elsewhere');
      await setPresence(viewer.builderId, { landletId: 'presence-landlet-1', x: 1, y: 2, z: 3 });
      await setPresence(other.builderId, {
        landletId: 'presence-landlet-1', x: 4, y: 5, z: 6, heading: 90,
      });
      await setPresence(elsewhere.builderId, { landletId: 'presence-landlet-2' });

      const got = await api('/presence?landletId=presence-landlet-1', viewer.session());
      expect(got.response.status).toBe(200);
      expect(got.body.avatars).toEqual([{
        builderId: other.builderId,
        landletId: 'presence-landlet-1',
        x: 4,
        y: 5,
        z: 6,
        heading: 90,
        updatedAt: expect.any(String),
      }]);
    });

    it('excludes a stale position report', async () => {
      const viewer = await signupBuilder('presence-stale-viewer');
      const stale = await signupBuilder('presence-stale-other');
      await setPresence(stale.builderId, {
        landletId: 'presence-landlet-stale', updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const got = await api('/presence?landletId=presence-landlet-stale', viewer.session());
      expect(got.response.status).toBe(200);
      expect(got.body.avatars).toEqual([]);
    });
  });
});
