// #1101 (sub-issue of #1095, multiplayer presence): avatar_presence (#1097)
// is live state upserted on every position report (#1098) with nothing
// else ever deleting a row once a builder stops reporting. This covers the
// periodic-sweep half of that cleanup -- pruneStaleAvatarPresence, called
// from scheduled() on the existing cron. The read-time "exclude a stale row
// from a GET response" half belongs to #1099's own endpoint, not this file.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { pruneStaleAvatarPresence } from './index.js';
import { signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function userIdOf(builder) {
  return (await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?').bind(builder.builderId).first()).user_id;
}

async function seedPresence(builderId, ageMs) {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO avatar_presence (user_id, landlet_id, x, y, z, heading, updated_at)
    VALUES ((SELECT user_id FROM builders WHERE builder_id = ?), 'landlet-1', 1, 2, 3, 0, ?)
  `).bind(builderId, updatedAt).run();
}

describe('pruneStaleAvatarPresence (#1101)', () => {
  it('deletes a long-stale row and leaves a fresh one untouched', async () => {
    const stale = await signupBuilder('presence-cleanup-stale');
    const fresh = await signupBuilder('presence-cleanup-fresh');
    await seedPresence(stale.builderId, 10 * 60 * 1000); // 10 minutes old
    await seedPresence(fresh.builderId, 5 * 1000); // 5 seconds old

    await pruneStaleAvatarPresence(env.DB);

    const remaining = await env.DB.prepare('SELECT user_id FROM avatar_presence').all();
    const remainingIds = remaining.results.map((row) => row.user_id);
    expect(remainingIds).not.toContain(await userIdOf(stale));
    expect(remainingIds).toContain(await userIdOf(fresh));
  });

  it('is a no-op when avatar_presence has no stale rows', async () => {
    const fresh = await signupBuilder('presence-cleanup-fresh-only');
    await seedPresence(fresh.builderId, 1000);

    await pruneStaleAvatarPresence(env.DB);

    const row = await env.DB.prepare('SELECT user_id FROM avatar_presence WHERE user_id = ?')
      .bind(await userIdOf(fresh)).first();
    expect(row).toBeTruthy();
  });
});
