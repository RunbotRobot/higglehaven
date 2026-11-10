// #3417 (5/7 of #3412): GET /api/far-placements?tile=x,y -- compact, edge-cached,
// public placements for far view. Content rules mirror what a shopper sees up
// close (published vs draft, suspended builder/seller, delisted); the encoding
// round-trips; a cache hit costs no query; activating a version invalidates.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api, signupAdmin, signupSeller, createGreenbeltLandletAs,
} from './test-helpers.js';
import { decodeFarPlacements } from './lib/far-placements-encoding.js';
import { FAR_PLACEMENT_TILE_M } from './lib/far-placements.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('far-admin')).session;
});

// Each test uses its own tile (a distinct far-away centre) so no test sees
// another's landlets or cached tile.
let nextTile = 40;
function freshTile() {
  nextTile += 1;
  return { x: nextTile, y: -nextTile, center: { x: nextTile * FAR_PLACEMENT_TILE_M + 100, y: -nextTile * FAR_PLACEMENT_TILE_M + 100 } };
}
const readTile = (tile) => api(`/far-placements?tile=${tile.x},${tile.y}`);

async function setupLandlet(landletId, center, builder) {
  const created = await createGreenbeltLandletAs(adminSession, landletId, center);
  expect(created.response.status).toBe(201);
  if (builder) {
    const claimed = await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
  }
}

async function createTemplate(templateId, seller) {
  const created = await api('/catalog', seller.session({
    method: 'POST',
    body: JSON.stringify({
      templateId, sellerId: seller.sellerId, name: `Far ${templateId}`, color: '#123456',
      dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 500,
    }),
  }));
  expect(created.response.status).toBe(201);
}

async function place(builder, landletId, templateId, fields = {}) {
  const placed = await api('/instances', builder.session({
    method: 'POST',
    body: JSON.stringify({ instanceId: `i-${crypto.randomUUID()}`, landletId, templateId, x: 0, y: 0, ...fields }),
  }));
  expect(placed.response.status).toBe(201);
  return placed.body.instance;
}

describe('GET /api/far-placements (#3417)', () => {
  it('returns a landlet\'s placements compactly, round-trips through the decoder, and omits what far view never uses', async () => {
    const tile = freshTile();
    const seller = await signupSeller('far-basic-seller');
    const builder = await signupAdmin('far-basic-builder');
    await createTemplate('far-basic-a', seller);
    await createTemplate('far-basic-b', seller);
    await setupLandlet('far-basic-landlet', tile.center, builder);
    await place(builder, 'far-basic-landlet', 'far-basic-a', { x: 3.14159, y: -2.5, z: 1, rotationZ: 1.23456, scale: 2, label: 'secret label' });
    await place(builder, 'far-basic-landlet', 'far-basic-b', { x: 5, y: 6 });
    await place(builder, 'far-basic-landlet', 'far-basic-a', { x: -4, y: 4 });

    const { response, body } = await readTile(tile);
    expect(response.status).toBe(200);
    expect(body.tile).toEqual({ x: tile.x, y: tile.y, sizeM: FAR_PLACEMENT_TILE_M });
    // The product table lists each product once; items refer to it by index.
    expect([...body.templates].sort()).toEqual(['far-basic-a', 'far-basic-b']);
    expect(body.landlets).toHaveLength(1);
    const [landlet] = body.landlets;
    expect(landlet).toMatchObject({ id: 'far-basic-landlet', cx: tile.center.x, cy: tile.center.y });
    expect(landlet.items).toHaveLength(3);
    // Compact: arrays of numbers, rounded to a centimetre / milliradian.
    for (const item of landlet.items) expect(item.every((value) => typeof value === 'number')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('secret label');

    const decoded = decodeFarPlacements(body);
    const rounded = decoded.landlets[0].items.find((item) => item.templateId === 'far-basic-a' && item.scale === 2);
    expect(rounded).toMatchObject({ x: 3.14, y: -2.5, z: 1, rotationZ: 1.235, scale: 2, crop: null });
    expect(decoded.landlets[0].items.map((item) => item.templateId).sort()).toEqual(['far-basic-a', 'far-basic-a', 'far-basic-b']);
  });

  it('only returns landlets whose centre is inside the requested tile, and validates the tile', async () => {
    const tile = freshTile();
    const other = freshTile();
    const builder = await signupAdmin('far-tile-builder');
    const otherBuilder = await signupAdmin('far-tile-other-builder');
    const seller = await signupSeller('far-tile-seller');
    await createTemplate('far-tile-template', seller);
    await setupLandlet('far-tile-in', tile.center, builder);
    await setupLandlet('far-tile-out', other.center, otherBuilder);
    await place(builder, 'far-tile-in', 'far-tile-template');
    await place(otherBuilder, 'far-tile-out', 'far-tile-template');

    const { body } = await readTile(tile);
    expect(body.landlets.map((l) => l.id)).toEqual(['far-tile-in']);

    for (const bad of ['', 'tile=1', 'tile=a,b', 'tile=1,2,3', 'tile=99999,0', 'tile=1.5,2']) {
      const result = await api(`/far-placements${bad ? `?${bad}` : ''}`);
      expect(result.response.status, bad).toBe(400);
    }
    const empty = await api('/far-placements?tile=-900,-900');
    expect(empty.response.status).toBe(200);
    expect(empty.body.landlets).toEqual([]);
  });

  it('shows the published version, not the draft, once a landlet has one, and activating invalidates the cached tile', async () => {
    const tile = freshTile();
    const seller = await signupSeller('far-pub-seller');
    const builder = await signupAdmin('far-pub-builder');
    await createTemplate('far-pub-template', seller);
    await setupLandlet('far-pub-landlet', tile.center, builder);
    await place(builder, 'far-pub-landlet', 'far-pub-template', { x: 1, y: 1 });

    const versioned = await api('/landlets/far-pub-landlet/versions', builder.session({ method: 'POST', body: JSON.stringify({ name: 'v1' }) }));
    expect(versioned.response.status).toBe(201);
    const versionId = versioned.body.version.versionId;

    // Before activation the landlet has no published version: the draft shows.
    const draftRead = await readTile(tile);
    expect(draftRead.body.landlets[0].items).toHaveLength(1);

    const activated = await api(`/landlets/far-pub-landlet/versions/${versionId}/activate`, builder.session({ method: 'POST' }));
    expect(activated.response.status).toBe(200);

    // The draft moves on; shoppers (and far view) keep seeing the published copy.
    await place(builder, 'far-pub-landlet', 'far-pub-template', { x: 9, y: 9 });
    await place(builder, 'far-pub-landlet', 'far-pub-template', { x: 8, y: 8 });
    const afterActivate = await api(`/far-placements?tile=${tile.x},${tile.y}`);
    expect(afterActivate.response.headers.get('x-far-placements-cache')).toBe('miss'); // invalidated by the activation
    expect(afterActivate.body.landlets[0].items).toHaveLength(1);
  });

  it('serves a repeat read from the cache without querying D1, and says so', async () => {
    const tile = freshTile();
    const seller = await signupSeller('far-cache-seller');
    const builder = await signupAdmin('far-cache-builder');
    await createTemplate('far-cache-template', seller);
    await setupLandlet('far-cache-landlet', tile.center, builder);
    await place(builder, 'far-cache-landlet', 'far-cache-template');

    const first = await readTile(tile);
    expect(first.response.headers.get('x-far-placements-cache')).toBe('miss');
    expect(first.response.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
    expect(first.body.landlets[0].items).toHaveLength(1);

    // A change made straight in the database is invisible to a hit: proof that
    // the second read did not query D1.
    await env.DB.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind('far-cache-landlet').run();
    const second = await readTile(tile);
    expect(second.response.headers.get('x-far-placements-cache')).toBe('hit');
    expect(second.body).toEqual(first.body);
  });

  it('leaves out a suspended seller\'s products, a delisted product, and everything on a suspended builder\'s landlet', async () => {
    const tile = freshTile();
    const goodSeller = await signupSeller('far-vis-good-seller');
    const badSeller = await signupSeller('far-vis-bad-seller');
    const builder = await signupAdmin('far-vis-builder');
    const suspendedBuilder = await signupAdmin('far-vis-suspended-builder');
    await createTemplate('far-vis-good', goodSeller);
    await createTemplate('far-vis-bad', badSeller);
    await createTemplate('far-vis-delisted', goodSeller);
    await setupLandlet('far-vis-landlet', tile.center, builder);
    await setupLandlet('far-vis-suspended-landlet', { x: tile.center.x + 50, y: tile.center.y + 50 }, suspendedBuilder);
    await place(builder, 'far-vis-landlet', 'far-vis-good');
    await place(builder, 'far-vis-landlet', 'far-vis-bad', { x: 2 });
    await place(builder, 'far-vis-landlet', 'far-vis-delisted', { x: 3 });
    await place(suspendedBuilder, 'far-vis-suspended-landlet', 'far-vis-good');

    // The suspended seller's instance is removed from drafts at suspension
    // (#2986); put it back directly so the read-side filter is what is tested.
    await env.DB.prepare(`
      INSERT INTO account_suspensions (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at)
      SELECT ?, user_id, user_id, 'far test', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM sellers WHERE seller_id = ?
    `).bind(`susp-${crypto.randomUUID()}`, badSeller.sellerId).run();
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m)
      VALUES (?, 'far-vis-landlet', 'far-vis-bad', 2, 2)
    `).bind(`i-${crypto.randomUUID()}`).run();
    await env.DB.prepare(`UPDATE catalog_templates SET delisted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE template_id = 'far-vis-delisted'`).run();
    await env.DB.prepare(`
      INSERT INTO account_suspensions (suspension_id, user_id, admin_user_id, reason, grace_period_ends_at)
      SELECT ?, user_id, user_id, 'far test builder', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM builders WHERE builder_id = ?
    `).bind(`susp-${crypto.randomUUID()}`, suspendedBuilder.builderId).run();

    const { body } = await readTile(tile);
    const decoded = decodeFarPlacements(body);
    expect(decoded.landlets.map((l) => l.id)).toEqual(['far-vis-landlet']);
    expect(decoded.landlets[0].items.map((item) => item.templateId)).toEqual(['far-vis-good']);
  });

  it('keeps the response small for a dense landlet (829 placed items)', async () => {
    const tile = freshTile();
    const seller = await signupSeller('far-dense-seller');
    const builder = await signupAdmin('far-dense-builder');
    await createTemplate('far-dense-brick', seller);
    await setupLandlet('far-dense-landlet', tile.center, builder);
    const statements = [];
    for (let i = 0; i < 829; i += 1) {
      statements.push(env.DB.prepare(`
        INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_z_rad)
        VALUES (?, 'far-dense-landlet', 'far-dense-brick', ?, ?, ?, ?)
      `).bind(`dense-${i}`, (i % 40) * 0.8 - 16, Math.floor(i / 40) * 0.4 - 4, (i % 7) * 0.25, (i % 4) * 1.5708));
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));

    const { response, body } = await readTile(tile);
    const raw = new TextEncoder().encode(JSON.stringify(body));
    // What actually crosses the network: the edge gzips JSON responses.
    const gzipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    console.log(`far-placements response for an 829-item landlet: ${raw.length} bytes raw (${(raw.length / 829).toFixed(1)} per item), ${gzipped.length} bytes gzipped`);
    expect(response.status).toBe(200);
    expect(body.landlets[0].items).toHaveLength(829);
    expect(raw.length).toBeLessThan(40_000);
    expect(gzipped.length).toBeLessThan(8_000);
  });
});
