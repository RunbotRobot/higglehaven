// #4198: the Worker refuses a placement whose footprint leaves the lándlet's real outline, not just the 31.6 m square.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';
import { itemLegalAt, setBuildOutline, getBuildOutline } from '../src/build/outlineLimit.js';

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
    expect(over.body.code).toBe('outside_landlet_outline');
  });

  it('keeps the square rule for a lándlet whose polygon is unusable', async () => {
    const owner = await signupBuilder('instance-outline-fallback-owner');
    await landlet('instance-outline-empty-lot', owner.builderId, '[]');
    expect((await place(owner, 'instance-outline-empty-lot', 'outline-fallback', 5, 5)).response.status).toBe(201);
    expect((await place(owner, 'instance-outline-empty-lot', 'outline-fallback-far', 40, 0)).response.status).toBe(400);
  });
});

// #4403: the older "buildable footprint" square check measured an item by its unturned width and depth, so a long item
// turned a quarter way round was judged by its long side along the axis it no longer lies on, and was refused where the
// outline rule (and Build's own stop, which uses it) says it fits. A turned bundle then rested at an angle the server
// refused for some members.
const SQUARE_31_6 = JSON.stringify([{ x: -15.8, y: -15.8 }, { x: 15.8, y: -15.8 }, { x: 15.8, y: 15.8 }, { x: -15.8, y: 15.8 }]);

describe('a turned item is measured by its turned footprint (#4403)', () => {
  async function longTemplate(templateId) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({ templateId, name: 'Long plank', color: '#886644', dimensions: { width: 2, depth: 0.5, height: 1 } }),
    });
    expect(created.response.status).toBe(201);
  }

  it('accepts a long item turned a quarter way round whose real footprint fits, and still refuses one that sticks out', async () => {
    const owner = await signupBuilder('instance-turned-owner');
    await landlet('instance-turned-lot', owner.builderId, SQUARE_31_6);
    await longTemplate('turned-plank');
    const at = (instanceId, x, y, rotationZ) => api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({ instanceId, landletId: 'instance-turned-lot', templateId: 'turned-plank', x, y, z: 0, rotationZ }),
    }));
    // Lying along x (unturned): its half length 1 would reach 16.4 from x = 15.4, past the 15.8 edge.
    expect((await at('plank-straight-out', 15.4, 0, 0)).response.status).toBe(400);
    // Turned a quarter way round it lies along y: along x it is only 0.5 wide, so from x = 15.4 it reaches 15.65.
    expect((await at('plank-turned-in', 15.4, 0, Math.PI / 2)).response.status).toBe(201);
    // Turned, but its end sticks out past the edge along y.
    expect((await at('plank-turned-out', 0, 15.4, Math.PI / 2)).response.status).toBe(400);
  });
});

// #4403: soundness of Build's stop against the real route. Every pose Build's own limit calls legal must be one the
// Worker stores (a refused pose is exactly what left a turned bundle half saved). Poses are spread over turns and
// places close to the edge, for two shapes of item, on a lándlet whose outline is the square.
describe('what Build calls legal, the Worker stores (#4403)', () => {
  it('never refuses a pose Build\'s own limit allows, near the edge, for turned long and square items', async () => {
    const owner = await signupBuilder('instance-sound-owner');
    // The outline reaches past the 31.6 m square (as the real organic outlines do), so the square is the tighter rule.
    const BIGGER = JSON.stringify([{ x: -17, y: -17 }, { x: 17, y: -17 }, { x: 17, y: 17 }, { x: -17, y: 17 }]);
    await landlet('instance-sound-lot', owner.builderId, BIGGER);
    await api('/catalog', { method: 'POST', body: JSON.stringify({ templateId: 'sound-plank', name: 'Sound plank', color: '#886644', dimensions: { width: 2, depth: 0.5, height: 1 } }) });
    await api('/catalog', { method: 'POST', body: JSON.stringify({ templateId: 'sound-block', name: 'Sound block', color: '#446688', dimensions: { width: 1, depth: 1, height: 1 } }) });
    setBuildOutline(BIGGER);
    const outline = getBuildOutline();
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const shapes = [['sound-plank', 2, 0.5], ['sound-block', 1, 1]];
    let legalCount = 0;
    for (let i = 0; i < 160; i += 1) {
      const [templateId, width, depth] = shapes[i % 2];
      const rotationZ = random() * Math.PI * 2;
      // Close to the square's edge on a random side, some past it (inside the bigger outline): along the whole side.
      const along = (random() * 2 - 1) * 15;
      const across = 16.4 - random() * 2.2;
      const [x, y] = i % 4 < 2 ? [across * (i % 2 ? 1 : -1), along] : [along, across * (i % 2 ? 1 : -1)];
      if (!itemLegalAt(outline, { width, depth, rotationZ }, x, y, 0)) continue;
      legalCount += 1;
      const stored = await api('/instances', owner.session({
        method: 'POST',
        body: JSON.stringify({ instanceId: `sound-${i}`, landletId: 'instance-sound-lot', templateId, x, y, z: 0, rotationZ }),
      }));
      expect(stored.response.status, `pose ${i}: ${templateId} at (${x.toFixed(3)}, ${y.toFixed(3)}) turned ${rotationZ.toFixed(3)}: ${JSON.stringify(stored.body)}`).toBe(201);
    }
    expect(legalCount).toBeGreaterThan(25);
  });
});
