// #4074: GET /auth/admin-landlet-search, the admin dashboard's lándlet search by name, id or owner.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';
import { searchWords, rankLandlet, LANDLET_SEARCH_LIMIT } from './lib/admin-landlet-search.js';

let adminSession;
let owner;
const search = async (q) => (await api(`/auth/admin-landlet-search?q=${encodeURIComponent(q)}`, adminSession())).body;
const ids = (body) => body.landlets.map((l) => l.landletId);

async function insertLandlet(landletId, name, { status = 'greenbelt', ownerBuilderId = null } = {}) {
  await env.DB.prepare('INSERT INTO landlets (landlet_id, name, status, owner_builder_id) VALUES (?1, ?2, ?3, ?4)')
    .bind(landletId, name, status, ownerBuilderId).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('landlet-search-admin')).session;
  owner = await signupBuilder('runbotlike');
  await insertLandlet('central-mosaic-002', 'central-mosaic-002', { status: 'claimed', ownerBuilderId: owner.builderId });
  await insertLandlet('central-mosaic-012', 'central-mosaic-012');
  await insertLandlet('north-ridge-001', 'North Ridge');
});

describe('words and ranking (#4074)', () => {
  it('treats case and any punctuation the same', () => {
    expect(searchWords('Central-Mosaic 2')).toEqual(['central', 'mosaic', '2']);
    expect(searchWords('central_mosaic__2')).toEqual(['central', 'mosaic', '2']);
    expect(searchWords('   ')).toEqual([]);
    expect(searchWords(null)).toEqual([]);
  });

  it('matches a number whatever its leading zeros, and a longer number that starts with it', () => {
    const landlet = { landletId: 'central-mosaic-002', name: 'central-mosaic-002', ownerUsername: null };
    expect(rankLandlet(['central', 'mosaic', '2'], landlet)).not.toBeNull();
    expect(rankLandlet(['central', 'mosaic', '002'], landlet)).not.toBeNull();
    expect(rankLandlet(['central', 'mosaic', '3'], landlet)).toBeNull();
  });
});

describe('GET /auth/admin-landlet-search (#4074)', () => {
  it('refuses a signed-out caller and a signed-in non-admin', async () => {
    expect((await api('/auth/admin-landlet-search?q=central')).response.status).toBe(401);
    const builder = await signupBuilder('landlet-search-non-admin');
    expect((await api('/auth/admin-landlet-search?q=central', builder.session())).response.status).toBe(403);
  });

  it('returns nothing for an empty query', async () => {
    const body = await search('  ');
    expect(body.landlets).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('finds the same place however the name is spelled', async () => {
    for (const q of ['central-mosaic 2', 'central mosaic 2', 'Central_Mosaic_002', 'central-mosaic-002']) {
      expect(ids(await search(q))).toEqual(['central-mosaic-002']);
    }
  });

  it('finds a lándlet by a part of its name and ranks the exact id first', async () => {
    const body = await search('central mosaic');
    expect(ids(body)).toEqual(['central-mosaic-002', 'central-mosaic-012']);
    expect((await search('north ridge')).landlets[0].landletId).toBe('north-ridge-001');
    expect(ids(await search('central-mosaic-012'))[0]).toBe('central-mosaic-012');
  });

  it("lists what a person owns by their username, with the owner and status on each row", async () => {
    const body = await search('runbotlike');
    expect(ids(body)).toEqual(['central-mosaic-002']);
    expect(body.landlets[0]).toMatchObject({ status: 'claimed', ownerUsername: 'runbotlike', ownerBuilderId: owner.builderId });
  });

  it('caps what it shows and says how many matched', async () => {
    for (let i = 0; i < LANDLET_SEARCH_LIMIT + 5; i += 1) await insertLandlet(`bulk-plot-${String(i).padStart(3, '0')}`, `bulk-plot-${i}`);
    const body = await search('bulk plot');
    expect(body.total).toBe(LANDLET_SEARCH_LIMIT + 5);
    expect(body.shown).toBe(LANDLET_SEARCH_LIMIT);
    expect(body.landlets).toHaveLength(LANDLET_SEARCH_LIMIT);
  });

  it('a query with only a number still finds by number', async () => {
    const body = await search('12');
    expect(ids(body)).toContain('central-mosaic-012');
    expect(ids(body)).not.toContain('north-ridge-001');
  });
});
