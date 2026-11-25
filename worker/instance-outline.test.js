// #4198: the Worker refuses a placement whose footprint leaves the lándlet's real outline, not just the 31.6 m square.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

// A right triangle: legs along the left and bottom edges, the slanted edge from (10,-10) to (-10,10).
const TRIANGLE = JSON.stringify([{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: -10, y: 10 }]);

async function landlet(id, ownerBuilderId, polygon) {
  await env.DB.prepare(`
    INSERT INTO landlets (landlet_id, name, owner_builder_id, status, polygon_json) VALUES (?, ?, ?, 'claimed', ?)
  `).bind(id, id, ownerBuilderId, polygon).run();
}

const place = (owner, landletId, instanceId, x, y, extra = {}) => api('/instances', owner.session({
  method: 'POST',
  body: JSON.stringify({ instanceId, landletId, templateId: 'placeholder-tree', x, y, z: 0, ...extra }),
}));

describe('placing inside a lándlet outline (#4198)', () => {
  it('accepts a tree on the lándlet and refuses one past the slanted edge, though it is inside the square', async () => {
    const owner = await signupBuilder('instance-outline-owner');
    await landlet('instance-outline-lot', owner.builderId, TRIANGLE);
    expect((await place(owner, 'instance-outline-lot', 'outline-inside', -5, -5)).response.status).toBe(201);
    const over = await place(owner, 'instance-outline-lot', 'outline-over', 5, 5);
    expect(over.response.status).toBe(400);
    expect(over.body.error).toMatch(/outline/);
  });

  it('keeps the square rule for a lándlet whose polygon is unusable', async () => {
    const owner = await signupBuilder('instance-outline-fallback-owner');
    await landlet('instance-outline-empty-lot', owner.builderId, '[]');
    expect((await place(owner, 'instance-outline-empty-lot', 'outline-fallback', 5, 5)).response.status).toBe(201);
    expect((await place(owner, 'instance-outline-empty-lot', 'outline-fallback-far', 40, 0)).response.status).toBe(400);
  });
});
