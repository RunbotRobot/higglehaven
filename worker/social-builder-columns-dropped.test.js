// #3149 (6/6 of #3141): the retired builder-id columns are gone from every
// social table, and the account-keyed indexes that replaced them are in place.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const columnsOf = async (table) => (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all())
  .results.map((row) => row.name);

const SOCIAL_TABLES = [
  'friendships', 'direct_messages', 'avatar_presence', 'nearby_chat_messages',
  'voice_signaling_messages', 'friend_voice_channel_members', 'voice_conduct_reports', 'nearby_chat_reports',
];

describe('social tables carry no builder-id columns (#3149)', () => {
  for (const table of SOCIAL_TABLES) {
    it(`${table} has no *_builder_id column`, async () => {
      const columns = await columnsOf(table);
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.filter((name) => name.endsWith('builder_id'))).toEqual([]);
    });
  }

  it('keeps the one-per-reporter unique index on the account pair for both report tables', async () => {
    for (const table of ['voice_conduct_reports', 'nearby_chat_reports']) {
      const index = await env.DB.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
        .bind('index', `idx_${table}_pair`).first();
      expect(index.sql).toContain('(reporter_user_id, reported_user_id)');
    }
  });
});
