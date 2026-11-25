// #3873 (part of #3464): every Build and Sell start waits on GET /api/builders/me, and each awaited D1 round
// trip is about 70-100 ms of it. handleMyBuilder reads the builder's own row and then recomputes the land cap,
// which used to read the same row again. Pins that the row is read once, and that the answer did not change.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleMyBuilder } from './lib/builder-profile.js';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

function recordingDb(real) {
  const sqls = [];
  const wrap = (stmt, sql) => new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'bind') return (...args) => wrap(target.bind(...args), sql);
      if (['first', 'run', 'all', 'raw'].includes(prop)) return (...args) => { sqls.push(sql); return target[prop](...args); };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: { prepare: (sql) => wrap(real.prepare(sql), sql), batch: (...args) => real.batch(...args) }, sqls };
}

describe('GET /api/builders/me round trips (#3873)', () => {
  it('reads the builder row once, not again for the land cap, and answers as before', async () => {
    const builder = await signupBuilder('builders-me-trips');
    const { db, sqls } = recordingDb(env.DB);
    const request = new Request('https://higglehaven.test/api/builders/me', builder.session());
    const response = await handleMyBuilder(request, db);
    expect(response.status).toBe(200);
    const body = await response.json();
    const viaRoute = await api('/builders/me', builder.session());
    expect(body.builder).toMatchObject({ builderId: builder.builderId, landCapM2: viaRoute.body.builder.landCapM2, ownedAreaM2: 0 });
    expect(sqls.filter((sql) => /SELECT \* FROM builders WHERE user_id/.test(sql))).toHaveLength(1);
    expect(sqls.filter((sql) => /SELECT \* FROM builders WHERE builder_id/.test(sql))).toHaveLength(0);
  });
});
