#!/usr/bin/env node
// Populates a local `wrangler dev` instance with a varied, realistic-looking
// mockup dataset — several builders with claimed land and placed products, a
// seller with a real catalog (using the actual glTF models already in
// public/models/), reviews, notifications, a friendship, an auction with
// bids, simulated purchases (one refunded), a shared bundle, and a community
// sign + calendar. Dev-only tooling, not part of the deploy pipeline — see
// README.md's "Development" section for when to run this.
//
// Usage:
//   npm run build && wrangler dev --local   # in one terminal
//   npm run seed:mockup                     # in another, once that's up
//
// Idempotency: none attempted. Every run creates fresh accounts/templates/
// landlets with randomized ids — safe to re-run against a fresh D1 (see
// README's `npm run db:migrate:local` / the e2e suite's own D1-reset
// recipe), but re-running against an already-seeded DB just adds more of
// everything rather than replacing it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASE_URL = process.env.SEED_BASE_URL || 'http://localhost:8787';
const ADMIN_BOOTSTRAP_SECRET = process.env.SEED_ADMIN_BOOTSTRAP_SECRET || 'local-dev-admin-secret';
const PASSWORD = 'mockup-seed-password-123';

async function api(path, cookie, options = {}) {
  const response = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${body.error || JSON.stringify(body)}`);
  }
  return body;
}

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  const match = setCookie?.match(/hh_session=([^;]+)/);
  return match ? `hh_session=${match[1]}` : null;
}

async function signUp(email, username) {
  const response = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, username }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`signup ${email} -> ${response.status}: ${body.error}`);
  return { cookie: extractCookie(response), user: body.user };
}

async function makeAccount(label) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@mockup.local`;
  const { cookie } = await signUp(email, label);
  const { builder } = await api('/builders/me', cookie);
  return { label, email, cookie, builderId: builder.builderId };
}

async function ensureSeller(account) {
  const { seller } = await api('/sellers/me', account.cookie);
  return seller.sellerId;
}

// ---- World: make sure there's enough land for every seeded builder ----
const GROW_MAX_STEPS = 20;

async function ensureLandAvailable(adminCookie, count) {
  for (let i = 0; i < GROW_MAX_STEPS; i++) {
    const { landlets } = await api(`/landlets?status=greenbelt&limit=${count}`, adminCookie);
    if (landlets.length >= count) return;
    const { landlets: generating } = await api('/landlets?status=generating&limit=1', adminCookie);
    if (generating.length > 0) {
      try {
        await api('/world/expand', adminCookie, { method: 'POST' });
        continue;
      } catch { /* ratio gate refused — fall through to generating more */ }
    }
    break;
  }
  const { landlets: stillGreenbelt } = await api(`/landlets?status=greenbelt&limit=${count}`, adminCookie);
  if (stillGreenbelt.length >= count) return;

  let world = await api('/world', adminCookie).then((r) => r.world);
  let innerRadiusM = world.radiusM;
  let ring = null;
  for (let attempt = 0; attempt < GROW_MAX_STEPS && !ring; attempt++) {
    const prefix = `mockup-ring-${Math.round(innerRadiusM)}-${Date.now().toString(36)}`;
    try {
      const generated = await api('/land-candidates/generate-ring', adminCookie, {
        method: 'POST',
        body: JSON.stringify({ prefix, count: 12, innerRadiusM }),
      });
      ring = { ringId: prefix, outerRadiusM: generated.outerRadiusM };
    } catch (err) {
      if (err.message.includes('Generated ring would overlap existing land candidates')) {
        innerRadiusM += world.expansionIncrementM;
      } else {
        throw err;
      }
    }
  }
  if (!ring) throw new Error('ensureLandAvailable: could not find clear room for a new ring');
  for (let i = 0; i < GROW_MAX_STEPS; i++) {
    world = await api('/world', adminCookie).then((r) => r.world);
    if (world.radiusM >= ring.outerRadiusM) break;
    await api('/world/expand', adminCookie, { method: 'POST' });
  }
  await api(`/land-candidate-rings/${ring.ringId}/generation-complete`, adminCookie, { method: 'POST' });
}

async function claim(account) {
  // Whatever's greenbelt right now — order doesn't matter, ensureLandAvailable
  // already guaranteed enough of it exists.
  const { landlets } = await api('/landlets?status=greenbelt&limit=1', account.cookie);
  if (landlets.length === 0) throw new Error(`claim: no greenbelt landlet available for ${account.label}`);
  const claimed = await api(`/landlets/${landlets[0].landletId}/claim`, account.cookie, { method: 'POST' });
  return claimed.landlet.landletId;
}

// ---- Catalog: upload the real models already in public/models/ ----
async function uploadModel(fileName) {
  const filePath = path.join(repoRoot, 'public', 'models', fileName);
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'model/gltf-binary' }), fileName);
  const response = await fetch(`${BASE_URL}/api/models`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(`upload ${fileName} -> ${response.status}: ${body.error}`);
  return body.modelUrl;
}

async function main() {
  console.log(`Seeding mockup data against ${BASE_URL} ...`);

  const admin = await makeAccount('Mockup Admin');
  const bootstrapped = await api('/auth/admin-bootstrap', admin.cookie, {
    method: 'POST',
    body: JSON.stringify({ secret: ADMIN_BOOTSTRAP_SECRET }),
  }).catch((err) => {
    throw new Error(`Admin bootstrap failed — is ADMIN_BOOTSTRAP_SECRET configured in .dev.vars to match "${ADMIN_BOOTSTRAP_SECRET}"? (${err.message})`);
  });
  console.log(`Admin ready: ${admin.email} (isAdmin: ${bootstrapped.user.isAdmin})`);

  const builderLabels = ['Ada Builder', 'Grace Homestead', 'Lin Carpenter'];
  const builders = [];
  for (const label of builderLabels) builders.push(await makeAccount(label));
  console.log(`Signed up ${builders.length} builder accounts.`);

  await ensureLandAvailable(admin.cookie, builders.length);
  for (const builder of builders) {
    builder.landletId = await claim(builder);
    console.log(`  ${builder.label} claimed ${builder.landletId}`);
  }

  const sellerAccount = builders[0]; // a builder can also sell — matches "quite apart from" but not exclusive
  const sellerId = await ensureSeller(sellerAccount);
  console.log(`Seller ready: ${sellerAccount.label} (${sellerId})`);

  const modelFiles = [
    'crate.glb', 'planter.glb', 'lamp.glb', 'table.glb', 'brick.glb', 'chair.glb', 'tree.glb',
    // Generated by scripts/generate-mockup-models.py — same procedural-
    // primitive style as the models above, just a wider variety to build
    // with (a fence for enclosing a plot, a bench, a mailbox, a bookshelf,
    // a rug).
    'fence.glb', 'bench.glb', 'mailbox.glb', 'bookshelf.glb', 'rug.glb',
  ];
  const modelUrls = {};
  for (const fileName of modelFiles) {
    modelUrls[fileName] = await uploadModel(fileName);
  }
  console.log(`Uploaded ${modelFiles.length} real models.`);

  const templateSpecs = [
    { key: 'crate.glb', name: 'Rustic Storage Crate', category: 'storage', color: '#d2691e', dimensions: { width: 1, depth: 1, height: 1 }, priceCents: 1899 },
    { key: 'planter.glb', name: 'Terracotta Planter', category: 'garden', color: '#8b5a2b', dimensions: { width: 0.6, depth: 0.6, height: 0.8 }, priceCents: 2450 },
    { key: 'lamp.glb', name: 'Warm Glow Floor Lamp', category: 'lighting', color: '#ffd166', dimensions: { width: 0.3, depth: 0.3, height: 1.6 }, priceCents: 4200 },
    {
      key: 'table.glb', name: 'Farmhouse Dining Table', category: 'furniture', subcategory: 'tables',
      color: '#795548', dimensions: { width: 1.4, depth: 0.8, height: 0.75 }, priceCents: 18900,
      metadata: { extensible: { x: { minM: 1.0 } } },
    },
    { key: 'brick.glb', name: 'Weathered Brick (single)', category: 'building-materials', color: '#a0522d', dimensions: { width: 0.2, depth: 0.095, height: 0.057 }, priceCents: 120, metadata: { flooring: true } },
    { key: 'chair.glb', name: 'Blue Bistro Chair', category: 'furniture', subcategory: 'seating', color: '#3366cc', dimensions: { width: 0.7, depth: 0.7, height: 1.0 }, priceCents: 6500 },
    { key: 'tree.glb', name: 'Potted Maple Sapling', category: 'garden', color: '#2f8f46', dimensions: { width: 1.5, depth: 1.5, height: 4.0 }, priceCents: 3200 },
    {
      key: 'fence.glb', name: 'Picket Fence Panel', category: 'building-materials', subcategory: 'fencing',
      color: '#a35c3d', dimensions: { width: 1.2, depth: 0.11, height: 1.1 }, priceCents: 2650,
    },
    {
      key: 'bench.glb', name: 'Garden Bench', category: 'furniture', subcategory: 'seating',
      color: '#4a6741', dimensions: { width: 1.2, depth: 0.5, height: 0.85 }, priceCents: 8900,
    },
    { key: 'mailbox.glb', name: 'Roadside Mailbox', category: 'garden', color: '#961d1d', dimensions: { width: 0.2, depth: 0.35, height: 1.2 }, priceCents: 3400 },
    {
      key: 'bookshelf.glb', name: 'Oak Bookshelf', category: 'furniture', subcategory: 'storage',
      color: '#654321', dimensions: { width: 0.9, depth: 0.3, height: 1.8 }, priceCents: 15900,
    },
    { key: 'rug.glb', name: 'Terracotta Area Rug', category: 'flooring', color: '#b03a2e', dimensions: { width: 2.0, depth: 1.4, height: 0.02 }, priceCents: 4500, metadata: { flooring: true } },
    // A couple of no-model entries too — plenty of real templates have none
    // (custom/placeholder uploads), and it's worth having sample data that
    // exercises that path as well as digital-goods/no-returns metadata.
    { key: null, name: 'Custom Landlet Blueprint (PDF)', category: 'digital', color: '#999999', dimensions: { width: 0.3, depth: 0.02, height: 0.4 }, priceCents: 500, metadata: { digitalGoodDisclaimer: 'art-file' } },
    { key: null, name: 'Clearance Patio Umbrella', category: 'garden', color: '#e07a5f', dimensions: { width: 2, depth: 2, height: 2.2 }, priceCents: 3999, metadata: { noReturns: true } },
  ];

  const templates = [];
  for (const spec of templateSpecs) {
    const { template } = await api('/catalog', sellerAccount.cookie, {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name,
        category: spec.category,
        subcategory: spec.subcategory,
        color: spec.color,
        dimensions: spec.dimensions,
        priceCents: spec.priceCents,
        sellerId,
        modelUrl: spec.key ? modelUrls[spec.key] : null,
        metadata: spec.metadata || {},
      }),
    });
    templates.push(template);
  }
  console.log(`Created ${templates.length} catalog templates.`);

  // ---- Place a handful of products on each builder's own land ----
  const byName = (name) => templates.find((t) => t.name === name);
  const placementsByLandlet = [
    [
      byName('Farmhouse Dining Table'), byName('Blue Bistro Chair'), byName('Warm Glow Floor Lamp'),
      byName('Oak Bookshelf'), byName('Terracotta Area Rug'),
    ],
    [
      byName('Terracotta Planter'), byName('Potted Maple Sapling'), byName('Rustic Storage Crate'),
      byName('Picket Fence Panel'), byName('Picket Fence Panel'), byName('Roadside Mailbox'),
    ],
    [byName('Clearance Patio Umbrella'), byName('Blue Bistro Chair'), byName('Garden Bench')],
  ];
  const placedInstances = [];
  for (let i = 0; i < builders.length; i++) {
    const builder = builders[i];
    const items = placementsByLandlet[i % placementsByLandlet.length];
    let x = -2;
    for (const template of items) {
      const { instance } = await api('/instances', builder.cookie, {
        method: 'POST',
        body: JSON.stringify({
          landletId: builder.landletId,
          templateId: template.templateId,
          x, y: 1, z: 0,
        }),
      });
      placedInstances.push({ instance, builder, template });
      x += 2;
    }
  }
  console.log(`Placed ${placedInstances.length} product instances across builders' land.`);

  // A community sign + calendar on the first builder's own land, so those
  // features have something to look at immediately too.
  const signInstance = placedInstances[0];
  await api(`/instances/${signInstance.instance.instanceId}`, signInstance.builder.cookie, {
    method: 'PATCH',
    body: JSON.stringify({ isCommunitySign: true, isCommunityCalendar: true }),
  });
  await api(`/instances/${signInstance.instance.instanceId}/posts`, null, {
    method: 'POST',
    body: JSON.stringify({ authorLabel: 'A Passerby', text: 'Love what you have done with this plot!' }),
  });
  await api(`/instances/${signInstance.instance.instanceId}/events`, null, {
    method: 'POST',
    body: JSON.stringify({ authorLabel: signInstance.builder.label, text: 'Housewarming this weekend — stop by!' }),
  });
  console.log('Flagged one instance as a community sign + calendar with sample posts.');

  // ---- A real notification — the only way one is ever created is a
  // seller changing a placed template's real-world dimensions, so trigger
  // that for real rather than trying to insert one directly.
  const crateInstance = placedInstances.find((p) => p.template.name === 'Rustic Storage Crate');
  await api(`/catalog/${crateInstance.template.templateId}`, sellerAccount.cookie, {
    method: 'PATCH',
    body: JSON.stringify({ dimensions: { width: 1.1, depth: 1.1, height: 1.1 } }),
  });
  console.log(`Resized "${crateInstance.template.name}" to notify ${crateInstance.builder.label}.`);

  // ---- Simulated purchases (one later refunded) + a review ----
  const chairInstance = placedInstances.find((p) => p.template.name === 'Blue Bistro Chair');
  await api(`/instances/${chairInstance.instance.instanceId}/purchase`, null, {
    method: 'POST',
    body: JSON.stringify({ quantity: 1, buyerLabel: 'Repeat Customer' }),
  });
  await api('/catalog/' + chairInstance.template.templateId + '/reviews', null, {
    method: 'POST',
    body: JSON.stringify({ authorLabel: 'Repeat Customer', rating: 5, text: 'Sturdy and looks great on the patio.' }),
  });
  const lampInstance = placedInstances.find((p) => p.template.name === 'Warm Glow Floor Lamp');
  const purchase2 = await api(`/instances/${lampInstance.instance.instanceId}/purchase`, null, {
    method: 'POST',
    body: JSON.stringify({ quantity: 1, buyerLabel: 'Returning It' }),
  });
  await api(`/purchases/${purchase2.purchase.purchaseId}/refund`, sellerAccount.cookie, { method: 'POST' });
  console.log('Simulated 2 purchases (1 refunded) and posted 1 product review.');

  // ---- Friendship between two builders ----
  const friendRequest = await api('/friendships', builders[0].cookie, {
    method: 'POST',
    body: JSON.stringify({ recipientBuilderId: builders[1].builderId }),
  });
  await api(`/friendships/${friendRequest.friendship.friendshipId}`, builders[1].cookie, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'accepted' }),
  });
  console.log(`${builders[0].label} and ${builders[1].label} are now friends.`);

  // ---- A shared bundle from the third builder ----
  await api('/bundles', builders[2].cookie, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Cozy Reading Corner',
      shared: true,
      items: [
        { templateId: byName('Warm Glow Floor Lamp').templateId, dx: -0.3, dy: 0, dz: 0, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 1 },
        { templateId: byName('Blue Bistro Chair').templateId, dx: 0.3, dy: 0, dz: 0, rotationX: 0, rotationY: 0, rotationZ: 0, crop: {}, scale: 1 },
      ],
    }),
  });
  console.log(`${builders[2].label} saved and shared a bundle: "Cozy Reading Corner".`);

  // ---- An active auction with a couple of bids ----
  const auctionSeller = builders[1];
  const bidder = builders[2];
  const { auction } = await api(`/landlets/${auctionSeller.landletId}/auction`, auctionSeller.cookie, {
    method: 'POST',
    body: JSON.stringify({ startingBidCents: 500, durationHours: 48 }),
  });
  await api(`/auctions/${auction.auctionId}/bids`, bidder.cookie, {
    method: 'POST',
    body: JSON.stringify({ amountCents: 500 }),
  });
  await api(`/auctions/${auction.auctionId}/bids`, admin.cookie, {
    method: 'POST',
    body: JSON.stringify({ amountCents: 750 }),
  });
  console.log(`${auctionSeller.label} started an auction on ${auctionSeller.landletId}, with 2 bids so far.`);

  // ---- Publish every builder's landlet ----
  // Placing an instance only ever edits a landlet's draft (placed_instances)
  // — Shop mode always renders whatever was last *published* there (see
  // docs/API.md's "Landlet drafts"/"Landlet versions" and the Publish
  // button in Build mode's own Settings panel), same as any real site
  // builder's draft-vs-live distinction. Without this, every plot built up
  // above would still show as empty/unclaimed-looking to anyone exploring
  // in Shop mode, defeating the point of a "realistic mockup dataset."
  for (const builder of builders) {
    const { version } = await api(`/landlets/${builder.landletId}/versions`, builder.cookie, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await api(`/landlets/${builder.landletId}/versions/${version.versionId}/activate`, builder.cookie, { method: 'POST' });
  }
  console.log(`Published every builder's landlet so their builds actually show up in Shop mode.`);

  console.log('\n=== Mockup data ready ===');
  console.log(`Admin:    ${admin.email} / ${PASSWORD}`);
  for (const builder of builders) console.log(`Builder:  ${builder.email} / ${PASSWORD}  (landlet ${builder.landletId})`);
  console.log(`\nLog in as any of the above at ${BASE_URL} to explore.`);
}

main().catch((err) => {
  console.error('\nSeeding failed:', err.message);
  process.exit(1);
});
