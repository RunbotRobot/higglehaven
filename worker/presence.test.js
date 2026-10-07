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

    // #1438: unlike every sibling list endpoint, this query had no LIMIT at
    // all — a landlet with many concurrent visitors would return every one
    // of them in a single response, and the client spawns a real avatar
    // mesh group per entry on every poll tick.
    it('caps the number of nearby avatars returned, favoring the most recently updated', async () => {
      const viewer = await signupBuilder('presence-cap-viewer');
      // Bulk-fabricating 205 other builders via real signup (password
      // hashing per account) is far too slow for a single test — insert
      // the `builders` rows directly instead, the same "produce the state
      // a real write would have, skip the expensive path" shortcut this
      // file's own setPresence already takes for avatar_presence itself.
      const otherBuilderIds = Array.from({ length: 205 }, () => `builder-presence-cap-${crypto.randomUUID()}`);
      for (const builderId of otherBuilderIds) {
        await env.DB.prepare('INSERT INTO builders (builder_id, label) VALUES (?, ?)').bind(builderId, builderId).run();
      }
      const base = Date.now();
      for (const [i, builderId] of otherBuilderIds.entries()) {
        await setPresence(builderId, {
          landletId: 'presence-landlet-cap',
          updatedAt: new Date(base - i * 10).toISOString(),
        });
      }

      const got = await api('/presence?landletId=presence-landlet-cap', viewer.session());
      expect(got.response.status).toBe(200);
      expect(got.body.avatars).toHaveLength(200);
      const returnedIds = new Set(got.body.avatars.map((a) => a.builderId));
      // The 200 most recently updated reports (i.e. the smallest indices
      // above, since each subsequent one is 10ms older) should all be
      // present; the 5 stalest should have been dropped by the cap.
      for (let i = 0; i < 200; i += 1) expect(returnedIds.has(otherBuilderIds[i])).toBe(true);
      for (let i = 200; i < 205; i += 1) expect(returnedIds.has(otherBuilderIds[i])).toBe(false);
    });
  });

  // #1176 (sub-issue of #1174, spawn flow's "Go to Last Location" button):
  // unlike GET /presence above, this is the caller's own row, with no
  // landletId required and no staleness filter — "wherever I was last,"
  // however long ago that was.
  describe('GET /presence/me', () => {
    it('requires a session', async () => {
      const anon = await api('/presence/me');
      expect(anon.response.status).toBe(401);
    });

    it('returns null when the caller has never reported a position', async () => {
      const builder = await signupBuilder('presence-me-none');
      const got = await api('/presence/me', builder.session());
      expect(got.response.status).toBe(200);
      expect(got.body.presence).toBeNull();
    });

    it('returns the caller\'s own last-reported row, even if long stale', async () => {
      const builder = await signupBuilder('presence-me-stale-ok');
      await setPresence(builder.builderId, {
        landletId: 'presence-me-landlet', x: 7, y: 8, z: 9, heading: 45,
        updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

      const got = await api('/presence/me', builder.session());
      expect(got.response.status).toBe(200);
      expect(got.body.presence).toEqual({
        builderId: builder.builderId,
        landletId: 'presence-me-landlet',
        x: 7,
        y: 8,
        z: 9,
        heading: 45,
        updatedAt: expect.any(String),
      });
    });

    it('never returns another builder\'s row', async () => {
      const builder = await signupBuilder('presence-me-isolation-self');
      const other = await signupBuilder('presence-me-isolation-other');
      await setPresence(other.builderId, { landletId: 'presence-me-landlet-2', x: 1, y: 1, z: 1 });

      const got = await api('/presence/me', builder.session());
      expect(got.response.status).toBe(200);
      expect(got.body.presence).toBeNull();
    });
  });
});
