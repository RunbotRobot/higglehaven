// #2779 (sub-issue of #2777): nearby_chat_messages (migrations/0155) is
// deliberately ephemeral -- this covers the periodic-sweep half of that,
// pruneStaleNearbyChatMessages, called from scheduled() on the existing
// cron. Mirrors avatar-presence-cleanup.test.js's own shape exactly.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { pruneStaleNearbyChatMessages } from './index.js';
import { signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function seedMessage(builderId, ageMs) {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO nearby_chat_messages (message_id, builder_id, landlet_id, text, created_at)
    VALUES (?, ?, 'landlet-1', 'hi', ?)
  `).bind(`nearby-chat-cleanup-${builderId}`, builderId, createdAt).run();
}

describe('pruneStaleNearbyChatMessages (#2779)', () => {
  it('deletes a long-stale message and leaves a fresh one untouched', async () => {
    const stale = await signupBuilder('nearby-chat-cleanup-stale');
    const fresh = await signupBuilder('nearby-chat-cleanup-fresh');
    await seedMessage(stale.builderId, 60 * 60 * 1000); // 1 hour old
    await seedMessage(fresh.builderId, 5 * 1000); // 5 seconds old

    await pruneStaleNearbyChatMessages(env.DB);

    const remaining = await env.DB.prepare('SELECT builder_id FROM nearby_chat_messages').all();
    const remainingIds = remaining.results.map((row) => row.builder_id);
    expect(remainingIds).not.toContain(stale.builderId);
    expect(remainingIds).toContain(fresh.builderId);
  });

  it('is a no-op when nearby_chat_messages has no stale rows', async () => {
    const fresh = await signupBuilder('nearby-chat-cleanup-fresh-only');
    await seedMessage(fresh.builderId, 1000);

    await pruneStaleNearbyChatMessages(env.DB);

    const row = await env.DB.prepare('SELECT builder_id FROM nearby_chat_messages WHERE builder_id = ?')
      .bind(fresh.builderId).first();
    expect(row).toBeTruthy();
  });
});
