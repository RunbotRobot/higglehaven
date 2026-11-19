#!/usr/bin/env node
// #3930 (part of #3539), item 1: a seeded local world for looking at the app as a person.
//
// A running `wrangler dev` instance with two ordinary accounts and enough standing in the
// world that the looks which "could not be taken from a coding session" can be taken:
//
//   looker    a builder with a claimed lándlet (a dozen catalog items placed, one bundle),
//             and a seller with three products, one of them sold out
//   neighbor  a second account: a pending friend request to looker, and a seller whose
//             product looker has bought once (an order not yet rated)
//   looker    also has a notice (a seller changed the size of a placed product) and has
//             left a question for an assistant
//
// Sign in as either with scripts/live-site.mjs's local login, which uses exactly these
// names and the password it already uses for any local account:
//
//   node scripts/live-site.mjs --url http://127.0.0.1:8787 --login local --name looker idle shot
//
// Local only: it refuses any address that is not this machine, and `--remote`. Idempotent:
// run it again and it finds what is already there (accounts are signed in to, not recreated,
// and a step whose result is already in place is skipped), so re-running adds nothing.
//
// Usage (see AGENTS.md, "Looking at the live site as a person"):
//   npm run build && npx wrangler d1 migrations apply higglehaven-db --local
//   npx wrangler dev --local --ip 127.0.0.1 --port 8787     # needs .dev.vars with
//        ADMIN_BOOTSTRAP_SECRET=local-dev-admin-secret (the same fixture the e2e suite uses)
//   node scripts/seed-local-world.mjs [--url http://127.0.0.1:8787]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_PASSWORD, parseSeedArgs } from './seed-local-world-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_SECRET = process.env.SEED_ADMIN_BOOTSTRAP_SECRET || 'local-dev-admin-secret';

export async function seedLocalWorld(baseUrl, log = console.log) {
  async function call(method, route, cookie, body) {
    const isForm = body instanceof FormData;
    const response = await fetch(`${baseUrl}/api${route}`, {
      method,
      headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data, response };
  }
  async function must(method, route, cookie, body) {
    const result = await call(method, route, cookie, body);
    if (!result.ok) throw new Error(`seed-local-world: ${method} ${route} -> ${result.status}: ${result.data.error || JSON.stringify(result.data)}`);
    return result;
  }
  const sessionOf = (response) => response.headers.get('set-cookie')?.match(/hh_session=([^;]+)/)?.[0] ?? null;

  // Sign in (or up) the way live-site.mjs's local login does, so the same names work for both.
  async function account(name) {
    const email = `${name}@e2e.test`;
    let result = await call('POST', '/auth/signup', null, { email, password: SEED_PASSWORD, username: name, ageAttested: true });
    if (!result.ok) result = await must('POST', '/auth/login', null, { email, password: SEED_PASSWORD });
    const cookie = sessionOf(result.response);
    if (!cookie) throw new Error(`seed-local-world: no session for ${name}`);
    // No card key is set locally, so this takes the simulated path and marks the account verified.
    await call('POST', '/auth/confirm-card', cookie);
    const { builder } = (await must('GET', '/builders/me', cookie)).data;
    return { name, cookie, builderId: builder.builderId };
  }

  const looker = await account('looker');
  const neighbor = await account('neighbor');
  log(`Accounts ready: ${looker.name}, ${neighbor.name}.`);

  // ---- A claimed lándlet for each ----
  // Admin only to make room when none is free (the same escape hatch the e2e helpers use).
  let adminCookiePromise = null;
  function adminCookie() {
    adminCookiePromise ??= (async () => {
      const tag = Date.now().toString(36);
      const signup = await must('POST', '/auth/signup', null, { email: `seed-admin-${tag}@e2e.test`, password: SEED_PASSWORD, username: `seed-admin-${tag}`, ageAttested: true });
      const cookie = sessionOf(signup.response);
      const boot = await call('POST', '/auth/admin-bootstrap', cookie, { secret: ADMIN_SECRET });
      if (!boot.ok) throw new Error(`seed-local-world: admin bootstrap refused (${boot.status}); does .dev.vars set ADMIN_BOOTSTRAP_SECRET=${ADMIN_SECRET}?`);
      return cookie;
    })();
    return adminCookiePromise;
  }
  async function ensureLandlet(person) {
    const owned = (await must('GET', `/landlets?status=claimed&ownerBuilderId=${person.builderId}&limit=1`, person.cookie)).data.landlets;
    if (owned.length > 0) return owned[0].landletId;
    let free = (await must('GET', '/landlets?status=greenbelt&limit=1', person.cookie)).data.landlets;
    if (free.length === 0) {
      const id = `seed-lot-${Date.now().toString(36)}`;
      await must('POST', '/landlets', await adminCookie(), { landletId: id, name: id, areaM2: 1000, status: 'greenbelt' });
      free = (await must('GET', '/landlets?status=greenbelt&limit=1', person.cookie)).data.landlets;
    }
    const claimed = (await must('POST', `/landlets/${free[0].landletId}/claim`, person.cookie)).data.landlet.landletId;
    log(`${person.name} claimed ${claimed}.`);
    return claimed;
  }
  looker.landletId = await ensureLandlet(looker);
  neighbor.landletId = await ensureLandlet(neighbor);
  const landletId = looker.landletId;

  // ---- Products: the real models in public/models, so Build and Shop have something to draw ----
  const modelUrls = new Map();
  async function modelUrl(file) {
    if (modelUrls.has(file)) return modelUrls.get(file);
    const form = new FormData();
    form.set('file', new Blob([await readFile(path.join(repoRoot, 'public', 'models', file))], { type: 'model/gltf-binary' }), file);
    const url = (await must('POST', '/models', null, form)).data.modelUrl;
    modelUrls.set(file, url);
    return url;
  }
  async function ensureProducts(person, specs) {
    const sellerId = (await must('GET', '/sellers/me', person.cookie)).data.seller.sellerId;
    const have = (await must('GET', `/catalog?sellerId=${sellerId}&limit=100`, person.cookie)).data.templates ?? [];
    const out = {};
    for (const spec of specs) {
      let template = have.find((t) => t.name === spec.name);
      if (!template) {
        template = (await must('POST', '/catalog', person.cookie, {
          name: spec.name, category: spec.category, subcategory: spec.subcategory, color: spec.color,
          dimensions: spec.dimensions, priceCents: spec.priceCents, sellerId, modelUrl: await modelUrl(spec.model),
          metadata: spec.metadata ?? {}, ...(spec.stockQuantity !== undefined ? { stockQuantity: spec.stockQuantity } : {}),
        })).data.template;
        log(`${person.name} listed "${spec.name}"${spec.stockQuantity === 0 ? ' (sold out)' : ''}.`);
      }
      out[spec.name] = template;
    }
    return out;
  }
  const mine = await ensureProducts(looker, [
    { name: 'Oak Bookshelf', model: 'bookshelf.glb', category: 'furniture', subcategory: 'storage', color: '#654321', dimensions: { width: 0.9, depth: 0.3, height: 1.8 }, priceCents: 15900 },
    { name: 'Garden Bench', model: 'bench.glb', category: 'furniture', subcategory: 'seating', color: '#8b5a2b', dimensions: { width: 1.5, depth: 0.5, height: 0.8 }, priceCents: 8900 },
    { name: 'Warm Glow Floor Lamp', model: 'lamp.glb', category: 'lighting', color: '#f4d03f', dimensions: { width: 0.4, depth: 0.4, height: 1.6 }, priceCents: 6500, stockQuantity: 0 },
  ]);
  const theirs = await ensureProducts(neighbor, [
    { name: 'Terracotta Planter', model: 'planter.glb', category: 'garden', color: '#c0653a', dimensions: { width: 0.5, depth: 0.5, height: 0.5 }, priceCents: 2400 },
    { name: 'Rustic Storage Crate', model: 'crate.glb', category: 'furniture', subcategory: 'storage', color: '#a0522d', dimensions: { width: 0.8, depth: 0.6, height: 0.6 }, priceCents: 3500 },
  ]);

  // ---- A dozen items placed on looker's lándlet, one bundle, published ----
  const placed = (await must('GET', `/instances?landletId=${landletId}`, looker.cookie)).data.instances ?? [];
  if (placed.length < 12) {
    const cycle = [mine['Oak Bookshelf'], theirs['Terracotta Planter'], mine['Garden Bench'], theirs['Rustic Storage Crate']];
    for (let i = placed.length; i < 12; i += 1) {
      const template = cycle[i % cycle.length];
      await must('POST', '/instances', looker.cookie, { landletId, templateId: template.templateId, x: -5 + (i % 6) * 2, y: 1, z: -3 + Math.floor(i / 6) * 4 });
    }
    log(`Placed ${12 - placed.length} items on ${landletId}.`);
  }
  const bundles = (await must('GET', '/bundles', looker.cookie)).data.bundles ?? [];
  if (!bundles.some((b) => b.name === 'Reading Corner')) {
    await must('POST', '/bundles', looker.cookie, {
      name: 'Reading Corner', shared: true,
      items: [
        { templateId: mine['Oak Bookshelf'].templateId, dx: -0.5, dy: 0, dz: 0, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 1 },
        { templateId: mine['Garden Bench'].templateId, dx: 0.8, dy: 0, dz: 0, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 1 },
      ],
    });
    log('looker saved the bundle "Reading Corner".');
  }
  const versions = (await must('GET', `/landlets/${landletId}/versions`, looker.cookie)).data.versions ?? [];
  if (versions.length === 0) {
    const { version } = (await must('POST', `/landlets/${landletId}/versions`, looker.cookie, {})).data;
    await must('POST', `/landlets/${landletId}/versions/${version.versionId}/activate`, looker.cookie);
    log(`Published ${landletId}.`);
  }

  // ---- An order looker has not rated, from neighbor's product ----
  // The no-card purchase path is admin-only (worker/lib/purchase-creation.js, #653), so looker is
  // made an admin on this local server; it adds an admin link in Settings and nothing else a look needs.
  const orders = (await must('GET', '/purchases/mine', looker.cookie)).data.purchases ?? [];
  if (orders.length === 0) {
    const theirPlaced = (await must('GET', `/instances?landletId=${neighbor.landletId}`, neighbor.cookie)).data.instances ?? [];
    let instance = theirPlaced.find((i) => i.templateId === theirs['Terracotta Planter'].templateId);
    if (!instance) {
      instance = (await must('POST', '/instances', neighbor.cookie, { landletId: neighbor.landletId, templateId: theirs['Terracotta Planter'].templateId, x: 0, y: 1, z: 0 })).data.instance;
      const { version } = (await must('POST', `/landlets/${neighbor.landletId}/versions`, neighbor.cookie, {})).data;
      await must('POST', `/landlets/${neighbor.landletId}/versions/${version.versionId}/activate`, neighbor.cookie);
    }
    await must('POST', '/auth/grant-admin', await adminCookie(), { email: 'looker@e2e.test' });
    await must('POST', `/instances/${instance.instanceId}/purchase`, looker.cookie, { quantity: 1 });
    log('looker bought a Terracotta Planter (an order not yet rated).');
  }

  // ---- A notice: a seller changes the size of a product looker has placed ----
  if (theirs['Terracotta Planter'].dimensions.width === 0.5) {
    await must('PATCH', `/catalog/${theirs['Terracotta Planter'].templateId}`, neighbor.cookie, { dimensions: { width: 0.6, depth: 0.6, height: 0.6 } });
    log('neighbor resized the Terracotta Planter, so looker has a notice.');
  }

  // ---- A pending friend request, neighbor to looker ----
  const friendships = (await must('GET', '/friendships', looker.cookie)).data.friendships ?? [];
  if (friendships.length === 0) {
    await must('POST', '/friendships', neighbor.cookie, { recipientBuilderId: looker.builderId });
    log('neighbor sent looker a friend request.');
  }

  // ---- A question left for an assistant (none is on shift locally, so it waits in line) ----
  // Needs an ID-verified account (the adult-only gate), which a local account is not: that refusal is
  // the expected answer here, so the thread is left out and the look it was for still needs another way.
  const asked = (await must('GET', '/assistant-chat/question', looker.cookie)).data.question;
  if (!asked) {
    const left = await call('POST', '/assistant-chat/question', looker.cookie, { text: 'How do I move a placed item?' });
    log(left.ok ? 'looker left a question for an assistant.' : `No assistant thread seeded (${left.status}: ${left.data.error}).`);
  }

  return { looker, neighbor, landletId, call, must, repoRoot, readFile, log };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseSeedArgs(process.argv.slice(2));
    await seedLocalWorld(options.url);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
