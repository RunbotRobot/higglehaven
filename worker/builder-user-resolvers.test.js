import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  userIdForBuilder, builderIdForUser, userIdsForBuilders, builderIdsForUsers, RESOLVER_CHUNK_SIZE,
} from './lib/auth.js';
import { signupBuilder } from './test-helpers.js';

// #3144 (1/6 of #3141): the shared builder_id <-> user_id resolvers the social
// tables migrate through.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('builder <-> user resolvers', () => {
  it('resolves both ways for a builder with an account', async () => {
    const builder = await signupBuilder('resolver-pair');
    const row = await env.DB.prepare('SELECT user_id FROM builders WHERE builder_id = ?')
      .bind(builder.builder.builderId).first();
    expect(row.user_id).toBeTruthy();

    expect(await userIdForBuilder(env.DB, builder.builder.builderId)).toBe(row.user_id);
    expect(await builderIdForUser(env.DB, row.user_id)).toBe(builder.builder.builderId);
  });

  it('returns null for an unknown id, an empty id, and a builder with no account (user_id NULL)', async () => {
    await env.DB.prepare('INSERT INTO builders (builder_id, label) VALUES (?, ?)')
      .bind('resolver-preauth-builder', 'Pre-auth').run();

    expect(await userIdForBuilder(env.DB, 'resolver-no-such-builder')).toBeNull();
    expect(await userIdForBuilder(env.DB, '')).toBeNull();
    expect(await userIdForBuilder(env.DB, undefined)).toBeNull();
    expect(await userIdForBuilder(env.DB, 'resolver-preauth-builder')).toBeNull();
    expect(await builderIdForUser(env.DB, 'resolver-no-such-user')).toBeNull();
    expect(await builderIdForUser(env.DB, null)).toBeNull();
  });

  it('the set versions skip what they cannot resolve and ignore duplicates and empties', async () => {
    const a = await signupBuilder('resolver-set-a');
    const b = await signupBuilder('resolver-set-b');
    await env.DB.prepare('INSERT INTO builders (builder_id, label) VALUES (?, ?)')
      .bind('resolver-set-preauth', 'Pre-auth').run();

    const builderIds = [a.builder.builderId, b.builder.builderId, a.builder.builderId, 'resolver-set-preauth', 'resolver-set-missing', '', null];
    const byBuilder = await userIdsForBuilders(env.DB, builderIds);
    expect([...byBuilder.keys()].sort()).toEqual([a.builder.builderId, b.builder.builderId].sort());

    const byUser = await builderIdsForUsers(env.DB, [...byBuilder.values(), 'resolver-set-no-such-user', undefined]);
    expect(byUser.size).toBe(2);
    for (const [builderId, userId] of byBuilder) expect(byUser.get(userId)).toBe(builderId);

    expect((await userIdsForBuilders(env.DB, [])).size).toBe(0);
    expect((await builderIdsForUsers(env.DB, undefined)).size).toBe(0);
  });

  it('chunks lists larger than the D1 bound-parameter limit', async () => {
    const count = RESOLVER_CHUNK_SIZE * 2 + 17; // spans three chunks, past 100 parameters
    const rows = Array.from({ length: count }, (_, i) => ({
      userId: `resolver-chunk-user-${i}`, builderId: `resolver-chunk-builder-${i}`,
    }));
    await env.DB.batch(rows.flatMap((r, i) => [
      env.DB.prepare('INSERT INTO users (user_id, email, username, password_hash) VALUES (?, ?, ?, ?)')
        .bind(r.userId, `resolver-chunk-${i}@example.test`, `resolver-chunk-${i}`, 'x'),
      env.DB.prepare('INSERT INTO builders (builder_id, label, user_id) VALUES (?, ?, ?)')
        .bind(r.builderId, `chunk ${i}`, r.userId),
    ]));

    const byBuilder = await userIdsForBuilders(env.DB, rows.map((r) => r.builderId));
    expect(byBuilder.size).toBe(count);
    expect(byBuilder.get('resolver-chunk-builder-0')).toBe('resolver-chunk-user-0');
    expect(byBuilder.get(`resolver-chunk-builder-${count - 1}`)).toBe(`resolver-chunk-user-${count - 1}`);

    const byUser = await builderIdsForUsers(env.DB, rows.map((r) => r.userId));
    expect(byUser.size).toBe(count);
    expect(byUser.get(`resolver-chunk-user-${count - 1}`)).toBe(`resolver-chunk-builder-${count - 1}`);
  });
});
