import {
  landletMaxWorldRadius, landletMinWorldRadius, landletWorldPolygon, pointInPolygon, polygonsOverlap,
} from './geometry.js';
import { generateLandletRing, powerLawPlots } from './landGenerator.js';
import { generateOrganicMosaic } from './organicLandGenerator.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// Real-time web/mobile products should be tiny — see catalog.js's own
// comments and the size guidance given when this endpoint was built.
// 20MB is a generous ceiling above that guidance (most uploads should land
// well under 2MB), not a target: it exists to reject an accidentally-huge
// raw photogrammetry export before it ever reaches R2, not to encourage
// files anywhere near it.
const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67; // ascii "glTF", little-endian uint32
const GLB_VERSION = 2;
const GLB_JSON_CHUNK = 0x4e4f534a;

// R2's free tier is 10GB of storage per month. This is our OWN
// application-level backstop well under that — checked live against R2's
// actual current contents on every upload — so a new upload gets rejected
// before it would ever push real usage into paid territory, independent
// of whatever Cloudflare's own billing dashboard does or doesn't warn
// about. Only counts what's actually in R2 (this bucket only ever holds
// builder-uploaded custom models — the built-in catalog's models ship as
// static assets, not R2 objects, so they never count against this).
const MAX_TOTAL_STORAGE_BYTES = 8 * 1024 * 1024 * 1024;

async function getStorageUsage(bucket) {
  let usedBytes = 0;
  let objectCount = 0;
  let cursor;
  do {
    const listing = await bucket.list({ cursor, limit: 1000 });
    for (const object of listing.objects) usedBytes += object.size;
    objectCount += listing.objects.length;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return { usedBytes, objectCount };
}

// Private-preview gate: when ACCESS_PASSPHRASE is configured (a Worker
// secret, never committed), every request — pages, the API, uploaded
// assets, all of it — is blocked until a signed cookie proves the visitor
// submitted the right passphrase. Unset (the default for local dev and the
// test suite, which never configure it) means the gate is skipped
// entirely, so nothing here changes behavior until a deployment actually
// opts in. This is a shared-passphrase gate, not real per-person accounts
// — good enough for "let a few friends see what I'm building," not a
// substitute for real auth if this ever needs individual identities.
const ACCESS_COOKIE_NAME = 'hh_access';
// Founding/pioneer recognition (docs/SPEC.md §3, migrations/0044) — how
// many of the earliest landlet-claimers make up the founding cohort.
// Deliberately a plain constant, not configurable world_settings state:
// this is a one-time-per-world creative decision ("how big is the
// founding hundred"), not something a builder or the running world ever
// needs to tune live. Chosen size: a "founding hundred" is a common,
// legible round-number convention for this kind of recognition — sized
// for real early-adopter breadth without diluting into "everyone."
const PIONEER_COHORT_SIZE = 100;

async function computeAccessToken(passphrase) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('higglehaven-access-granted'));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Not a security-critical timing defense here (this gates a handful of
// friends, not a real adversary) — just cheap enough to use everywhere a
// secret gets compared instead of reaching for `===` in some spots and not
// others.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

function accessLoginPage(errorMessage) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>higglehaven</title>
<style>
  html, body { margin: 0; height: 100%; background: #eef4e0; display: flex; align-items: center; justify-content: center; font: 15px/1.5 sans-serif; }
  form { background: rgb(250 240 199 / 0.97); padding: 28px 26px; border-radius: 14px; width: 100%; max-width: 320px; box-sizing: border-box; color: #16240a; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; font-size: 13px; color: rgb(22 36 10 / 0.7); }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid rgb(22 36 10 / 0.25); background: rgb(22 36 10 / 0.08); color: #16240a; font: 15px/1.4 sans-serif; margin-bottom: 12px; }
  button { width: 100%; padding: 10px; border-radius: 999px; border: none; background: #6ca42e; color: #16240a; font: 15px/1.4 sans-serif; }
  .error { color: #b3402c; font-size: 13px; margin: -6px 0 12px; }
</style>
</head>
<body>
<form method="POST" action="/__access/login">
  <h1>higglehaven</h1>
  <p>This is a private preview. Enter the passphrase to continue.</p>
  ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
  <input type="password" name="passphrase" placeholder="Passphrase" autofocus />
  <button type="submit">Enter</button>
</form>
</body>
</html>`;
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// Returns a Response to short-circuit the request (unauthorized, or a
// freshly-granted redirect), or null to let the real routing below handle
// it — the passphrase check passed.
async function checkAccessGate(request, url, env) {
  if (url.pathname === '/__access/login' && request.method === 'POST') {
    const form = await request.formData();
    const submitted = String(form.get('passphrase') || '');
    if (!timingSafeEqual(submitted, env.ACCESS_PASSPHRASE)) {
      return htmlResponse(accessLoginPage('Incorrect passphrase.'), 401);
    }
    const token = await computeAccessToken(env.ACCESS_PASSPHRASE);
    const cookieAttrs = [`${ACCESS_COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000'];
    // Secure requires HTTPS — omitted for plain-http local dev (wrangler
    // dev) so testing this doesn't require standing up TLS locally; real
    // deployments are always HTTPS, so production visitors still get it.
    if (url.protocol === 'https:') cookieAttrs.push('Secure');
    return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': cookieAttrs.join('; ') } });
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[ACCESS_COOKIE_NAME];
  if (token && timingSafeEqual(token, await computeAccessToken(env.ACCESS_PASSPHRASE))) {
    return null; // valid session — proceed to normal routing
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return htmlResponse(accessLoginPage(null), 401);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'www.higglehaven.com') {
      url.hostname = 'higglehaven.com';
      return Response.redirect(url.toString(), 301);
    }

    if (env.ACCESS_PASSPHRASE) {
      const gateResponse = await checkAccessGate(request, url, env);
      if (gateResponse) return gateResponse;
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url).catch((error) => {
        const httpError = error instanceof HttpError ? error : databaseHttpError(error);
        if (httpError) return json({ error: httpError.message }, httpError.status);
        console.error(error);
        return json({ error: 'Internal server error' }, 500);
      });
    }

    // Uploaded/imported model files live in R2, not the static ASSETS
    // bundle (which only has whatever shipped with the build) — served
    // from their own path prefix so they never collide with the built-in
    // models under /models/.
    if (url.pathname.startsWith('/uploads/')) {
      return handleUploadedAsset(request, env).catch((error) => {
        console.error(error);
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        return json({ error: 'Internal server error' }, 500);
      });
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleUploadedAsset(request, env) {
  if (!env.MODELS) return json({ error: 'R2 binding MODELS is not configured' }, 500);
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, DELETE' } });
  }

  let key;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/uploads\//, ''));
  } catch {
    throw new HttpError('Invalid upload path encoding', 400);
  }
  if (!key) throw new HttpError('Uploaded model key is required', 400);

  if (request.method === 'DELETE') {
    if (!env.DB) throw new HttpError('D1 binding DB is not configured', 500);
    const modelUrl = `/uploads/${key}`;
    const referenced = await env.DB.prepare(`
      SELECT template_id FROM catalog_templates WHERE model_url = ? LIMIT 1
    `).bind(modelUrl).first();
    if (referenced) throw new HttpError('Uploaded model is still referenced by a catalog template', 409);
    const existing = await env.MODELS.head(key);
    if (!existing) return json({ error: 'Not found' }, 404);
    await env.MODELS.delete(key);
    return json({ deleted: true });
  }

  const conditionalRequest = request.method === 'HEAD' || request.headers.has('if-none-match');
  let object = conditionalRequest ? await env.MODELS.head(key) : await env.MODELS.get(key);
  if (!object) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('access-control-allow-origin', '*');
  // Uploaded files are content-addressed (SHA-256 key, never overwritten in
  // place — see handleModelUpload) and never change once
  // stored, so a long-lived cache is always safe.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  if (request.headers.get('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });

  // A metadata lookup was enough to answer a matching conditional request.
  // Fetch the body only when a stale conditional GET actually needs it.
  if (!('body' in object)) {
    object = await env.MODELS.get(key);
    if (!object) return json({ error: 'Not found' }, 404);
  }
  return new Response(object.body, { headers });
}

async function handleApi(request, env, url) {
  if (!env.DB) {
    return json({ error: 'D1 binding DB is not configured' }, 500);
  }

  const route = routePath(url.pathname);

  if (request.method === 'GET' && route.length === 1 && route[0] === 'health') {
    return json({ ok: true, service: 'higglehaven-api' });
  }

  if (route[0] === 'builders') {
    return handleBuilders(request, env.DB, route);
  }

  if (route[0] === 'sellers') {
    return handleSellers(request, env.DB, route);
  }

  if (route[0] === 'notifications') {
    return handleNotifications(request, env.DB, route, url);
  }

  if (route[0] === 'friendships') {
    return handleFriendships(request, env.DB, route, url);
  }

  if (route[0] === 'purchases') {
    return handlePurchases(request, env.DB, route, url);
  }

  if (route[0] === 'bundles') {
    return handleBundles(request, env.DB, route, url);
  }

  if (route[0] === 'auctions') {
    return handleAuctions(request, env.DB, route, url);
  }

  if (route[0] === 'catalog') {
    return handleCatalog(request, env.DB, route, url, env.MODELS);
  }

  if (route[0] === 'landlets') {
    return handleLandlets(request, env.DB, route, url);
  }

  if (route[0] === 'land-candidates') {
    return handleLandCandidates(request, env.DB, route, url);
  }

  if (route[0] === 'land-candidate-rings') {
    return handleLandCandidateRings(request, env.DB, route, url);
  }

  if (route[0] === 'world') {
    return handleWorld(request, env.DB, route);
  }

  if (route[0] === 'instances') {
    return handleInstances(request, env.DB, route, url);
  }

  if (route[0] === 'models' && route.length === 1) {
    if (request.method === 'POST') return handleModelUpload(request, env);
    if (request.method === 'GET') return handleModelListing(env, url);
  }
  if (request.method === 'GET' && route[0] === 'models' && route.length === 2 && route[1] === 'storage') {
    return handleModelStorage(env);
  }
  if (request.method === 'POST' && route[0] === 'models' && route.length === 2 && route[1] === 'cleanup') {
    return handleModelCleanup(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

// Accepts a model file as a direct multipart/form-data upload (a "file"
// field). This only ever returns a modelUrl; creating the actual
// catalog_templates row referencing it is a separate POST /api/catalog
// call (unchanged), keeping "get bytes into storage" and "register a
// product" as two independent steps.
//
// A URL-import mode (the Worker fetching a link server-side) used to live
// here too, dropped for now: in practice it was hard to get a plain,
// directly-fetchable file link out of consumer cloud/share tools, and that
// path can't benefit from the client-side model optimization pipeline
// (src/modelOptimizer.js) since the browser never sees the bytes. It was
// also an open server-side-request-forgery surface — this endpoint has no
// auth, so anyone could have asked the Worker to fetch arbitrary URLs on
// its behalf.
async function handleModelUpload(request, env) {
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new HttpError('Expected multipart/form-data', 415);
  }

  const form = await request.formData().catch(() => {
    throw new HttpError('Request body is not valid multipart/form-data', 400);
  });
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new HttpError('Expected a "file" field in the form data', 400);
  }
  if (file.size > MAX_MODEL_BYTES) {
    throw new HttpError(`File is ${formatBytes(file.size)}, over the ${formatBytes(MAX_MODEL_BYTES)} limit`, 413);
  }
  const bytes = await file.arrayBuffer();
  validateGlb(bytes);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `models/${hash}.glb`;
  const existing = await env.MODELS.head(key);
  if (existing) {
    return json({
      modelUrl: `/uploads/${key}`,
      sourceName: file.name || 'model.glb',
      sizeBytes: existing.size,
      deduplicated: true,
    });
  }

  const usage = await getStorageUsage(env.MODELS);
  const remainingBudget = MAX_TOTAL_STORAGE_BYTES - usage.usedBytes;
  if (file.size > remainingBudget) {
    throw new HttpError(
      `File is ${formatBytes(file.size)}, but only ${formatBytes(Math.max(remainingBudget, 0))} of storage headroom is left (${formatBytes(MAX_TOTAL_STORAGE_BYTES)} total cap)`,
      507,
    );
  }

  await env.MODELS.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
  return json({
    modelUrl: `/uploads/${key}`,
    sourceName: file.name || 'model.glb',
    sizeBytes: bytes.byteLength,
    deduplicated: false,
  }, 201);
}

async function handleModelListing(env, url) {
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);
  const limit = queryLimit(url.searchParams.get('limit'), 100);
  const cursorParam = url.searchParams.get('cursor');
  const cursor = cursorParam === null ? undefined : stringValue(cursorParam, 'cursor');
  const listing = await env.MODELS.list({ limit, cursor });
  const modelUrls = listing.objects.map((object) => `/uploads/${object.key}`);
  const references = new Map(modelUrls.map((modelUrl) => [modelUrl, []]));
  if (modelUrls.length > 0) {
    const placeholders = modelUrls.map(() => '?').join(', ');
    const referenced = await env.DB.prepare(`
      SELECT template_id, model_url FROM catalog_templates
      WHERE model_url IN (${placeholders}) ORDER BY template_id
    `).bind(...modelUrls).all();
    for (const row of referenced.results) references.get(row.model_url).push(row.template_id);
  }
  return json({
    models: listing.objects.map((object) => {
      const modelUrl = `/uploads/${object.key}`;
      const referencedByTemplateIds = references.get(modelUrl);
      return {
        modelUrl,
        sizeBytes: object.size,
        etag: object.httpEtag,
        uploadedAt: object.uploaded?.toISOString() || null,
        referencedByTemplateIds,
        deletable: referencedByTemplateIds.length === 0,
      };
    }),
    nextCursor: listing.truncated ? listing.cursor : null,
  });
}

async function handleModelStorage(env) {
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);
  const usage = await getStorageUsage(env.MODELS);
  return json({
    ...usage,
    capBytes: MAX_TOTAL_STORAGE_BYTES,
    availableBytes: Math.max(0, MAX_TOTAL_STORAGE_BYTES - usage.usedBytes),
    utilizationRatio: usage.usedBytes / MAX_TOTAL_STORAGE_BYTES,
  });
}

async function handleModelCleanup(request, env) {
  if (!env.MODELS) throw new HttpError('R2 binding MODELS is not configured', 500);
  const input = await readJson(request);
  const maxDeletes = positiveInteger(input.maxDeletes ?? 100, 'maxDeletes');
  if (maxDeletes > 100) throw new HttpError('maxDeletes must be at most 100', 400);
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
    throw new HttpError('dryRun must be a boolean', 400);
  }
  const dryRun = input.dryRun || false;

  const targets = [];
  let cursor;
  let completeScan = false;
  do {
    const listing = await env.MODELS.list({ cursor, limit: 100 });
    const modelUrls = listing.objects.map((object) => `/uploads/${object.key}`);
    const referencedUrls = new Set();
    if (modelUrls.length > 0) {
      const placeholders = modelUrls.map(() => '?').join(', ');
      const referenced = await env.DB.prepare(`
        SELECT DISTINCT model_url FROM catalog_templates WHERE model_url IN (${placeholders})
      `).bind(...modelUrls).all();
      for (const row of referenced.results) referencedUrls.add(row.model_url);
    }
    for (const object of listing.objects) {
      if (!referencedUrls.has(`/uploads/${object.key}`)) targets.push(object);
      if (targets.length === maxDeletes) break;
    }
    completeScan = !listing.truncated;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (!completeScan && targets.length < maxDeletes);

  if (!dryRun && targets.length > 0) await env.MODELS.delete(targets.map((object) => object.key));
  return json({
    targetModelUrls: targets.map((object) => `/uploads/${object.key}`),
    targetCount: targets.length,
    reclaimedBytes: targets.reduce((sum, object) => sum + object.size, 0),
    completeScan,
    dryRun,
  });
}

function validateGlb(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new HttpError('File is not a valid .glb (binary glTF) model', 400);
  }
  if (view.getUint32(4, true) !== GLB_VERSION) {
    throw new HttpError('Only glTF 2.0 .glb models are supported', 400);
  }
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw new HttpError('GLB header length does not match the uploaded file', 400);
  }

  let offset = 12;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new HttpError('GLB contains a truncated chunk header', 400);
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkEnd = offset + 8 + chunkLength;
    if (chunkLength % 4 !== 0 || chunkEnd > bytes.byteLength) {
      throw new HttpError('GLB contains an invalid chunk length', 400);
    }
    if (chunkIndex === 0) {
      if (chunkType !== GLB_JSON_CHUNK) throw new HttpError('GLB must begin with a JSON chunk', 400);
      try {
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, offset + 8, chunkLength)).trimEnd());
      } catch {
        throw new HttpError('GLB contains invalid JSON metadata', 400);
      }
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

async function handleCatalog(request, db, route, url, models) {
  if (request.method === 'DELETE' && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.templateIds)) throw new HttpError('templateIds must be an array', 400);
    if (input.templateIds.length === 0) throw new HttpError('templateIds must contain at least one item', 400);
    if (input.templateIds.length > 100) throw new HttpError('templateIds must contain at most 100 items', 400);
    const templateIds = input.templateIds.map((id) => stringValue(id, 'templateIds item'));
    if (new Set(templateIds).size !== templateIds.length) throw new HttpError('templateIds must be unique', 400);
    const placeholders = templateIds.map(() => '?').join(', ');
    const existing = await db.prepare(`
      SELECT template_id FROM catalog_templates WHERE template_id IN (${placeholders})
    `).bind(...templateIds).all();
    if (existing.results.length !== templateIds.length) {
      throw new HttpError('Every templateId must reference an existing catalog template', 404);
    }
    await db.batch(templateIds.map((templateId) => db.prepare(
      'DELETE FROM catalog_templates WHERE template_id = ?',
    ).bind(templateId)));
    return json({ deletedTemplateIds: templateIds });
  }

  if ((request.method === 'POST' || request.method === 'PUT') && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.templates)) throw new HttpError('templates must be an array', 400);
    if (input.templates.length === 0) throw new HttpError('templates must contain at least one item', 400);
    if (input.templates.length > 100) throw new HttpError('templates must contain at most 100 items', 400);
    const templates = input.templates.map((template) => validateTemplate(template, crypto.randomUUID()));
    const ids = new Set();
    for (const template of templates) {
      if (ids.has(template.templateId)) throw new HttpError('templateId values must be unique', 400);
      ids.add(template.templateId);
    }
    const sellerIds = templates.map((template) => template.sellerId).filter((id) => id);
    if (sellerIds.length > 0) await assertReferencesExist(db, 'sellers', 'seller_id', sellerIds, 'sellerId');
    await Promise.all(templates.map((template) => assertUploadedModelExists(models, template.modelUrl)));
    const conflictClause = request.method === 'PUT' ? `
      ON CONFLICT(template_id) DO UPDATE SET
        name = excluded.name, category = excluded.category, subcategory = excluded.subcategory,
        color = excluded.color, width_m = excluded.width_m, depth_m = excluded.depth_m,
        height_m = excluded.height_m, price_cents = excluded.price_cents,
        seller_id = excluded.seller_id, model_url = excluded.model_url,
        metadata_json = excluded.metadata_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ` : '';
    await db.batch(templates.map((template) => db.prepare(`
      INSERT INTO catalog_templates
        (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, model_url, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
    `).bind(...templateParams(template))));
    const placeholders = templates.map(() => '?').join(', ');
    const stored = await db.prepare(`
      SELECT * FROM catalog_templates WHERE template_id IN (${placeholders})
    `).bind(...ids).all();
    const byId = new Map(stored.results.map((row) => [row.template_id, templateFromRow(row)]));
    return json({ templates: templates.map((template) => byId.get(template.templateId)) }, request.method === 'POST' ? 201 : 200);
  }

  if (request.method === 'GET' && route.length === 1) {
    const categoryParam = url.searchParams.get('category');
    const category = categoryParam === null ? null : stringValue(categoryParam, 'category');
    const subcategoryParam = url.searchParams.get('subcategory');
    const subcategory = subcategoryParam === null ? null : stringValue(subcategoryParam, 'subcategory');
    const sellerIdParam = url.searchParams.get('sellerId');
    const sellerId = sellerIdParam === null ? null : stringValue(sellerIdParam, 'sellerId');
    const colorParam = url.searchParams.get('color');
    const color = colorParam === null ? null : stringValue(colorParam, 'color');
    const minPriceCents = queryNonnegativeInteger(url.searchParams.get('minPriceCents'), 'minPriceCents');
    const maxPriceCents = queryNonnegativeInteger(url.searchParams.get('maxPriceCents'), 'maxPriceCents');
    if (minPriceCents !== null && maxPriceCents !== null && minPriceCents > maxPriceCents) {
      throw new HttpError('minPriceCents cannot exceed maxPriceCents', 400);
    }
    const minWidthM = queryPositiveNumber(url.searchParams.get('minWidthM'), 'minWidthM');
    const maxWidthM = queryPositiveNumber(url.searchParams.get('maxWidthM'), 'maxWidthM');
    const minDepthM = queryPositiveNumber(url.searchParams.get('minDepthM'), 'minDepthM');
    const maxDepthM = queryPositiveNumber(url.searchParams.get('maxDepthM'), 'maxDepthM');
    const minHeightM = queryPositiveNumber(url.searchParams.get('minHeightM'), 'minHeightM');
    const maxHeightM = queryPositiveNumber(url.searchParams.get('maxHeightM'), 'maxHeightM');
    for (const [minimum, maximum, minimumField, maximumField] of [
      [minWidthM, maxWidthM, 'minWidthM', 'maxWidthM'],
      [minDepthM, maxDepthM, 'minDepthM', 'maxDepthM'],
      [minHeightM, maxHeightM, 'minHeightM', 'maxHeightM'],
    ]) {
      if (minimum !== null && maximum !== null && minimum > maximum) {
        throw new HttpError(`${minimumField} cannot exceed ${maximumField}`, 400);
      }
    }
    const queryParam = url.searchParams.get('q');
    const query = queryParam === null ? null : stringValue(queryParam, 'q');
    if (query && query.length > 100) throw new HttpError('q must be at most 100 characters', 400);
    const sort = url.searchParams.get('sort') || 'name';
    if (!['name', 'price-asc', 'price-desc'].includes(sort)) {
      throw new HttpError('sort must be name, price-asc, or price-desc', 400);
    }
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = sort === 'name'
      ? decodeCatalogCursor(url.searchParams.get('cursor'))
      : decodeCatalogPriceCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    if (category) {
      conditions.push('category = ?');
      bindings.push(category);
    }
    if (subcategory) {
      conditions.push('subcategory = ?');
      bindings.push(subcategory);
    }
    if (sellerId) {
      conditions.push('seller_id = ?');
      bindings.push(sellerId);
    }
    if (color) {
      conditions.push('color = ?');
      bindings.push(color);
    }
    if (minPriceCents !== null) {
      conditions.push('price_cents >= ?');
      bindings.push(minPriceCents);
    }
    if (maxPriceCents !== null) {
      conditions.push('price_cents <= ?');
      bindings.push(maxPriceCents);
    }
    if (minWidthM !== null) {
      conditions.push('width_m >= ?');
      bindings.push(minWidthM);
    }
    if (maxWidthM !== null) {
      conditions.push('width_m <= ?');
      bindings.push(maxWidthM);
    }
    if (minDepthM !== null) {
      conditions.push('depth_m >= ?');
      bindings.push(minDepthM);
    }
    if (maxDepthM !== null) {
      conditions.push('depth_m <= ?');
      bindings.push(maxDepthM);
    }
    if (minHeightM !== null) {
      conditions.push('height_m >= ?');
      bindings.push(minHeightM);
    }
    if (maxHeightM !== null) {
      conditions.push('height_m <= ?');
      bindings.push(maxHeightM);
    }
    if (query) {
      conditions.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
      bindings.push(`%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    }
    if (sort !== 'name') conditions.push('price_cents IS NOT NULL');
    if (cursor && sort === 'name') {
      conditions.push('(name > ? OR (name = ? AND template_id > ?))');
      bindings.push(cursor.name, cursor.name, cursor.templateId);
    } else if (cursor) {
      const comparison = sort === 'price-asc' ? '>' : '<';
      conditions.push(`(price_cents ${comparison} ? OR (price_cents = ? AND template_id > ?))`);
      bindings.push(cursor.priceCents, cursor.priceCents, cursor.templateId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = sort === 'name'
      ? 'name, template_id'
      : `price_cents ${sort === 'price-asc' ? 'ASC' : 'DESC'}, template_id`;
    const { results } = await db.prepare(`
      SELECT * FROM catalog_templates ${where}
      ORDER BY ${order} LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      templates: page.map(templateFromRow),
      nextCursor: hasMore
        ? (sort === 'name'
          ? encodeCatalogCursor(last.name, last.template_id)
          : encodeCatalogPriceCursor(last.price_cents, last.template_id))
        : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    return row ? json({ template: templateFromRow(row) }) : json({ error: 'Catalog template not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const template = validateTemplate(input, crypto.randomUUID());
    if (template.sellerId) await assertReferenceExists(db, 'sellers', 'seller_id', template.sellerId, 'sellerId');
    await assertUploadedModelExists(models, template.modelUrl);
    await db.prepare(`
      INSERT INTO catalog_templates
        (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, seller_id, model_url, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...templateParams(template)).run();
    return json({ template }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Catalog template not found' }, 404);
    const input = await readJson(request);
    const template = validateTemplate({ ...templateFromRow(existing), ...input, templateId: route[1] }, route[1]);
    if (template.sellerId) await assertReferenceExists(db, 'sellers', 'seller_id', template.sellerId, 'sellerId');
    await assertUploadedModelExists(models, template.modelUrl);
    await db.prepare(`
      UPDATE catalog_templates
      SET name = ?, category = ?, subcategory = ?, color = ?, width_m = ?, depth_m = ?, height_m = ?,
          price_cents = ?, seller_id = ?, model_url = ?, metadata_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ?
    `).bind(template.name, template.category, template.subcategory, template.color, template.dimensions.width, template.dimensions.depth, template.dimensions.height, template.priceCents, template.sellerId, template.modelUrl, JSON.stringify(template.metadata), route[1]).run();
    await notifyBuildersOfDimensionChange(db, template, {
      width: existing.width_m,
      depth: existing.depth_m,
      height: existing.height_m,
    });
    return json({ template });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await db.prepare('DELETE FROM catalog_templates WHERE template_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  if (route.length >= 3 && route[2] === 'reviews') {
    return handleProductReviews(request, db, route);
  }

  return json({ error: 'Not found' }, 404);
}

// Reviews on a catalog template (docs/SPEC.md §5's "Review incentives,"
// docs/API.md's "Product reviews," migrations/0048) — nested under
// /catalog/:templateId/reviews rather than a top-level /product-reviews
// collection, same "never exists independent of its parent" reasoning as
// sign posts/calendar events. Attached to the *template* (the product
// itself), not to any one placed instance of it — see migrations/0048's own
// comment for why 0047's original instance-level design was wrong. No
// opt-in flag: every catalog template is already product-like by
// definition, so every one is reviewable, and no ownership check on DELETE
// (moderation) — same no-real-auth caveat as every other dev-mode identity
// in this file.
async function handleProductReviews(request, db, route) {
  const templateId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const template = await db.prepare('SELECT template_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    if (!template) return json({ error: 'Catalog template not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM product_reviews WHERE template_id = ? ORDER BY created_at LIMIT 200
    `).bind(templateId).all();
    const reviews = results.map(reviewFromRow);
    const averageRating = reviews.length === 0
      ? null
      : reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length;
    return json({ reviews, averageRating, count: reviews.length });
  }

  if (request.method === 'POST' && route.length === 3) {
    const template = await db.prepare('SELECT template_id FROM catalog_templates WHERE template_id = ?').bind(templateId).first();
    if (!template) return json({ error: 'Catalog template not found' }, 404);
    const input = await readJson(request);
    const authorLabel = stringValue(input.authorLabel, 'authorLabel');
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new HttpError('rating must be an integer from 1 to 5', 400);
    }
    const text = input.text === undefined || input.text === null || input.text === ''
      ? null
      : stringValue(input.text, 'text');
    if (text && text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    const reviewId = `review-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO product_reviews (review_id, template_id, author_label, rating, text) VALUES (?, ?, ?, ?, ?)
    `).bind(reviewId, templateId, authorLabel, rating, text).run();
    const row = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ?').bind(reviewId).first();
    return json({ review: reviewFromRow(row) }, 201);
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const reviewId = route[3];
    const existing = await db.prepare('SELECT * FROM product_reviews WHERE review_id = ? AND template_id = ?').bind(reviewId, templateId).first();
    if (!existing) return json({ error: 'Review not found' }, 404);
    await db.prepare('DELETE FROM product_reviews WHERE review_id = ?').bind(reviewId).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

function reviewFromRow(row) {
  return {
    reviewId: row.review_id,
    templateId: row.template_id,
    authorLabel: row.author_label,
    rating: row.rating,
    text: row.text,
    createdAt: row.created_at,
  };
}

// A seller changing a product's real-world size after it's already been
// placed somewhere leaves every existing instance still looking like the
// old size (createMeshForInstance never re-scales an already-placed
// mesh) — silently wrong until a builder happens to re-open that
// landlet. Rather than try to auto-fix placements the seller never
// touched, this just tells every builder who has one so they can decide
// what to do about it themselves.
async function notifyBuildersOfDimensionChange(db, template, oldDimensions) {
  const { width, depth, height } = template.dimensions;
  const changed = Math.abs(width - oldDimensions.width) > 1e-4 ||
    Math.abs(depth - oldDimensions.depth) > 1e-4 ||
    Math.abs(height - oldDimensions.height) > 1e-4;
  if (!changed) return;

  const { results } = await db.prepare(`
    SELECT DISTINCT l.owner_builder_id AS builderId
    FROM placed_instances pi
    JOIN landlets l ON l.landlet_id = pi.landlet_id
    WHERE pi.template_id = ? AND l.owner_builder_id IS NOT NULL
  `).bind(template.templateId).all();
  if (results.length === 0) return;

  const fmt = (m) => `${m.toFixed(2)}m`;
  const message = `"${template.name}" was resized by its seller to ${fmt(width)} x ${fmt(depth)} x ${fmt(height)} — you have one placed. Check that it still fits where you put it.`;
  await db.batch(results.map((row) => db.prepare(
    'INSERT INTO notifications (notification_id, builder_id, message, template_id) VALUES (?, ?, ?, ?)',
  ).bind(`notification-${crypto.randomUUID()}`, row.builderId, message, template.templateId)));
}

async function assertUploadedModelExists(bucket, modelUrl) {
  if (!modelUrl?.startsWith('/uploads/')) return;
  if (!bucket) throw new HttpError('R2 binding MODELS is not configured', 500);
  let key;
  try {
    key = decodeURIComponent(modelUrl.slice('/uploads/'.length));
  } catch {
    throw new HttpError('modelUrl contains invalid upload path encoding', 400);
  }
  if (!key || !(await bucket.head(key))) {
    throw new HttpError('modelUrl does not reference an existing uploaded model', 400);
  }
}

async function handleLandletVersions(request, db, route, url) {
  const landletId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    await requireLandlet(db, landletId);
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeVersionCursor(url.searchParams.get('cursor'));
    const cursorCondition = cursor === null ? '' : 'AND v.version_number < ?';
    const bindings = cursor === null ? [landletId, limit + 1] : [landletId, cursor, limit + 1];
    const { results } = await db.prepare(`
      SELECT v.*, COUNT(i.source_instance_id) AS instance_count
      FROM landlet_versions v
      LEFT JOIN version_instances i ON i.version_id = v.version_id
      WHERE v.landlet_id = ? ${cursorCondition}
      GROUP BY v.version_id
      ORDER BY v.version_number DESC
      LIMIT ?
    `).bind(...bindings).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    return json({
      versions: page.map(versionFromRow),
      nextCursor: hasMore ? encodeVersionCursor(page.at(-1).version_number) : null,
    });
  }

  if (request.method === 'POST' && route.length === 3) {
    await requireLandlet(db, landletId);
    const input = await readJson(request);
    const versionId = crypto.randomUUID();
    const name = input.name === undefined ? null : stringValue(input.name, 'name');
    const metadata = input.metadata || {};
    JSON.stringify(metadata);

    await db.batch([
      db.prepare(`
        INSERT INTO landlet_versions (version_id, landlet_id, version_number, name, metadata_json)
        SELECT ?, ?, next_version_number,
               COALESCE(?, 'Version ' || next_version_number), ?
        FROM (
          SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number
          FROM landlet_versions WHERE landlet_id = ?
        )
      `).bind(versionId, landletId, name, JSON.stringify(metadata), landletId),
      db.prepare(`
        INSERT INTO version_instances
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale)
        SELECT ?, instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale
        FROM placed_instances WHERE landlet_id = ?
      `).bind(versionId, landletId),
    ]);

    const version = await getVersion(db, landletId, versionId);
    return json({ version }, 201);
  }

  if (request.method === 'GET' && route.length === 4) {
    const version = await getVersion(db, landletId, route[3]);
    if (!version) return json({ error: 'Landlet version not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM version_instances WHERE version_id = ? ORDER BY source_instance_id
    `).bind(route[3]).all();
    return json({ version: { ...version, instances: results.map(versionInstanceFromRow) } });
  }

  if (request.method === 'POST' && route.length === 5 && route[4] === 'activate') {
    await requireLandlet(db, landletId);
    const version = await getVersion(db, landletId, route[3]);
    if (!version) return json({ error: 'Landlet version not found' }, 404);
    await db.prepare(`
      UPDATE landlets SET active_version_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ?
    `).bind(route[3], landletId).run();
    const landlet = await requireLandlet(db, landletId);
    return json({ landlet: landletFromRow(landlet), version });
  }

  return json({ error: 'Not found' }, 404);
}

async function requireLandlet(db, landletId) {
  const row = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(landletId).first();
  if (!row) throw new HttpError('Landlet not found', 404);
  return row;
}

async function getVersion(db, landletId, versionId) {
  const row = await db.prepare(`
    SELECT v.*, COUNT(i.source_instance_id) AS instance_count
    FROM landlet_versions v
    LEFT JOIN version_instances i ON i.version_id = v.version_id
    WHERE v.landlet_id = ? AND v.version_id = ?
    GROUP BY v.version_id
  `).bind(landletId, versionId).first();
  return row ? versionFromRow(row) : null;
}

async function handleBuilders(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    const { results } = await db.prepare('SELECT * FROM builders ORDER BY created_at, builder_id').all();
    // Land cap (docs/SPEC.md §3) is recomputed lazily here, on every list
    // read, rather than on a schedule — the same pattern this app uses
    // everywhere else. Mutating each row in place with the freshly
    // recomputed value avoids a second round-trip re-fetch.
    await Promise.all(results.map(async (row) => {
      row.land_cap_m2 = await recomputeLandCap(db, row.builder_id);
    }));
    return json({ builders: results.map(builderFromRow) });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const label = stringValue(input.label, 'label');
    // Server-generated by default so two devices creating a builder at the
    // same moment can never collide — a caller-supplied ID is only for the
    // one-time migration of a device's pre-existing local identity list
    // onto this shared roster, preserving the exact ID any landlet it
    // already claimed is tagged with.
    const builderId = input.builderId !== undefined
      ? stringValue(input.builderId, 'builderId')
      : `builder-${crypto.randomUUID()}`;
    await db.prepare('INSERT INTO builders (builder_id, label) VALUES (?, ?)').bind(builderId, label).run();
    const row = await db.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
    return json({ builder: builderFromRow(row) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    await requireBuilder(db, route[1]);
    const input = await readJson(request);
    const label = stringValue(input.label, 'label');
    await db.prepare(`
      UPDATE builders SET label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE builder_id = ?
    `).bind(label, route[1]).run();
    const updated = await requireBuilder(db, route[1]);
    return json({ builder: builderFromRow(updated) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await requireBuilder(db, route[1]);
    // Whatever this builder currently owns goes back to a fresh, unclaimed
    // plot rather than sitting there under a builder that no longer
    // exists — its placed content and version history are cleared, not
    // just its ownership. (Deliberately different from a future
    // inactivity-based reclaim: that should clear the *active* build but
    // keep the builder's own version history around in case they come
    // back, since that builder still exists. Deleting the builder removes
    // the only place that history could live.)
    const owned = await db.prepare(`
      SELECT landlet_id FROM landlets WHERE owner_builder_id = ? AND status = 'claimed'
    `).bind(route[1]).all();
    const landletIds = owned.results.map((row) => row.landlet_id);

    const statements = landletIds.flatMap((landletId) => [
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind(landletId),
      db.prepare('DELETE FROM landlet_versions WHERE landlet_id = ?').bind(landletId),
      db.prepare(`
        UPDATE landlets
        SET status = 'greenbelt', owner_builder_id = NULL, active_version_id = NULL,
            claimable_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ?
      `).bind(landletId),
    ]);
    statements.push(db.prepare('DELETE FROM builders WHERE builder_id = ?').bind(route[1]));
    await db.batch(statements);
    return json({ deleted: true, releasedLandletIds: landletIds });
  }

  return json({ error: 'Not found' }, 404);
}

function builderFromRow(row) {
  return {
    builderId: row.builder_id,
    label: row.label,
    // pioneerRank is the founding-cohort position (1 = very first claimer);
    // isPioneer is just a convenience boolean derived from it so the
    // frontend doesn't need a null-check everywhere it only cares about
    // membership, not rank (see docs/API.md's "Founding/pioneer
    // recognition").
    pioneerRank: row.pioneer_rank ?? null,
    isPioneer: row.pioneer_rank !== null,
    // Land acquisition auctions (docs/SPEC.md §5, migrations/0045) — a
    // real, persisted ledger credited when this builder sells a landlet
    // via auction. See migrations/0045's own note on why bidding itself
    // isn't gated by having a sufficient balance yet.
    dallersBalanceCents: row.dallers_balance_cents,
    // Land cap (docs/SPEC.md §3, migrations/0050) — how much total lándlet
    // area this builder may own at once, distinct from dallersBalanceCents
    // above (which land-specific lándlets can be acquired via auction).
    landCapM2: row.land_cap_m2,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireBuilder(db, builderId) {
  const row = await db.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
  if (!row) throw new HttpError('Builder not found', 404);
  return row;
}

// A genuinely separate roster from builders (see 0037_sellers.sql) —
// catalog_templates.seller_id references this table's IDs now, not a
// builder's. Simpler than handleBuilders: a seller owns no land, so
// deleting one has no ownership-release cleanup to do — it just leaves
// any of their existing templates' seller_id pointing at an ID no longer
// in the roster, the same way a template can already have a null
// seller_id for an unclaimed custom upload.
async function handleSellers(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    const { results } = await db.prepare('SELECT * FROM sellers ORDER BY created_at, seller_id').all();
    return json({ sellers: results.map(sellerFromRow) });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const label = stringValue(input.label, 'label');
    const sellerId = input.sellerId !== undefined
      ? stringValue(input.sellerId, 'sellerId')
      : `seller-${crypto.randomUUID()}`;
    await db.prepare('INSERT INTO sellers (seller_id, label) VALUES (?, ?)').bind(sellerId, label).run();
    const row = await db.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(sellerId).first();
    return json({ seller: sellerFromRow(row) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    await requireSeller(db, route[1]);
    const input = await readJson(request);
    const label = stringValue(input.label, 'label');
    await db.prepare(`
      UPDATE sellers SET label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE seller_id = ?
    `).bind(label, route[1]).run();
    const updated = await requireSeller(db, route[1]);
    return json({ seller: sellerFromRow(updated) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await requireSeller(db, route[1]);
    await db.prepare('DELETE FROM sellers WHERE seller_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Builder-facing notifications (see notifyBuildersOfDimensionChange) — a
// plain read-and-acknowledge list, not a full inbox: no pagination cursor
// since one builder's outstanding count should stay small in practice,
// and no DELETE since a read notification is still useful history for
// "wait, when did that change?"
async function handleNotifications(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const builderId = stringValue(url.searchParams.get('builderId'), 'builderId');
    const unreadOnlyParam = url.searchParams.get('unreadOnly');
    const conditions = ['builder_id = ?'];
    const bindings = [builderId];
    if (unreadOnlyParam === 'true') conditions.push('read_at IS NULL');
    const { results } = await db.prepare(`
      SELECT * FROM notifications WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 100
    `).bind(...bindings).all();
    return json({ notifications: results.map(notificationFromRow) });
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM notifications WHERE notification_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Notification not found' }, 404);
    const input = await readJson(request);
    if (input.read === true) {
      await db.prepare(`
        UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE notification_id = ?
      `).bind(route[1]).run();
    }
    const updated = await db.prepare('SELECT * FROM notifications WHERE notification_id = ?').bind(route[1]).first();
    return json({ notification: notificationFromRow(updated) });
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'mark-all-read') {
    const input = await readJson(request);
    const builderId = stringValue(input.builderId, 'builderId');
    await db.prepare(`
      UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE builder_id = ? AND read_at IS NULL
    `).bind(builderId).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

function notificationFromRow(row) {
  return {
    notificationId: row.notification_id,
    builderId: row.builder_id,
    message: row.message,
    templateId: row.template_id,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

// Friend requests (docs/SPEC.md §2: "Friend/group systems: standard friend
// requests; social map shows friends' approximate location."). One row per
// relationship, direction preserved (requester/recipient), status flips
// pending -> accepted in place. No ownership check on PATCH/DELETE — same
// no-real-auth caveat as every other dev-mode identity in this file; the
// frontend only shows Accept on the recipient's own incoming requests.
//
// "Social map ... approximate location" is deliberately simplified to each
// accepted friend's owned lándlet center — this app has no live avatar
// position tracking at all (Shop-mode camera position is never persisted),
// so there is no real "current location" to report regardless of how this
// endpoint is built. A builder's claimed lándlet is the one stable,
// already-known location the backend actually has for them.
async function handleFriendships(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const builderId = stringValue(url.searchParams.get('builderId'), 'builderId');
    const { results } = await db.prepare(`
      SELECT * FROM friendships WHERE requester_builder_id = ? OR recipient_builder_id = ?
      ORDER BY created_at DESC
    `).bind(builderId, builderId).all();
    const otherBuilderIds = results.map((row) =>
      row.requester_builder_id === builderId ? row.recipient_builder_id : row.requester_builder_id);
    const labelsById = await labelsByBuilderId(db, otherBuilderIds);
    const landletsById = await ownedLandletsByBuilderId(db, otherBuilderIds);
    return json({
      friendships: results.map((row) => friendshipFromRow(row, builderId, labelsById, landletsById)),
    });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const requesterBuilderId = stringValue(input.requesterBuilderId, 'requesterBuilderId');
    const recipientBuilderId = stringValue(input.recipientBuilderId, 'recipientBuilderId');
    if (requesterBuilderId === recipientBuilderId) {
      throw new HttpError('requesterBuilderId and recipientBuilderId must be different builders', 400);
    }
    await assertReferenceExists(db, 'builders', 'builder_id', requesterBuilderId, 'requesterBuilderId');
    await assertReferenceExists(db, 'builders', 'builder_id', recipientBuilderId, 'recipientBuilderId');
    const existing = await db.prepare(`
      SELECT 1 FROM friendships
      WHERE (requester_builder_id = ? AND recipient_builder_id = ?)
         OR (requester_builder_id = ? AND recipient_builder_id = ?)
    `).bind(requesterBuilderId, recipientBuilderId, recipientBuilderId, requesterBuilderId).first();
    if (existing) throw new HttpError('A friendship or pending request already exists between these builders', 409);
    const friendshipId = `friendship-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO friendships (friendship_id, requester_builder_id, recipient_builder_id) VALUES (?, ?, ?)
    `).bind(friendshipId, requesterBuilderId, recipientBuilderId).run();
    const row = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(friendshipId).first();
    const labelsById = await labelsByBuilderId(db, [recipientBuilderId]);
    const landletsById = await ownedLandletsByBuilderId(db, [recipientBuilderId]);
    return json({ friendship: friendshipFromRow(row, requesterBuilderId, labelsById, landletsById) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Friendship not found' }, 404);
    const input = await readJson(request);
    if (input.status !== 'accepted') throw new HttpError('status must be "accepted"', 400);
    await db.prepare(`UPDATE friendships SET status = 'accepted' WHERE friendship_id = ?`).bind(route[1]).run();
    const updated = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
    const labelsById = await labelsByBuilderId(db, [updated.requester_builder_id]);
    const landletsById = await ownedLandletsByBuilderId(db, [updated.requester_builder_id]);
    return json({ friendship: friendshipFromRow(updated, updated.recipient_builder_id, labelsById, landletsById) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM friendships WHERE friendship_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Friendship not found' }, 404);
    await db.prepare('DELETE FROM friendships WHERE friendship_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

async function labelsByBuilderId(db, builderIds) {
  const uniqueIds = [...new Set(builderIds)];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT builder_id, label FROM builders WHERE builder_id IN (${placeholders})`,
  ).bind(...uniqueIds).all();
  return new Map(results.map((row) => [row.builder_id, row.label]));
}

async function ownedLandletsByBuilderId(db, builderIds) {
  const uniqueIds = [...new Set(builderIds)];
  if (uniqueIds.length === 0) return new Map();
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT * FROM landlets WHERE owner_builder_id IN (${placeholders})`,
  ).bind(...uniqueIds).all();
  const byOwner = new Map();
  for (const row of results) {
    // A builder can own more than one lándlet (auctions can transfer extra
    // ones in) — the first one found is good enough for "approximate
    // location," not a definitive "their one true home."
    if (!byOwner.has(row.owner_builder_id)) byOwner.set(row.owner_builder_id, landletFromRow(row));
  }
  return byOwner;
}

function friendshipFromRow(row, viewerBuilderId, labelsById, landletsById) {
  const otherBuilderId = row.requester_builder_id === viewerBuilderId
    ? row.recipient_builder_id
    : row.requester_builder_id;
  const landlet = landletsById.get(otherBuilderId) ?? null;
  return {
    friendshipId: row.friendship_id,
    requesterBuilderId: row.requester_builder_id,
    recipientBuilderId: row.recipient_builder_id,
    status: row.status,
    createdAt: row.created_at,
    otherBuilderId,
    otherLabel: labelsById.get(otherBuilderId) ?? null,
    direction: row.requester_builder_id === viewerBuilderId ? 'outgoing' : 'incoming',
    otherLandlet: landlet ? { landletId: landlet.landletId, name: landlet.name, center: landlet.center } : null,
  };
}

// Saved groups a builder can stamp down together in one tap (see
// docs/API.md's "Bundles") — a named, persisted version of the same
// relative-offset shape the frontend's own Copy/Paste already builds in
// memory (copySelection/placeClipboardItems in src/main.js). No rename of
// a bundle's *contents* here — only its name/shared flag — since there's no
// frontend flow for editing a saved bundle's items; delete and re-save
// covers that.
//
// `shared` (see migrations/0040_bundle_sharing.sql) only controls
// visibility — a shared bundle is still owned by whoever created it, and
// this endpoint does no ownership check on PATCH/DELETE (same no-real-auth
// caveat as every other dev-mode identity in this file). The frontend is
// the only thing enforcing "only your own bundles show a delete/share
// button" (see renderBundleTiles in src/main.js).
async function handleBundles(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    // Two independent listings, not one filtered by both: `shared=true` is
    // the community tab (every builder's shared bundles, not just one
    // builder's), while `builderId` alone is "my bundles" (everything this
    // builder owns, shared or not) — a builder's own shared bundles should
    // keep showing in their own private list too, not move out of it.
    if (url.searchParams.get('shared') === 'true') {
      const { results } = await db.prepare(`
        SELECT * FROM bundles WHERE shared = 1 ORDER BY created_at DESC LIMIT 100
      `).all();
      return json({ bundles: results.map(bundleFromRow) });
    }
    const builderId = stringValue(url.searchParams.get('builderId'), 'builderId');
    const { results } = await db.prepare(`
      SELECT * FROM bundles WHERE builder_id = ? ORDER BY created_at DESC LIMIT 100
    `).bind(builderId).all();
    return json({ bundles: results.map(bundleFromRow) });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const builderId = stringValue(input.builderId, 'builderId');
    const name = stringValue(input.name, 'name');
    const items = validateBundleItems(input.items);
    const shared = input.shared === true;
    await assertReferenceExists(db, 'builders', 'builder_id', builderId, 'builderId');
    await assertReferencesExist(db, 'catalog_templates', 'template_id', items.map((item) => item.templateId), 'items[].templateId');
    const bundleId = `bundle-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO bundles (bundle_id, builder_id, name, items_json, shared) VALUES (?, ?, ?, ?, ?)
    `).bind(bundleId, builderId, name, JSON.stringify(items), shared ? 1 : 0).run();
    const row = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(bundleId).first();
    return json({ bundle: bundleFromRow(row) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Bundle not found' }, 404);
    const input = await readJson(request);
    // Both fields optional and independent — a rename shouldn't have to
    // also resend the current shared flag, and vice versa.
    const name = input.name === undefined ? existing.name : stringValue(input.name, 'name');
    const shared = input.shared === undefined ? Boolean(existing.shared) : input.shared === true;
    await db.prepare(`
      UPDATE bundles SET name = ?, shared = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE bundle_id = ?
    `).bind(name, shared ? 1 : 0, route[1]).run();
    const updated = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(route[1]).first();
    return json({ bundle: bundleFromRow(updated) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM bundles WHERE bundle_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Bundle not found' }, 404);
    await db.prepare('DELETE FROM bundles WHERE bundle_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

// Each item is { templateId, dx, dy, dz, rotationX, rotationY, rotationZ,
// crop, scale } — dx/dy/dz and the rotations are offsets/orientations, not
// positions, so (unlike most other dimension-shaped fields in this file)
// they're allowed to be negative or zero. Reuses validateCropShape and
// validateScale directly since this is exactly the shape those already
// validate for a placed instance.
function validateBundleItems(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError('items must be a non-empty array', 400);
  }
  if (input.length > 250) {
    throw new HttpError('items cannot exceed 250 entries', 400);
  }
  return input.map((item, index) => ({
    templateId: stringValue(item.templateId, `items[${index}].templateId`),
    dx: finiteNumber(item.dx, `items[${index}].dx`),
    dy: finiteNumber(item.dy, `items[${index}].dy`),
    dz: finiteNumber(item.dz, `items[${index}].dz`),
    rotationX: finiteNumber(item.rotationX ?? 0, `items[${index}].rotationX`),
    rotationY: finiteNumber(item.rotationY ?? 0, `items[${index}].rotationY`),
    rotationZ: finiteNumber(item.rotationZ ?? 0, `items[${index}].rotationZ`),
    crop: validateCropShape(item.crop),
    scale: validateScale(item.scale),
  }));
}

function bundleFromRow(row) {
  return {
    bundleId: row.bundle_id,
    builderId: row.builder_id,
    name: row.name,
    items: JSON.parse(row.items_json),
    shared: Boolean(row.shared),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Land acquisition auctions (docs/SPEC.md §5, migrations/0045_auctions.sql,
// docs/API.md's "Land acquisition auctions"). Two entry points into this
// module: handleStartAuction is reached via POST /api/landlets/:id/auction
// (a landlet-scoped nested route, called from handleLandlets — the same
// pattern /versions and /draft already use), and handleAuctions handles
// everything under the top-level /api/auctions collection itself.
async function handleStartAuction(request, db, landletId) {
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
  const landlet = await requireLandlet(db, landletId);
  const input = await readJson(request);
  const builderId = stringValue(input.builderId, 'builderId');
  if (landlet.status !== 'claimed' || landlet.owner_builder_id !== builderId) {
    throw new HttpError('Only the current owner of a claimed landlet can start an auction on it', 400);
  }
  const alreadyActive = await db.prepare(`
    SELECT 1 FROM auctions WHERE landlet_id = ? AND status = 'active'
  `).bind(landletId).first();
  if (alreadyActive) throw new HttpError('This landlet already has an active auction', 409);

  const startingBidCents = input.startingBidCents === undefined ? 0 : nonnegativeInteger(input.startingBidCents, 'startingBidCents');
  // "Default 24-hour duration for inactivity-triggered listings; builder-
  // initiated voluntary auctions may set custom duration" — every auction
  // reachable today is builder-initiated (there's no inactivity-detection
  // job in this dev-mode backend to trigger one automatically), so this
  // default just applies uniformly. Capped at a year as a sanity bound
  // against a malformed request producing an absurd ends_at — not itself
  // a spec requirement.
  const durationHours = input.durationHours === undefined ? 24 : positiveInteger(input.durationHours, 'durationHours');
  if (durationHours > 8760) throw new HttpError('durationHours must be 8760 (one year) or fewer', 400);

  const auctionId = `auction-${crypto.randomUUID()}`;
  const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO auctions (auction_id, landlet_id, seller_builder_id, starting_bid_cents, ends_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(auctionId, landletId, builderId, startingBidCents, endsAt).run();
  const row = await db.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(auctionId).first();
  return json({ auction: await auctionFromRow(db, row) }, 201);
}

async function handleAuctions(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    await resolveDueAuctions(db);
    const status = url.searchParams.get('status');
    if (status !== null && !['active', 'ended'].includes(status)) {
      throw new HttpError('status must be active or ended', 400);
    }
    const landletIdParam = url.searchParams.get('landletId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    if (status) {
      conditions.push('status = ?');
      bindings.push(status);
    }
    if (landletIdParam !== null) {
      conditions.push('landlet_id = ?');
      bindings.push(stringValue(landletIdParam, 'landletId'));
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND auction_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM auctions ${where}
      ORDER BY created_at, auction_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      auctions: await Promise.all(page.map((row) => auctionFromRow(db, row))),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.auction_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const auction = await requireAuction(db, route[1]);
    const resolved = await resolveAuctionIfDue(db, auction);
    return json({ auction: await auctionFromRow(db, resolved) });
  }

  if (route.length === 3 && route[2] === 'bids') {
    return handleAuctionBids(request, db, route);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'resolve') {
    const auction = await requireAuction(db, route[1]);
    const resolved = await resolveAuctionIfDue(db, auction);
    if (resolved.status === 'active') {
      throw new HttpError('This auction has not ended yet', 409);
    }
    return json({ auction: await auctionFromRow(db, resolved) });
  }

  return json({ error: 'Not found' }, 404);
}

async function handleAuctionBids(request, db, route) {
  const auctionId = route[1];

  if (request.method === 'GET') {
    await requireAuction(db, auctionId);
    const { results } = await db.prepare(`
      SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 200
    `).bind(auctionId).all();
    return json({ bids: results.map(auctionBidFromRow) });
  }

  if (request.method === 'POST') {
    const auction = await requireAuction(db, auctionId);
    const resolved = await resolveAuctionIfDue(db, auction);
    if (resolved.status !== 'active') {
      throw new HttpError('This auction has already ended', 409);
    }
    const input = await readJson(request);
    const builderId = stringValue(input.builderId, 'builderId');
    if (builderId === resolved.seller_builder_id) {
      throw new HttpError('The seller cannot bid on their own auction', 400);
    }
    await requireBuilder(db, builderId);
    const amountCents = nonnegativeInteger(input.amountCents, 'amountCents');
    const highest = await db.prepare(`
      SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 1
    `).bind(auctionId).first();
    const minimumCents = highest ? highest.amount_cents + 1 : resolved.starting_bid_cents;
    if (amountCents < minimumCents) {
      throw new HttpError(`amountCents must be at least ${minimumCents}`, 400);
    }
    const bidId = `bid-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)
    `).bind(bidId, auctionId, builderId, amountCents).run();
    await db.prepare(`UPDATE auctions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE auction_id = ?`).bind(auctionId).run();
    await notifyOfNewBid(db, resolved, amountCents, builderId, highest);
    const bidRow = await db.prepare('SELECT * FROM auction_bids WHERE bid_id = ?').bind(bidId).first();
    return json({ bid: auctionBidFromRow(bidRow) }, 201);
  }

  return json({ error: 'Not found' }, 404);
}

async function requireAuction(db, auctionId) {
  const row = await db.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(auctionId).first();
  if (!row) throw new HttpError('Auction not found', 404);
  return row;
}

// Land cap (docs/SPEC.md §3: "Grows via a formula converting trailing-30-day
// dáller earnings per 1,000 m² owned into cap increases. Ratcheting: once
// increased, never decreases. Conversion ratio adjusts at most once/month,
// small increments.") The conversion ratio itself is exactly the kind of
// number docs/SPEC.md §10's own "Lándlet hosting cost validation" open
// item flags as "needs validation against real measured costs once live" —
// this constant is a placeholder pending that, not a claimed-final number.
// The "adjusts at most once/month" cadence describes an operator tuning
// this constant over time, not something this dev-mode backend does on its
// own — there is no mechanism here (or need for one) to change it
// automatically.
//
// DELIBERATELY TRACKING-ONLY, NOT ENFORCED, for now — this was tried as a
// hard block on auction bids and reverted after e2e testing surfaced a real
// bootstrapping trap: claiming is mandatory to use Build mode at all
// (resolveLandletId in src/main.js forces the claim flow for a landless
// builder), and the default cap is exactly the starter lándlet's own size,
// so EVERY fresh builder starts already at 100% of their cap the moment
// they exist. Spec's own intended primary earning path is commerce
// commissions (§5: dállers credit on a product SALE, not on selling land),
// but this dev-mode backend has no real checkout/commerce system at all
// (out of scope, same as real payments generally) — auction sale proceeds
// are the ONLY dáller source actually implemented. Hard-enforcing the cap
// against that one source alone would make growing past your starter
// lándlet structurally impossible for every builder (nobody can ever earn
// without first having cap headroom to acquire something to resell, and
// nobody has headroom without having already earned) — a regression that
// would make the auction system self-defeating, not a faithful
// implementation of "growth is earned through demonstrated performance."
// The formula, ratcheting, and per-event ledger are still real and
// correctly implemented — recomputeLandCap is exposed via `landCapM2` on
// the builder object (see docs/API.md's "Land cap") so this is visible and
// ready to gate real acquisitions once a real commerce/commission loop
// exists to make that gate navigable.
const LAND_CAP_STARTER_M2 = 1000; // matches the free starter lándlet exactly
const LAND_CAP_TRAILING_WINDOW_DAYS = 30;
const LAND_CAP_M2_PER_DOLLAR_PER_1000M2 = 100;

// Recomputes what this builder's land cap SHOULD be right now, from their
// trailing earnings window and current owned area, and ratchets
// land_cap_m2 up to that if it's higher than what's already stored — never
// down, even though the trailing window itself can shrink as earnings age
// out of it. Called lazily, the same "no Cloudflare Cron Trigger anywhere
// in this app" pattern auction resolution and scheduled calendar events
// already use, rather than on any kind of schedule — specifically, on
// every GET of the builder it belongs to, so landCapM2 is always current
// by the time any caller actually reads it.
async function recomputeLandCap(db, builderId) {
  const builder = await db.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
  if (!builder) return LAND_CAP_STARTER_M2;
  const windowStart = new Date(Date.now() - LAND_CAP_TRAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const earningsRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM daller_earnings_events
    WHERE builder_id = ? AND created_at >= ?
  `).bind(builderId, windowStart).first();
  const ownedRow = await db.prepare(`
    SELECT COALESCE(SUM(area_m2), 0) AS total FROM landlets WHERE owner_builder_id = ? AND status = 'claimed'
  `).bind(builderId).first();
  const normalizedThousands = Math.max(ownedRow.total, LAND_CAP_STARTER_M2) / 1000;
  const trailingEarningsDollars = earningsRow.total / 100;
  const earningsDollarsPerThousandM2Owned = trailingEarningsDollars / normalizedThousands;
  const increaseM2 = Math.floor(earningsDollarsPerThousandM2Owned * LAND_CAP_M2_PER_DOLLAR_PER_1000M2);
  const candidateCap = LAND_CAP_STARTER_M2 + increaseM2;
  const nextCap = Math.max(builder.land_cap_m2, candidateCap);
  if (nextCap !== builder.land_cap_m2) {
    await db.prepare('UPDATE builders SET land_cap_m2 = ? WHERE builder_id = ?').bind(nextCap, builderId).run();
  }
  return nextCap;
}

// Sweeps every active-but-expired auction and resolves each in turn — the
// closest this dev-mode backend gets to a real scheduled job (see
// docs/API.md's own note on why: no Cron Trigger is wired up, so
// resolution is purely lazy, triggered by whatever request happens to
// touch auctions next). Called at the top of the list endpoint so a
// shopper browsing auctions always sees current state without needing to
// separately poll or trigger resolution themselves.
async function resolveDueAuctions(db) {
  const { results } = await db.prepare(`
    SELECT * FROM auctions WHERE status = 'active' AND ends_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).all();
  for (const row of results) await resolveAuction(db, row);
}

// Single-auction version of the same check, used wherever one specific
// auction is already being read/acted on (GET one, place a bid, the
// explicit resolve endpoint) — avoids the full-table sweep above when
// only one row's state actually matters here.
async function resolveAuctionIfDue(db, auction) {
  if (auction.status !== 'active' || auction.ends_at > new Date().toISOString()) return auction;
  return resolveAuction(db, auction);
}

// The actual resolution: highest bidder wins and pays the seller (in
// dállers — see migrations/0045's own note on why bidding isn't
// balance-gated yet), or the land is released to greenbelt / stays with
// the seller depending on whether the starting bid was $0 ("explicit
// willingness to relinquish for free") — see docs/SPEC.md §5. Clearing
// the landlet's build on a transfer mirrors DELETE /api/builders/:id's
// own reasoning: a new owner gets the land, not the previous owner's
// stuff on it.
async function resolveAuction(db, auction) {
  const highest = await db.prepare(`
    SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 1
  `).bind(auction.auction_id).first();

  const statements = [];
  if (highest) {
    statements.push(
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind(auction.landlet_id),
      db.prepare('DELETE FROM landlet_versions WHERE landlet_id = ?').bind(auction.landlet_id),
      db.prepare(`
        UPDATE landlets
        SET owner_builder_id = ?, active_version_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ?
      `).bind(highest.bidder_builder_id, auction.landlet_id),
      db.prepare(`
        UPDATE builders SET dallers_balance_cents = dallers_balance_cents + ? WHERE builder_id = ?
      `).bind(highest.amount_cents, auction.seller_builder_id),
      // Land cap (docs/SPEC.md §3, migrations/0050) grows off a genuine
      // trailing-30-day earnings WINDOW, not the lifetime
      // dallers_balance_cents total above — this per-event ledger is what
      // makes that window computable later (see recomputeLandCap).
      db.prepare(`
        INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
      `).bind(`earnings-${crypto.randomUUID()}`, auction.seller_builder_id, highest.amount_cents),
      db.prepare(`
        UPDATE auctions SET status = 'ended', winning_bid_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE auction_id = ?
      `).bind(highest.bid_id, auction.auction_id),
      notificationStatement(db, auction.seller_builder_id,
        `Your auction for ${auction.landlet_id} sold for ${formatCents(highest.amount_cents)} — credited to your dállers balance.`),
      notificationStatement(db, highest.bidder_builder_id,
        `You won the auction for ${auction.landlet_id} at ${formatCents(highest.amount_cents)}! It's yours to build on now.`),
    );
  } else if (auction.starting_bid_cents === 0) {
    statements.push(
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind(auction.landlet_id),
      db.prepare('DELETE FROM landlet_versions WHERE landlet_id = ?').bind(auction.landlet_id),
      db.prepare(`
        UPDATE landlets
        SET status = 'greenbelt', owner_builder_id = NULL, active_version_id = NULL,
            claimable_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ?
      `).bind(auction.landlet_id),
      db.prepare(`UPDATE auctions SET status = 'ended', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE auction_id = ?`).bind(auction.auction_id),
      notificationStatement(db, auction.seller_builder_id,
        `Your auction for ${auction.landlet_id} ended with no bids and was released to greenbelt, as you specified with its $0 starting bid.`),
    );
  } else {
    statements.push(
      db.prepare(`UPDATE auctions SET status = 'ended', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE auction_id = ?`).bind(auction.auction_id),
      notificationStatement(db, auction.seller_builder_id,
        `Your auction for ${auction.landlet_id} ended with no bids — you keep the land.`),
    );
  }
  await db.batch(statements);
  return db.prepare('SELECT * FROM auctions WHERE auction_id = ?').bind(auction.auction_id).first();
}

// Bid-notification counterpart to resolveAuction's own — fired right
// after a bid is successfully recorded, not batched atomically with it
// (best-effort, same convention notifyBuildersOfDimensionChange already
// follows: notifications are informational, never worth failing the
// actual write over).
async function notifyOfNewBid(db, auction, amountCents, bidderBuilderId, previousHighest) {
  const statements = [
    notificationStatement(db, auction.seller_builder_id,
      `New bid of ${formatCents(amountCents)} on your auction for ${auction.landlet_id}.`),
  ];
  if (previousHighest && previousHighest.bidder_builder_id !== bidderBuilderId) {
    statements.push(notificationStatement(db, previousHighest.bidder_builder_id,
      `You've been outbid on ${auction.landlet_id} — new high bid ${formatCents(amountCents)}.`));
  }
  await db.batch(statements);
}

function notificationStatement(db, builderId, message) {
  return db.prepare(
    'INSERT INTO notifications (notification_id, builder_id, message) VALUES (?, ?, ?)',
  ).bind(`notification-${crypto.randomUUID()}`, builderId, message);
}

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function auctionFromRow(db, row) {
  const highest = await db.prepare(`
    SELECT amount_cents FROM auction_bids WHERE auction_id = ? ORDER BY amount_cents DESC, created_at LIMIT 1
  `).bind(row.auction_id).first();
  const bidCount = await db.prepare('SELECT COUNT(*) AS n FROM auction_bids WHERE auction_id = ?').bind(row.auction_id).first();
  return {
    auctionId: row.auction_id,
    landletId: row.landlet_id,
    sellerBuilderId: row.seller_builder_id,
    startingBidCents: row.starting_bid_cents,
    status: row.status,
    endsAt: row.ends_at,
    winningBidId: row.winning_bid_id,
    highestBidCents: highest ? highest.amount_cents : null,
    bidCount: bidCount.n,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auctionBidFromRow(row) {
  return {
    bidId: row.bid_id,
    auctionId: row.auction_id,
    bidderBuilderId: row.bidder_builder_id,
    amountCents: row.amount_cents,
    createdAt: row.created_at,
  };
}

function nonnegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpError(`${field} must be a non-negative integer`, 400);
  return number;
}

function sellerFromRow(row) {
  return {
    sellerId: row.seller_id,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireSeller(db, sellerId) {
  const row = await db.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(sellerId).first();
  if (!row) throw new HttpError('Seller not found', 404);
  return row;
}

async function handleLandlets(request, db, route, url) {
  if (route.length >= 3 && route[2] === 'versions') {
    return handleLandletVersions(request, db, route, url);
  }

  if (route.length === 3 && route[2] === 'auction') {
    return handleStartAuction(request, db, route[1]);
  }

  if (route.length === 3 && route[2] === 'draft') {
    return handleLandletDraft(request, db, route[1]);
  }

  if (request.method === 'GET' && route.length === 3 && route[2] === 'live') {
    return handleLiveLandlet(db, route[1]);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'generation-complete') {
    const existing = await requireLandlet(db, route[1]);
    if (existing.generated_at) return json({ landlet: landletFromRow(existing) });
    if (existing.status !== 'generating') {
      throw new HttpError('Landlet is not currently generating', 409);
    }

    const settings = await getWorldSettings(db);
    const enclosed = landletMaxWorldRadius(existing) <= settings.radius_m;
    await db.prepare(`
      UPDATE landlets
      SET generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          status = CASE WHEN ? THEN 'greenbelt' ELSE status END,
          claimable_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE claimable_at END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND status = 'generating' AND generated_at IS NULL
    `).bind(enclosed ? 1 : 0, enclosed ? 1 : 0, route[1]).run();
    const updated = await requireLandlet(db, route[1]);
    return json({ landlet: landletFromRow(updated) });
  }

  if (request.method === 'GET' && route.length === 1) {
    const status = url.searchParams.get('status');
    const ownerBuilderIdParam = url.searchParams.get('ownerBuilderId');
    if (status !== null && !['greenbelt', 'claimed', 'generating'].includes(status)) {
      throw new HttpError('status must be greenbelt, claimed, or generating', 400);
    }
    const ownerBuilderId = ownerBuilderIdParam === null
      ? null
      : stringValue(ownerBuilderIdParam, 'ownerBuilderId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    if (status) {
      conditions.push('status = ?');
      bindings.push(status);
    }
    if (ownerBuilderId) {
      conditions.push('owner_builder_id = ?');
      bindings.push(ownerBuilderId);
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND landlet_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM landlets ${where}
      ORDER BY created_at, landlet_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      landlets: page.map(landletFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.landlet_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    return row ? json({ landlet: landletFromRow(row) }) : json({ error: 'Landlet not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'claim') {
    const input = await readJson(request);
    const builderId = stringValue(input.builderId, 'builderId');
    const result = await db.prepare(`
      UPDATE landlets
      SET status = 'claimed', owner_builder_id = ?,
          claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ?
        AND status = 'greenbelt'
        AND owner_builder_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM landlets
          WHERE owner_builder_id = ? AND status = 'claimed'
        )
    `).bind(builderId, route[1], builderId).run();

    if (result.meta.changes === 0) {
      await explainClaimConflict(db, route[1], builderId);
    } else {
      // Founding/pioneer recognition (docs/SPEC.md §3, migrations/0044) —
      // this builder's first-ever successful claim earns the next
      // sequential rank in the founding cohort, as long as fewer than
      // PIONEER_COHORT_SIZE ranks have been handed out so far. No-ops
      // silently past the cutoff, or if this builder already has a rank
      // (e.g. claiming a second landlet after releasing an earlier one).
      await db.prepare(`
        UPDATE builders
        SET pioneer_rank = (SELECT COALESCE(MAX(pioneer_rank), 0) + 1 FROM builders)
        WHERE builder_id = ? AND pioneer_rank IS NULL
          AND (SELECT COUNT(*) FROM builders WHERE pioneer_rank IS NOT NULL) < ?
      `).bind(builderId, PIONEER_COHORT_SIZE).run();
    }

    const row = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    return json({ landlet: landletFromRow(row) });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const landlet = validateLandlet(input, crypto.randomUUID());
    await db.prepare(`
      INSERT INTO landlets
        (landlet_id, name, area_m2, center_x_m, center_y_m, status, owner_builder_id, land_class,
         polygon_json, generated_at, claimable_at, metadata_json, max_world_radius_m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...landletParams(landlet), landletMaxWorldRadius(candidateRowFromLandlet(landlet))).run();
    return json({ landlet }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Landlet not found' }, 404);
    const input = await readJson(request);
    const landlet = validateLandlet({ ...landletFromRow(existing), ...input, landletId: route[1] }, route[1]);
    await db.prepare(`
      UPDATE landlets
      SET name = ?, area_m2 = ?, center_x_m = ?, center_y_m = ?, status = ?, owner_builder_id = ?,
          land_class = ?, polygon_json = ?, generated_at = ?, claimable_at = ?, metadata_json = ?,
          max_world_radius_m = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ?
    `).bind(
      landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.status,
      landlet.ownerBuilderId, landlet.landClass, JSON.stringify(landlet.polygon), landlet.generatedAt,
      landlet.claimableAt, JSON.stringify(landlet.metadata),
      landletMaxWorldRadius(candidateRowFromLandlet(landlet)), route[1],
    ).run();
    return json({ landlet });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await db.prepare('DELETE FROM landlets WHERE landlet_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

async function handleLiveLandlet(db, landletId) {
  const row = await requireLandlet(db, landletId);
  const landlet = landletFromRow(row);
  if (!landlet.activeVersionId) {
    return json({ landlet, published: false, version: null, instances: [] });
  }

  const version = await getVersion(db, landletId, landlet.activeVersionId);
  if (!version) throw new HttpError('Active landlet version not found', 500);
  const { results } = await db.prepare(`
    SELECT * FROM version_instances WHERE version_id = ? ORDER BY source_instance_id
  `).bind(landlet.activeVersionId).all();
  return json({
    landlet,
    published: true,
    version,
    instances: results.map(versionInstanceFromRow),
  });
}

async function handleLandletDraft(request, db, landletId) {
  await requireLandlet(db, landletId);

  if (request.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? ORDER BY created_at').bind(landletId).all();
    return json({ instances: results.map(instanceFromRow) });
  }

  if (request.method === 'PUT') {
    const input = await readJson(request);
    if (!Array.isArray(input.instances)) throw new HttpError('instances must be an array', 400);
    if (input.instances.length > 250) throw new HttpError('instances must contain at most 250 items', 400);

    const instances = input.instances.map((item) => validateInstance({ ...item, landletId }, crypto.randomUUID()));
    const ids = new Set();
    for (const instance of instances) {
      if (ids.has(instance.instanceId)) throw new HttpError('instanceId values must be unique', 400);
      ids.add(instance.instanceId);
    }
    await assertCropWithinTemplateBounds(db, instances);

    const versionId = crypto.randomUUID();
    const versionName = input.versionName === undefined ? null : stringValue(input.versionName, 'versionName');
    const versionMetadata = input.versionMetadata || {};
    JSON.stringify(versionMetadata);

    await db.batch([
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind(landletId),
      db.prepare(`
        INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale)
        SELECT
          json_extract(value, '$.instanceId'), ?, json_extract(value, '$.templateId'),
          json_extract(value, '$.x'), json_extract(value, '$.y'), json_extract(value, '$.z'),
          json_extract(value, '$.rotationX'), json_extract(value, '$.rotationY'), json_extract(value, '$.rotationZ'),
          json_extract(value, '$.label'), json_extract(value, '$.crop'), json_extract(value, '$.scale')
        FROM json_each(?)
      `).bind(landletId, JSON.stringify(instances)),
      db.prepare(`
        INSERT INTO landlet_versions (version_id, landlet_id, version_number, name, metadata_json)
        SELECT ?, ?, next_version_number,
               COALESCE(?, 'Version ' || next_version_number), ?
        FROM (
          SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number
          FROM landlet_versions WHERE landlet_id = ?
        )
      `).bind(versionId, landletId, versionName, JSON.stringify(versionMetadata), landletId),
      db.prepare(`
        INSERT INTO version_instances
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale)
        SELECT ?, instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale
        FROM placed_instances WHERE landlet_id = ?
      `).bind(versionId, landletId),
    ]);

    const { results } = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? ORDER BY created_at').bind(landletId).all();
    const version = await getVersion(db, landletId, versionId);
    return json({ instances: results.map(instanceFromRow), version });
  }

  return json({ error: 'Not found' }, 404);
}

async function handleLandCandidates(request, db, route, url) {
  if (request.method === 'POST' && route.length === 2 && route[1] === 'generate-mosaic') {
    const input = await readJson(request);
    const prefix = stringValue(input.prefix, 'prefix');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(prefix)) {
      throw new HttpError('prefix must contain only lowercase letters, numbers, and hyphens', 400);
    }
    const count = positiveInteger(input.count, 'count');
    if (count !== 16) throw new HttpError('count must be 16', 400);
    const generated = generateOrganicMosaic({ prefix, count }).map((candidate) =>
      validateLandlet({ ...candidate, status: 'generating', ownerBuilderId: null }, candidate.landletId));

    // The mosaic template always covers the world origin as part of its
    // 16-cell disc (organicLandGenerator.js only rotates it, never
    // translates it) — the same point 'starter-landlet' sits on. Rather than
    // inserting a competing candidate there, the cell containing the origin
    // becomes starter-landlet's own shape directly, so there's exactly one
    // polygon at the center instead of two independently-placed ones.
    const centralIndex = generated.findIndex((candidate) => pointInPolygon(
      { x: 0, y: 0 },
      candidate.polygon.map((point) => ({ x: point.x + candidate.center.x, y: point.y + candidate.center.y })),
    ));
    if (centralIndex === -1) throw new HttpError('Generated mosaic does not cover the world origin', 500);
    const central = generated[centralIndex];
    const landlets = generated.filter((_candidate, index) => index !== centralIndex);

    const rows = landlets.map(candidateRowFromLandlet);
    const centralRow = candidateRowFromLandlet(central);
    const duplicate = await db.prepare(`
      SELECT landlet_id FROM landlet_candidates
      WHERE landlet_id >= ? AND landlet_id <= ? LIMIT 1
    `).bind(`${prefix}-001`, `${prefix}-999`).first();
    if (duplicate) throw new HttpError('Land candidate already exists', 409);

    // Safety net beyond the origin cell handled above: two mosaic calls (or
    // a mosaic call landing near existing ring-generated land) would
    // otherwise silently overlap, since this generator has no radial
    // structure for a band-based check like generate-ring's to work with.
    const [existingLandlets, existingCandidates] = await Promise.all([
      db.prepare("SELECT center_x_m, center_y_m, polygon_json FROM landlets WHERE landlet_id <> 'starter-landlet'").all(),
      db.prepare('SELECT center_x_m, center_y_m, polygon_json FROM landlet_candidates').all(),
    ]);
    const existingPolygons = [...existingLandlets.results, ...existingCandidates.results]
      .map(landletWorldPolygon)
      .filter((polygon) => polygon.length >= 3);
    const newPolygons = [...rows, centralRow].map(landletWorldPolygon);
    const conflict = newPolygons.some((polygon) => existingPolygons.some((other) => polygonsOverlap(polygon, other)));
    if (conflict) throw new HttpError('Generated mosaic would overlap existing land', 409);

    const settings = await getWorldSettings(db);
    const overlapping = rows.filter((row) => landletMinWorldRadius(row) <= settings.radius_m);
    // Every other cell in the mosaic reaches greenbelt/claimable the normal
    // way: materialize as 'generating' (candidateMaterializationStatements,
    // above), then a later generation-complete/world-expand call promotes
    // it once it's enclosed. starter-landlet already exists as a landlet
    // row rather than a fresh candidate, so it skips that pipeline
    // entirely — this mirrors the same "enclosed -> greenbelt, claimable
    // now" transition directly, rather than leaving it stuck at whatever
    // status it already had (historically 'claimed' with no owner, from
    // the seed row in 0001_initial.sql — permanently unclaimable and
    // invisible to the builder-delete release logic, which matches by
    // owner_builder_id). Guarded on owner_builder_id IS NULL so a
    // genuinely-claimed center plot is never clobbered.
    const centralEnclosed = landletMaxWorldRadius(centralRow) <= settings.radius_m;
    await db.batch([
      db.prepare(`
        UPDATE landlets
        SET center_x_m = ?, center_y_m = ?, polygon_json = ?, metadata_json = ?,
            generated_at = COALESCE(generated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            status = CASE WHEN owner_builder_id IS NULL AND ? THEN 'greenbelt' ELSE status END,
            claimable_at = CASE
              WHEN owner_builder_id IS NULL AND ? THEN COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
              ELSE claimable_at
            END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = 'starter-landlet'
      `).bind(
        central.center.x, central.center.y, centralRow.polygon_json, centralRow.metadata_json,
        centralEnclosed ? 1 : 0, centralEnclosed ? 1 : 0,
      ),
      ...rows.map((row) => candidateInsertStatement(db, row)),
      ...candidateMaterializationStatements(db, overlapping),
    ]);
    const stored = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id >= ? AND landlet_id <= ? ORDER BY landlet_id
    `).bind(`${prefix}-001`, `${prefix}-999`).all();
    return json({
      candidates: stored.results.map(candidateFromRow),
      materializedLandletIds: overlapping.map((row) => row.landlet_id),
      starterLandletId: 'starter-landlet',
    }, 201);
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'generate-ring') {
    const input = await readJson(request);
    const prefix = stringValue(input.prefix, 'prefix');
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(prefix)) {
      throw new HttpError('prefix must contain only lowercase letters, numbers, and hyphens', 400);
    }
    const count = positiveInteger(input.count, 'count');
    if (count < 3 || count > 100) throw new HttpError('count must be between 3 and 100', 400);
    const settings = await getWorldSettings(db);
    let innerRadiusM = input.innerRadiusM === undefined
      ? settings.radius_m
      : finiteNumber(input.innerRadiusM, 'innerRadiusM');
    let startAngleRad = input.startAngleRad === undefined ? 0 : finiteNumber(input.startAngleRad, 'startAngleRad');
    if (input.distribution !== undefined && input.distribution !== 'power-law') {
      throw new HttpError('distribution must be power-law', 400);
    }
    let distribution = input.distribution || null;
    let plots;
    let adjacentToRingId = null;
    if (input.adjacentToRingId !== undefined) {
      if (input.innerRadiusM !== undefined || input.startAngleRad !== undefined) {
        throw new HttpError('innerRadiusM and startAngleRad are derived when adjacentToRingId is used', 400);
      }
      adjacentToRingId = stringValue(input.adjacentToRingId, 'adjacentToRingId');
      const adjacentRing = await db.prepare('SELECT * FROM land_candidate_rings WHERE ring_id = ?')
        .bind(adjacentToRingId).first();
      if (!adjacentRing) throw new HttpError('Adjacent land candidate ring not found', 404);
      if (count !== adjacentRing.candidate_count) {
        throw new HttpError('count must match the adjacent ring candidate count', 400);
      }
      if (input.distribution !== undefined && input.distribution !== adjacentRing.distribution) {
        throw new HttpError('distribution must match the adjacent ring', 400);
      }
      const adjacentCandidates = await db.prepare(`
        SELECT * FROM landlet_candidates WHERE ring_id = ? ORDER BY landlet_id
      `).bind(adjacentToRingId).all();
      if (adjacentCandidates.results.length !== count) {
        throw new HttpError('Adjacent ring candidate membership is incomplete', 409);
      }
      innerRadiusM = adjacentRing.outer_radius_m;
      startAngleRad = adjacentRing.start_angle_rad;
      distribution = adjacentRing.distribution;
      plots = adjacentCandidates.results.map((row) => ({
        areaM2: row.area_m2,
        landClass: row.land_class,
        metadata: distribution ? { sizeDistribution: 'power-law-v1' } : {},
      }));
    } else if (distribution === 'power-law') {
      plots = powerLawPlots(count, prefix);
    }
    if (innerRadiusM < settings.radius_m) {
      throw new HttpError('innerRadiusM cannot be inside the current world radius', 400);
    }
    const generated = generateLandletRing({ prefix, count, innerRadiusM, startAngleRad, plots });
    const radialConflict = await db.prepare(`
      SELECT landlet_id FROM landlet_candidates
      WHERE min_world_radius_m < ? - 0.0000001
        AND (max_world_radius_m IS NULL OR max_world_radius_m > ? + 0.0000001)
      LIMIT 1
    `).bind(generated.outerRadiusM, innerRadiusM).first();
    if (radialConflict) {
      throw new HttpError('Generated ring would overlap existing land candidates', 409);
    }
    const landlets = generated.landlets.map((candidate) =>
      validateLandlet({ ...candidate, status: 'generating', ownerBuilderId: null }, candidate.landletId));
    const rows = landlets.map((landlet) => ({ ...candidateRowFromLandlet(landlet), ring_id: prefix }));
    const overlapping = rows.filter((row) => landletMinWorldRadius(row) <= settings.radius_m);
    await db.batch([
      db.prepare(`
        INSERT INTO land_candidate_rings
          (ring_id, inner_radius_m, outer_radius_m, candidate_count, distribution, start_angle_rad,
           boundary_signature, adjacent_to_ring_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        prefix, innerRadiusM, generated.outerRadiusM, count, distribution, startAngleRad,
        generated.boundarySignature, adjacentToRingId,
      ),
      ...rows.map((row) => candidateInsertStatement(db, row)),
      ...candidateMaterializationStatements(db, overlapping),
    ]);
    const storedCandidates = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE ring_id = ? ORDER BY created_at, landlet_id
    `).bind(prefix).all();
    return json({
      candidates: storedCandidates.results.map(candidateFromRow),
      materializedLandletIds: overlapping.map((row) => row.landlet_id),
      readyForGenerationCompletion: overlapping.length === rows.length,
      innerRadiusM,
      outerRadiusM: generated.outerRadiusM,
    }, 201);
  }

  if (request.method === 'GET' && route.length === 1) {
    const state = url.searchParams.get('state');
    if (state !== null && state !== 'pending' && state !== 'materialized') {
      throw new HttpError('state must be pending or materialized', 400);
    }
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    const ringIdParam = url.searchParams.get('ringId');
    if (ringIdParam !== null) {
      conditions.push('ring_id = ?');
      bindings.push(stringValue(ringIdParam, 'ringId'));
    }
    if (state) conditions.push(`materialized_at IS ${state === 'pending' ? '' : 'NOT '}NULL`);
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND landlet_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM landlet_candidates ${where}
      ORDER BY created_at, landlet_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      candidates: page.map(candidateFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.landlet_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM landlet_candidates WHERE landlet_id = ?').bind(route[1]).first();
    return row ? json({ candidate: candidateFromRow(row) }) : json({ error: 'Land candidate not found' }, 404);
  }

  if (request.method === 'DELETE' && route.length === 2) {
    const existing = await db.prepare(`
      SELECT materialized_at, ring_id FROM landlet_candidates WHERE landlet_id = ?
    `).bind(route[1]).first();
    if (!existing) throw new HttpError('Land candidate not found', 404);
    if (existing.ring_id) throw new HttpError('Generated ring candidates cannot be deleted individually', 409);
    if (existing.materialized_at) throw new HttpError('Materialized land candidates cannot be deleted', 409);
    const result = await db.prepare('DELETE FROM landlet_candidates WHERE landlet_id = ? AND materialized_at IS NULL')
      .bind(route[1]).run();
    if (result.meta.changes === 0) throw new HttpError('Land candidate started generation during deletion', 409);
    return json({ deleted: true });
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id = ?
    `).bind(route[1]).first();
    if (!existing) throw new HttpError('Land candidate not found', 404);
    if (existing.materialized_at) throw new HttpError('Materialized land candidates cannot be updated', 409);
    if (existing.ring_id) throw new HttpError('Generated ring candidates cannot be updated individually', 409);

    const input = await readJson(request);
    const candidate = candidateFromRow(existing);
    const landlet = validateLandlet({
      ...candidate,
      ...input,
      landletId: route[1],
      status: 'generating',
      ownerBuilderId: null,
    }, route[1]);
    const row = candidateRowFromLandlet(landlet);
    row.ring_id = existing.ring_id;
    const update = db.prepare(`
      UPDATE landlet_candidates
      SET name = ?, area_m2 = ?, center_x_m = ?, center_y_m = ?, land_class = ?,
          polygon_json = ?, metadata_json = ?, min_world_radius_m = ?, max_world_radius_m = ?
      WHERE landlet_id = ? AND materialized_at IS NULL
    `).bind(
      landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.landClass,
      JSON.stringify(landlet.polygon), JSON.stringify(landlet.metadata),
      landletMinWorldRadius(row), landletMaxWorldRadius(row), route[1],
    );
    const settings = await getWorldSettings(db);
    const started = landletMinWorldRadius(row) <= settings.radius_m;
    const results = await db.batch([
      update,
      ...(started ? candidateMaterializationStatements(db, [row]) : []),
    ]);
    if (results[0].meta.changes === 0) throw new HttpError('Land candidate started generation during update', 409);
    const updated = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id = ?
    `).bind(route[1]).first();
    const materialized = started ? await requireLandlet(db, route[1]) : null;
    return json({
      candidate: candidateFromRow(updated),
      landlet: materialized ? landletFromRow(materialized) : null,
    });
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.candidates)) throw new HttpError('candidates must be an array', 400);
    if (input.candidates.length === 0) throw new HttpError('candidates must contain at least one item', 400);
    if (input.candidates.length > 100) throw new HttpError('candidates must contain at most 100 items', 400);

    const landlets = input.candidates.map((candidate) =>
      validateLandlet({ ...candidate, status: 'generating', ownerBuilderId: null }, crypto.randomUUID()));
    const ids = new Set();
    for (const landlet of landlets) {
      if (ids.has(landlet.landletId)) throw new HttpError('landletId values must be unique', 400);
      ids.add(landlet.landletId);
    }

    const rows = landlets.map(candidateRowFromLandlet);
    const settings = await getWorldSettings(db);
    const overlapping = rows.filter((row) => landletMinWorldRadius(row) <= settings.radius_m);
    await db.batch([
      ...rows.map((row) => candidateInsertStatement(db, row)),
      ...candidateMaterializationStatements(db, overlapping),
    ]);
    const placeholders = landlets.map(() => '?').join(', ');
    const storedCandidates = await db.prepare(`
      SELECT * FROM landlet_candidates WHERE landlet_id IN (${placeholders}) ORDER BY created_at
    `).bind(...ids).all();
    const materializedLandlets = await db.prepare(`
      SELECT * FROM landlets WHERE landlet_id IN (${placeholders}) ORDER BY created_at
    `).bind(...ids).all();
    return json({
      candidates: storedCandidates.results.map(candidateFromRow),
      landlets: materializedLandlets.results.map(landletFromRow),
    }, 201);
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const landlet = validateLandlet({ ...input, status: 'generating', ownerBuilderId: null }, crypto.randomUUID());
    const row = candidateRowFromLandlet(landlet);
    const settings = await getWorldSettings(db);
    const started = landletMinWorldRadius(row) <= settings.radius_m;
    await db.batch([
      candidateInsertStatement(db, row),
      ...(started ? candidateMaterializationStatements(db, [row]) : []),
    ]);

    const candidate = await db.prepare('SELECT * FROM landlet_candidates WHERE landlet_id = ?').bind(landlet.landletId).first();
    const materialized = started ? await requireLandlet(db, landlet.landletId) : null;
    return json({ candidate: candidateFromRow(candidate), landlet: materialized ? landletFromRow(materialized) : null }, 201);
  }

  return json({ error: 'Not found' }, 404);
}

async function handleLandCandidateRings(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    const adjacentToRingIdParam = url.searchParams.get('adjacentToRingId');
    if (adjacentToRingIdParam !== null) {
      conditions.push('adjacent_to_ring_id = ?');
      bindings.push(stringValue(adjacentToRingIdParam, 'adjacentToRingId'));
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND ring_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM land_candidate_rings ${where}
      ORDER BY created_at, ring_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      rings: page.map(landCandidateRingFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.ring_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await getLandCandidateRingWithLifecycle(db, route[1]);
    return row
      ? json({ ring: landCandidateRingFromRow(row) })
      : json({ error: 'Land candidate ring not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'generation-complete') {
    const ringRow = await db.prepare(`
      SELECT * FROM land_candidate_rings WHERE ring_id = ?
    `).bind(route[1]).first();
    if (!ringRow) throw new HttpError('Land candidate ring not found', 404);

    const membership = await db.prepare(`
      SELECT COUNT(*) AS candidate_count,
        SUM(CASE WHEN materialized_at IS NOT NULL THEN 1 ELSE 0 END) AS materialized_count
      FROM landlet_candidates WHERE ring_id = ?
    `).bind(route[1]).first();
    if (membership.candidate_count !== ringRow.candidate_count
      || membership.materialized_count !== ringRow.candidate_count) {
      throw new HttpError('All ring candidates must be materialized before generation can complete', 409);
    }

    const settings = await getWorldSettings(db);
    await db.prepare(`
      UPDATE landlets
      SET generated_at = COALESCE(generated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          status = CASE WHEN max_world_radius_m <= ? THEN 'greenbelt' ELSE status END,
          claimable_at = CASE
            WHEN max_world_radius_m <= ? THEN COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ELSE claimable_at
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id IN (SELECT landlet_id FROM landlet_candidates WHERE ring_id = ?)
        AND status = 'generating'
    `).bind(settings.radius_m, settings.radius_m, route[1]).run();
    const completed = await db.prepare(`
      SELECT landlets.* FROM landlets
      JOIN landlet_candidates USING (landlet_id)
      WHERE landlet_candidates.ring_id = ? ORDER BY landlets.created_at, landlets.landlet_id
    `).bind(route[1]).all();
    const updatedRing = await getLandCandidateRingWithLifecycle(db, route[1]);
    return json({
      ring: landCandidateRingFromRow(updatedRing),
      landlets: completed.results.map(landletFromRow),
    });
  }

  return json({ error: 'Not found' }, 404);
}

async function getLandCandidateRingWithLifecycle(db, ringId) {
  return db.prepare(`
    SELECT ring.*,
      (SELECT child.ring_id FROM land_candidate_rings AS child
       WHERE child.adjacent_to_ring_id = ring.ring_id) AS adjacent_child_ring_id,
      COUNT(candidate.landlet_id) AS stored_candidate_count,
      SUM(CASE WHEN candidate.landlet_id IS NOT NULL AND candidate.materialized_at IS NULL THEN 1 ELSE 0 END) AS pending_candidate_count,
      SUM(CASE WHEN candidate.materialized_at IS NOT NULL THEN 1 ELSE 0 END) AS materialized_candidate_count,
      SUM(CASE WHEN landlet.generated_at IS NOT NULL THEN 1 ELSE 0 END) AS completed_landlet_count,
      SUM(CASE WHEN landlet.status = 'greenbelt' THEN 1 ELSE 0 END) AS greenbelt_landlet_count
    FROM land_candidate_rings AS ring
    LEFT JOIN landlet_candidates AS candidate ON candidate.ring_id = ring.ring_id
    LEFT JOIN landlets AS landlet ON landlet.landlet_id = candidate.landlet_id
    WHERE ring.ring_id = ? GROUP BY ring.ring_id
  `).bind(ringId).first();
}

function candidateRowFromLandlet(landlet) {
  return {
    landlet_id: landlet.landletId,
    name: landlet.name,
    area_m2: landlet.areaM2,
    center_x_m: landlet.center.x,
    center_y_m: landlet.center.y,
    land_class: landlet.landClass,
    polygon_json: JSON.stringify(landlet.polygon),
    metadata_json: JSON.stringify(landlet.metadata),
  };
}

function candidateInsertStatement(db, row) {
  return db.prepare(`
    INSERT INTO landlet_candidates
      (landlet_id, name, area_m2, center_x_m, center_y_m, land_class, polygon_json, metadata_json,
       min_world_radius_m, max_world_radius_m, ring_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.landlet_id, row.name, row.area_m2, row.center_x_m, row.center_y_m, row.land_class,
    row.polygon_json, row.metadata_json, landletMinWorldRadius(row), landletMaxWorldRadius(row), row.ring_id || null,
  );
}

async function handleWorld(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    const settings = await getWorldSettings(db);
    const counts = await getLandletCounts(db);
    return json({ world: worldFromRow(settings, counts) });
  }

  if (request.method === 'POST' && route.length === 2 && route[1] === 'expand') {
    const settings = await getWorldSettings(db);
    const countsBefore = await getLandletCounts(db);
    const total = countsBefore.total || 0;
    const greenbeltRatio = total === 0 ? 0 : (countsBefore.greenbelt || 0) / total;
    if (greenbeltRatio >= settings.greenbelt_min_ratio) {
      throw new HttpError('Greenbelt reserve is at or above the expansion threshold', 409);
    }

    const previousRadiusM = settings.radius_m;
    const newRadiusM = previousRadiusM + settings.expansion_increment_m;
    const { results } = await db.prepare(`
      SELECT * FROM landlets
      WHERE status = 'generating' AND generated_at IS NOT NULL
        AND (max_world_radius_m IS NULL OR max_world_radius_m <= ?)
    `).bind(newRadiusM).all();
    const enclosed = results.filter((row) => landletMaxWorldRadius(row) <= newRadiusM);
    const pending = await db.prepare(`
      SELECT * FROM landlet_candidates
      WHERE materialized_at IS NULL AND min_world_radius_m <= ?
    `).bind(newRadiusM).all();
    const overlapping = pending.results.filter((row) => landletMinWorldRadius(row) <= newRadiusM);
    await db.batch([
      db.prepare(`
        UPDATE world_settings
        SET radius_m = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE world_id = 'default-world'
      `).bind(newRadiusM),
      ...enclosed.map((row) => db.prepare(`
        UPDATE landlets
        SET status = 'greenbelt', claimable_at = COALESCE(claimable_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE landlet_id = ? AND status = 'generating'
      `).bind(row.landlet_id)),
      ...candidateMaterializationStatements(db, overlapping),
    ]);
    const touchedRingIds = [...new Set(overlapping.map((row) => row.ring_id).filter(Boolean))];
    let readyRingIds = [];
    if (touchedRingIds.length > 0) {
      const placeholders = touchedRingIds.map(() => '?').join(', ');
      const ready = await db.prepare(`
        SELECT candidate.ring_id FROM landlet_candidates AS candidate
        JOIN land_candidate_rings AS ring ON ring.ring_id = candidate.ring_id
        WHERE candidate.ring_id IN (${placeholders})
        GROUP BY candidate.ring_id, ring.candidate_count
        HAVING COUNT(*) = ring.candidate_count
          AND SUM(CASE WHEN candidate.materialized_at IS NOT NULL THEN 1 ELSE 0 END) = ring.candidate_count
        ORDER BY candidate.ring_id
      `).bind(...touchedRingIds).all();
      readyRingIds = ready.results.map((row) => row.ring_id);
    }

    const updated = await getWorldSettings(db);
    const countsAfter = await getLandletCounts(db);
    return json({
      world: worldFromRow(updated, countsAfter),
      expansion: {
        previousRadiusM,
        newRadiusM,
        incrementM: settings.expansion_increment_m,
        promotedLandletIds: enclosed.map((row) => row.landlet_id),
        startedGeneratingLandletIds: overlapping.map((row) => row.landlet_id),
        readyRingIds,
      },
    });
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 1) {
    const existing = await getWorldSettings(db);
    const input = await readJson(request);
    const world = validateWorld({ ...worldFromRow(existing), ...input });
    await db.prepare(`
      UPDATE world_settings
      SET radius_m = ?, expansion_increment_m = ?, greenbelt_min_ratio = ?, coordinate_rotation_deg = ?,
          day_cycle_hours = ?, metadata_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE world_id = 'default-world'
    `).bind(world.radiusM, world.expansionIncrementM, world.greenbeltMinRatio, world.coordinateRotationDeg, world.dayCycleHours, JSON.stringify(world.metadata)).run();
    const updated = await getWorldSettings(db);
    return json({ world: worldFromRow(updated) });
  }

  return json({ error: 'Not found' }, 404);
}

async function getWorldSettings(db) {
  const row = await db.prepare("SELECT * FROM world_settings WHERE world_id = 'default-world'").first();
  if (!row) throw new HttpError('World settings are not initialized', 500);
  return row;
}

async function getLandletCounts(db) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'greenbelt' THEN 1 ELSE 0 END) AS greenbelt,
      SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN status = 'generating' THEN 1 ELSE 0 END) AS generating
    FROM landlets
  `).first();
}

function candidateMaterializationStatements(db, candidates) {
  return candidates.flatMap((row) => [
    db.prepare(`
      INSERT INTO landlets
        (landlet_id, name, area_m2, center_x_m, center_y_m, status, owner_builder_id, land_class,
         polygon_json, generated_at, claimable_at, metadata_json, max_world_radius_m)
      VALUES (?, ?, ?, ?, ?, 'generating', NULL, ?, ?, NULL, NULL, ?, ?)
    `).bind(
      row.landlet_id, row.name, row.area_m2, row.center_x_m, row.center_y_m, row.land_class,
      row.polygon_json, row.metadata_json, landletMaxWorldRadius(row),
    ),
    db.prepare(`
      UPDATE landlet_candidates SET materialized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ? AND materialized_at IS NULL
    `).bind(row.landlet_id),
  ]);
}

async function explainClaimConflict(db, landletId, builderId) {
  const landlet = await db.prepare('SELECT status, owner_builder_id FROM landlets WHERE landlet_id = ?').bind(landletId).first();
  if (!landlet) throw new HttpError('Landlet not found', 404);
  if (landlet.status !== 'greenbelt' || landlet.owner_builder_id !== null) {
    throw new HttpError('Landlet is not available to claim', 409);
  }

  const owned = await db.prepare("SELECT landlet_id FROM landlets WHERE owner_builder_id = ? AND status = 'claimed' LIMIT 1").bind(builderId).first();
  if (owned) throw new HttpError('Builder already owns a claimed landlet', 409);

  throw new HttpError('Landlet could not be claimed', 409);
}

async function handleInstances(request, db, route, url) {
  if (request.method === 'DELETE' && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.instanceIds)) throw new HttpError('instanceIds must be an array', 400);
    if (input.instanceIds.length === 0) throw new HttpError('instanceIds must contain at least one item', 400);
    if (input.instanceIds.length > 100) throw new HttpError('instanceIds must contain at most 100 items', 400);
    const instanceIds = input.instanceIds.map((id) => stringValue(id, 'instanceIds item'));
    if (new Set(instanceIds).size !== instanceIds.length) throw new HttpError('instanceIds must be unique', 400);
    const placeholders = instanceIds.map(() => '?').join(', ');
    const { results } = await db.prepare(`
      SELECT instance_id FROM placed_instances WHERE instance_id IN (${placeholders})
    `).bind(...instanceIds).all();
    if (results.length !== instanceIds.length) {
      throw new HttpError('Every instanceId must reference an existing placed instance', 404);
    }
    await db.batch(instanceIds.map((instanceId) => db.prepare(
      'DELETE FROM placed_instances WHERE instance_id = ?',
    ).bind(instanceId)));
    return json({ deletedInstanceIds: instanceIds });
  }

  if ((request.method === 'POST' || request.method === 'PUT') && route.length === 2 && route[1] === 'batch') {
    const input = await readJson(request);
    if (!Array.isArray(input.instances)) throw new HttpError('instances must be an array', 400);
    if (input.instances.length === 0) throw new HttpError('instances must contain at least one item', 400);
    if (input.instances.length > 100) throw new HttpError('instances must contain at most 100 items', 400);
    const instances = input.instances.map((item) => validateInstance(item, crypto.randomUUID()));
    const instanceIds = instances.map((instance) => instance.instanceId);
    if (new Set(instanceIds).size !== instanceIds.length) {
      throw new HttpError('instanceId values must be unique', 400);
    }
    await assertReferencesExist(db, 'catalog_templates', 'template_id', instances.map((instance) => instance.templateId), 'templateId');
    await assertReferencesExist(db, 'landlets', 'landlet_id', instances.map((instance) => instance.landletId), 'landletId');
    await assertCropWithinTemplateBounds(db, instances);
    const conflictClause = request.method === 'PUT' ? `
      ON CONFLICT(instance_id) DO UPDATE SET
        landlet_id = excluded.landlet_id, template_id = excluded.template_id,
        x_m = excluded.x_m, y_m = excluded.y_m, z_m = excluded.z_m,
        rotation_x_rad = excluded.rotation_x_rad, rotation_y_rad = excluded.rotation_y_rad,
        rotation_z_rad = excluded.rotation_z_rad, label = excluded.label, crop_json = excluded.crop_json,
        scale = excluded.scale, is_community_sign = excluded.is_community_sign,
        is_community_calendar = excluded.is_community_calendar,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ` : '';
    await db.batch(instances.map((instance) => db.prepare(`
      INSERT INTO placed_instances
        (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ${conflictClause}
    `).bind(...instanceParams(instance))));
    const stored = await getInstancesById(db, instanceIds);
    return json({ instances: instanceIds.map((instanceId) => stored.get(instanceId)) }, request.method === 'POST' ? 201 : 200);
  }

  if (request.method === 'GET' && route.length === 1) {
    const landletIdParam = url.searchParams.get('landletId');
    const landletId = landletIdParam === null ? 'starter-landlet' : stringValue(landletIdParam, 'landletId');
    const templateIdParam = url.searchParams.get('templateId');
    const templateId = templateIdParam === null ? null : stringValue(templateIdParam, 'templateId');
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = ['landlet_id = ?'];
    const bindings = [landletId];
    if (templateId) {
      conditions.push('template_id = ?');
      bindings.push(templateId);
    }
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND instance_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    bindings.push(limit + 1);
    const { results } = await db.prepare(`
      SELECT * FROM placed_instances
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at, instance_id LIMIT ?
    `).bind(...bindings).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      instances: page.map(instanceFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.instance_id) : null,
    });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    return row ? json({ instance: instanceFromRow(row) }) : json({ error: 'Instance not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const instance = validateInstance(input, crypto.randomUUID());
    await assertReferenceExists(db, 'catalog_templates', 'template_id', instance.templateId, 'templateId');
    await assertReferenceExists(db, 'landlets', 'landlet_id', instance.landletId, 'landletId');
    await assertCropWithinTemplateBounds(db, [instance]);
    await db.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label, crop_json, scale, is_community_sign, is_community_calendar)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(instance.instanceId, instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationX, instance.rotationY, instance.rotationZ, instance.label, JSON.stringify(instance.crop), instance.scale, instance.isCommunitySign ? 1 : 0, instance.isCommunityCalendar ? 1 : 0).run();
    const stored = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(instance.instanceId).first();
    return json({ instance: instanceFromRow(stored) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Instance not found' }, 404);
    const input = await readJson(request);
    const instance = validateInstance({ ...instanceFromRow(existing), ...input, instanceId: route[1] }, route[1]);
    await assertReferenceExists(db, 'catalog_templates', 'template_id', instance.templateId, 'templateId');
    await assertReferenceExists(db, 'landlets', 'landlet_id', instance.landletId, 'landletId');
    await assertCropWithinTemplateBounds(db, [instance]);
    await db.prepare(`
      UPDATE placed_instances
      SET landlet_id = ?, template_id = ?, x_m = ?, y_m = ?, z_m = ?, rotation_x_rad = ?, rotation_y_rad = ?, rotation_z_rad = ?, label = ?, crop_json = ?, scale = ?, is_community_sign = ?, is_community_calendar = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE instance_id = ?
    `).bind(instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationX, instance.rotationY, instance.rotationZ, instance.label, JSON.stringify(instance.crop), instance.scale, instance.isCommunitySign ? 1 : 0, instance.isCommunityCalendar ? 1 : 0, route[1]).run();
    const stored = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    return json({ instance: instanceFromRow(stored) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await db.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  if (route.length >= 3 && route[2] === 'posts') {
    return handleSignPosts(request, db, route);
  }

  if (route.length >= 3 && route[2] === 'events') {
    return handleCalendarEvents(request, db, route);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'purchase') {
    return handleInstancePurchase(request, db, route[1]);
  }

  return json({ error: 'Not found' }, 404);
}

// Posts on a "community sign" instance (docs/SPEC.md §6, migrations/0041) —
// nested under /instances/:id/posts rather than a top-level /sign-posts
// collection since a post never exists independent of the sign it's on,
// the same reasoning /landlets/:id/versions already follows. No ownership
// check on DELETE (moderation) — same no-real-auth caveat as every other
// dev-mode identity in this file (see handleBundles' own note); the
// frontend only shows a delete control to the sign's own landlet's
// builder.
async function handleSignPosts(request, db, route) {
  const instanceId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM sign_posts WHERE instance_id = ? ORDER BY created_at LIMIT 200
    `).bind(instanceId).all();
    return json({ posts: results.map(signPostFromRow) });
  }

  if (request.method === 'POST' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id, is_community_sign FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    if (!instance.is_community_sign) {
      throw new HttpError('This placed instance is not marked as a community sign', 400);
    }
    const input = await readJson(request);
    const authorLabel = stringValue(input.authorLabel, 'authorLabel');
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    const postId = `post-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO sign_posts (post_id, instance_id, author_label, text) VALUES (?, ?, ?, ?)
    `).bind(postId, instanceId, authorLabel, text).run();
    const row = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ?').bind(postId).first();
    return json({ post: signPostFromRow(row) }, 201);
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const postId = route[3];
    const existing = await db.prepare('SELECT * FROM sign_posts WHERE post_id = ? AND instance_id = ?').bind(postId, instanceId).first();
    if (!existing) return json({ error: 'Post not found' }, 404);
    await db.prepare('DELETE FROM sign_posts WHERE post_id = ?').bind(postId).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

function signPostFromRow(row) {
  return {
    postId: row.post_id,
    instanceId: row.instance_id,
    authorLabel: row.author_label,
    text: row.text,
    createdAt: row.created_at,
  };
}

// Events on a "community calendar" instance (docs/SPEC.md §6,
// migrations/0042) — structurally identical to handleSignPosts above
// (nested under /instances/:id/events for the same "never exists
// independent of its instance" reasoning, same no-ownership-check
// moderation caveat), deliberately kept as its own separate function and
// table rather than a shared "board" abstraction over both — see
// migrations/0042's own comment on why.
async function handleCalendarEvents(request, db, route) {
  const instanceId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    const { results } = await db.prepare(`
      SELECT * FROM calendar_events WHERE instance_id = ? ORDER BY created_at LIMIT 200
    `).bind(instanceId).all();
    return json({ events: results.map(calendarEventFromRow) });
  }

  if (request.method === 'POST' && route.length === 3) {
    const instance = await db.prepare('SELECT instance_id, is_community_calendar FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
    if (!instance) return json({ error: 'Instance not found' }, 404);
    if (!instance.is_community_calendar) {
      throw new HttpError('This placed instance is not marked as a community calendar', 400);
    }
    const input = await readJson(request);
    const authorLabel = stringValue(input.authorLabel, 'authorLabel');
    const text = stringValue(input.text, 'text');
    if (text.length > 280) throw new HttpError('text must be 280 characters or fewer', 400);
    // scheduledAt is optional — most events are just a plain announcement
    // (docs/SPEC.md §6's "event postings"), with a real one-shot trigger
    // moment (the spec's own "confetti-cannon" example) an explicit extra
    // step, not the default.
    const scheduledAt = input.scheduledAt === undefined || input.scheduledAt === null
      ? null
      : isoDateString(input.scheduledAt, 'scheduledAt');
    const eventId = `event-${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text, scheduled_at) VALUES (?, ?, ?, ?, ?)
    `).bind(eventId, instanceId, authorLabel, text, scheduledAt).run();
    const row = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ?').bind(eventId).first();
    return json({ event: calendarEventFromRow(row) }, 201);
  }

  if (request.method === 'DELETE' && route.length === 4) {
    const eventId = route[3];
    const existing = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ? AND instance_id = ?').bind(eventId, instanceId).first();
    if (!existing) return json({ error: 'Event not found' }, 404);
    await db.prepare('DELETE FROM calendar_events WHERE event_id = ?').bind(eventId).run();
    return json({ deleted: true });
  }

  // The one-shot creative-tool trigger itself (docs/API.md's "Community
  // calendar" — "scheduled confetti-cannon trigger"). Route:
  // /instances/:instanceId/events/:eventId/trigger, i.e. route =
  // ['instances', instanceId, 'events', eventId, 'trigger'] — route[3] is
  // the eventId here, one level deeper than DELETE's own route[3] above
  // (which IS the eventId for a 4-element route; this is a 5-element one).
  // Idempotent, like the auction resolve endpoint: calling it before
  // scheduledAt, on an event with no scheduledAt at all, or on one
  // already triggered is never an error, just a no-op — `triggered` in
  // the response tells the caller whether *this* call was the one that
  // actually fired it, since only that caller should play the effect
  // locally.
  if (request.method === 'POST' && route.length === 5 && route[4] === 'trigger') {
    return handleCalendarEventTrigger(db, instanceId, route[3]);
  }

  return json({ error: 'Not found' }, 404);
}

async function handleCalendarEventTrigger(db, instanceId, eventId) {
  const event = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ? AND instance_id = ?').bind(eventId, instanceId).first();
  if (!event) return json({ error: 'Event not found' }, 404);
  if (!event.scheduled_at || event.triggered_at || event.scheduled_at > new Date().toISOString()) {
    return json({ event: calendarEventFromRow(event), triggered: false });
  }
  await db.prepare(`
    UPDATE calendar_events SET triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE event_id = ? AND triggered_at IS NULL
  `).bind(eventId).run();
  const updated = await db.prepare('SELECT * FROM calendar_events WHERE event_id = ?').bind(eventId).first();
  // The WHERE ... triggered_at IS NULL guard above is what actually makes
  // this safe against a race (two callers both passing the earlier check
  // at once): only whichever UPDATE actually lands first flips the row,
  // and event.triggered_at is guaranteed null here (the early return
  // above already handled the already-triggered case), so a non-null
  // updated.triggered_at means this call is the one that just fired it.
  return json({ event: calendarEventFromRow(updated), triggered: updated.triggered_at !== null });
}

function calendarEventFromRow(row) {
  return {
    eventId: row.event_id,
    instanceId: row.instance_id,
    authorLabel: row.author_label,
    text: row.text,
    scheduledAt: row.scheduled_at,
    triggeredAt: row.triggered_at,
    createdAt: row.created_at,
  };
}

function isoDateString(value, field) {
  const text = stringValue(value, field);
  if (Number.isNaN(new Date(text).getTime())) {
    throw new HttpError(`${field} must be a valid date/time string`, 400);
  }
  return new Date(text).toISOString();
}

// Simulated purchases (docs/SPEC.md §5's "Universal commission formula,"
// migrations/0051) — see that migration's own comment for why this exists
// and why it is explicitly NOT real commerce (no real payment is ever
// processed; a shopper is charged nothing). This is the actual mechanism
// that credits a builder's dállers balance and land-cap-feeding earnings
// ledger when a shopper "buys" a product placed on their lándlet — the one
// concrete dáller-earning path docs/SPEC.md §5 treats as PRIMARY (auction
// sale proceeds, migrations/0045, are the only other one this backend
// implements).
const PURCHASE_COMMISSION_RATE = 0.02; // "2% standard for seller-listed products"
const PURCHASE_BUILDER_SPLIT = 0.5; // "Universal 50/50 split"
const PURCHASE_BUILDER_FLOOR_RATE = 0.005; // "0.5% floor protecting builders"

async function handleInstancePurchase(request, db, instanceId) {
  const instance = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(instanceId).first();
  if (!instance) return json({ error: 'Instance not found' }, 404);
  const template = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(instance.template_id).first();
  if (!template) return json({ error: 'Catalog template not found' }, 404);
  if (template.price_cents == null) {
    throw new HttpError('This product has no price set and cannot be purchased', 400);
  }
  const landlet = await db.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?').bind(instance.landlet_id).first();
  if (!landlet?.owner_builder_id) {
    throw new HttpError('This instance is not on a claimed lándlet, so there is no builder to credit', 400);
  }

  // quantity/buyerLabel are both genuinely optional, and this endpoint has
  // no other required fields, so a missing or empty body is just "buy one,
  // anonymously" rather than an error — read it directly instead of through
  // the shared readJson (which rejects a missing content-type/body).
  let input = {};
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const text = await request.text();
    if (text) {
      try {
        input = JSON.parse(text);
      } catch {
        throw new HttpError('Request body is not valid JSON', 400);
      }
    }
  }
  return finishPurchase(db, instance, template, landlet, input);
}

async function finishPurchase(db, instance, template, landlet, input) {
  const quantity = input.quantity === undefined ? 1 : positiveInteger(input.quantity, 'quantity');
  const buyerLabel = input.buyerLabel ? stringValue(input.buyerLabel, 'buyerLabel') : null;

  const unitPriceCents = template.price_cents;
  const totalCents = unitPriceCents * quantity;
  const commissionCents = Math.round(totalCents * PURCHASE_COMMISSION_RATE);
  const builderShareCents = Math.max(
    Math.round(commissionCents * PURCHASE_BUILDER_SPLIT),
    Math.round(totalCents * PURCHASE_BUILDER_FLOOR_RATE),
  );
  // The floor exists to protect the BUILDER, not to guarantee higglehaven's
  // own take — if it pushes the builder's share above the commission
  // itself (only possible on an unusually low commission rate), the
  // platform's own share is 0, never negative.
  const platformShareCents = Math.max(commissionCents - builderShareCents, 0);

  const purchaseId = `purchase-${crypto.randomUUID()}`;
  const builderId = landlet.owner_builder_id;
  await db.batch([
    db.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(purchaseId, instance.instance_id, template.template_id, builderId, template.seller_id, buyerLabel,
      unitPriceCents, quantity, totalCents, commissionCents, builderShareCents, platformShareCents),
    db.prepare('UPDATE builders SET dallers_balance_cents = dallers_balance_cents + ? WHERE builder_id = ?')
      .bind(builderShareCents, builderId),
    db.prepare('INSERT INTO daller_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
      .bind(`earnings-${crypto.randomUUID()}`, builderId, builderShareCents),
    notificationStatement(db, builderId,
      `"${template.name}" sold (${quantity}x, ${formatCents(totalCents)} total) — you earned ${formatCents(builderShareCents)} in commission dállers.`),
  ]);

  const row = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ purchase: purchaseFromRow(row) }, 201);
}

async function handlePurchases(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const builderId = url.searchParams.get('builderId');
    const templateId = url.searchParams.get('templateId');
    // builderId lists everything hosted on that builder's own land (their
    // "did I earn commission" view); templateId lists every sale of one
    // product across every builder who happens to host an instance of it
    // (the product's own seller's "did my product sell" view — see
    // "Simulated purchases" / "Refunds" in docs/API.md). Exactly one is
    // required; there's no "list everything" mode.
    if (builderId) {
      const { results } = await db.prepare(`
        SELECT * FROM purchases WHERE builder_id = ? ORDER BY created_at DESC LIMIT 100
      `).bind(stringValue(builderId, 'builderId')).all();
      return json({ purchases: results.map(purchaseFromRow) });
    }
    if (templateId) {
      const { results } = await db.prepare(`
        SELECT * FROM purchases WHERE template_id = ? ORDER BY created_at DESC LIMIT 100
      `).bind(stringValue(templateId, 'templateId')).all();
      return json({ purchases: results.map(purchaseFromRow) });
    }
    throw new HttpError('builderId or templateId is required', 400);
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'refund') {
    return handlePurchaseRefund(db, route[1]);
  }

  return json({ error: 'Not found' }, 404);
}

// Refund + dáller-commission clawback (migrations/0052_purchase_refunds.sql
// — see its own comment for why only dallers_balance_cents is touched, not
// daller_earnings_events/land cap). Reachable from the Seller modal's own
// "Sales" panel on the product being refunded — a seller-initiated action
// (standing in for a real customer-service-initiated refund, per
// docs/SPEC.md §6's no-personal-support-contact policy), not shopper
// self-service, since shoppers have no account here to authenticate a
// "my purchases" view against in the first place.
async function handlePurchaseRefund(db, purchaseId) {
  const purchase = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  if (!purchase) return json({ error: 'Purchase not found' }, 404);
  if (purchase.refunded_at) {
    throw new HttpError('This purchase has already been refunded', 400);
  }
  const template = await db.prepare('SELECT name, metadata_json FROM catalog_templates WHERE template_id = ?')
    .bind(purchase.template_id).first();
  if (template && JSON.parse(template.metadata_json || '{}').noReturns) {
    throw new HttpError('This product\'s seller does not accept returns', 400);
  }
  const templateName = template?.name || 'A product';

  await db.batch([
    db.prepare(`UPDATE purchases SET refunded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE purchase_id = ?`)
      .bind(purchaseId),
    db.prepare('UPDATE builders SET dallers_balance_cents = dallers_balance_cents - ? WHERE builder_id = ?')
      .bind(purchase.builder_share_cents, purchase.builder_id),
    notificationStatement(db, purchase.builder_id,
      `"${templateName}" purchase refunded — ${formatCents(purchase.builder_share_cents)} commission clawed back.`),
  ]);

  const row = await db.prepare('SELECT * FROM purchases WHERE purchase_id = ?').bind(purchaseId).first();
  return json({ purchase: purchaseFromRow(row) });
}

function purchaseFromRow(row) {
  return {
    purchaseId: row.purchase_id,
    instanceId: row.instance_id,
    templateId: row.template_id,
    builderId: row.builder_id,
    sellerId: row.seller_id,
    buyerLabel: row.buyer_label,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    totalCents: row.total_cents,
    commissionCents: row.commission_cents,
    builderShareCents: row.builder_share_cents,
    platformShareCents: row.platform_share_cents,
    createdAt: row.created_at,
    refundedAt: row.refunded_at,
  };
}

function routePath(pathname) {
  return pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError('Expected application/json request body', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError('Request body is not valid JSON', 400);
  }
}

// placed_instances/catalog_templates FK columns otherwise surface a
// nonexistent reference as a raw SQLite constraint failure — caught by
// databaseHttpError below as a generic 409, instead of a clean, specific
// 400 pinpointing which field was bad. Checked up front here so this one
// well-trodden path (placing/moving an instance) keeps its precise message;
// newer routes (landlets/versions/candidates) rely on databaseHttpError
// alone rather than duplicating a pre-check per reference.
async function assertReferenceExists(db, table, column, value, field) {
  const row = await db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).bind(value).first();
  if (!row) throw new HttpError(`${field} "${value}" does not exist`, 400);
}

async function assertReferencesExist(db, table, column, values, field) {
  const uniqueValues = [...new Set(values)];
  const placeholders = uniqueValues.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT ${column} AS value FROM ${table} WHERE ${column} IN (${placeholders})`,
  ).bind(...uniqueValues).all();
  const found = new Set(results.map((row) => row.value));
  const missing = uniqueValues.find((value) => !found.has(value));
  if (missing !== undefined) throw new HttpError(`${field} "${missing}" does not exist`, 400);
}

// Confirms every instance's crop overrides actually reference an axis the
// instance's template declared extensible (via metadata.extensible, see
// validateTemplate) and fall within that axis's [minM, template's own max
// dimension for that axis] range. Runs after the FK checks that already
// guarantee templateId exists, so a missing template here would only
// happen for an instance with no crop at all (skipped) or a genuine race.
async function assertCropWithinTemplateBounds(db, instances) {
  const withCrop = instances.filter((instance) => Object.keys(instance.crop).length > 0);
  if (withCrop.length === 0) return;
  const templateIds = [...new Set(withCrop.map((instance) => instance.templateId))];
  const placeholders = templateIds.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT * FROM catalog_templates WHERE template_id IN (${placeholders})`,
  ).bind(...templateIds).all();
  const templatesById = new Map(results.map((row) => [row.template_id, templateFromRow(row)]));
  const dimensionKeyByAxis = { x: 'width', y: 'depth', z: 'height' };
  for (const instance of withCrop) {
    const template = templatesById.get(instance.templateId);
    if (!template) continue;
    for (const [axis, length] of Object.entries(instance.crop)) {
      const extensible = template.metadata?.extensible?.[axis];
      if (!extensible) {
        throw new HttpError(`Template "${instance.templateId}" is not extensible along "${axis}"`, 400);
      }
      const maxLength = template.dimensions[dimensionKeyByAxis[axis]];
      if (length < extensible.minM || length > maxLength) {
        throw new HttpError(
          `crop.${axis} for template "${instance.templateId}" must be between ${extensible.minM} and ${maxLength}`,
          400,
        );
      }
    }
  }
}

async function getInstancesById(db, instanceIds) {
  const placeholders = instanceIds.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    SELECT * FROM placed_instances WHERE instance_id IN (${placeholders})
  `).bind(...instanceIds).all();
  return new Map(results.map((row) => [row.instance_id, instanceFromRow(row)]));
}

// Fallback classifier for constraint violations that reach D1 without an
// explicit pre-check (e.g. a duplicate catalog templateId, a landlet claim
// race, a version_number collision) — turns an otherwise-opaque 500 into a
// clean 4xx. Checked only after `HttpError` in the top-level catch, so
// routes with a more specific pre-check (assertReferenceExists above) keep
// their own message instead of falling through to this generic one.
function databaseHttpError(error) {
  const message = errorMessages(error);

  if (message.includes('UNIQUE constraint failed: landlets.owner_builder_id')) {
    return new HttpError('Builder already owns a claimed landlet', 409);
  }
  if (message.includes('UNIQUE constraint failed')) {
    return new HttpError('Resource already exists', 409);
  }
  if (message.includes('generated ring radial overlap')) {
    return new HttpError('Generated ring would overlap existing generated rings', 409);
  }
  if (message.includes('generated ring boundary mismatch')) {
    return new HttpError('Adjacent generated rings must use matching boundary seams', 409);
  }
  if (message.includes('generated ring adjacency parent mismatch')) {
    return new HttpError('Adjacent ring does not match its parent reservation', 409);
  }
  if (message.includes('generated ring candidates are immutable')) {
    return new HttpError('Generated ring candidates cannot be changed individually', 409);
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new HttpError('Referenced resource does not exist or is still in use', 409);
  }
  if (message.includes('CHECK constraint failed') || message.includes('NOT NULL constraint failed')) {
    return new HttpError('Request violates a database constraint', 400);
  }

  return null;
}

function errorMessages(error) {
  const messages = [];
  let current = error;
  while (current && !messages.includes(current.message)) {
    if (typeof current.message === 'string') messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' ');
}

// Baseline prohibited-content policy (docs/SPEC.md §4: "Prohibited
// categories (baseline, eBay/Etsy-referenced): weapons capable of serious
// harm, controlled substances/paraphernalia, adult content,
// counterfeit/unauthorized trademarked goods, live animals."). A plain
// phrase blocklist checked against name/category/subcategory — not real
// content moderation (no image/AI review exists anywhere in this dev-mode
// backend), just the same "honest simplest form" baseline this project
// applies elsewhere. Deliberately phrase-based rather than single loose
// words ("firearm," not "gun" alone) to keep false positives low against a
// catalog that's mostly ordinary placeholder/furniture names.
const PROHIBITED_CONTENT_PHRASES = [
  'firearm', 'handgun', 'assault rifle', 'ammunition', 'explosive device',
  'illegal drug', 'narcotic', 'drug paraphernalia', 'cocaine', 'heroin', 'methamphetamine',
  'adult content', 'pornographic', 'explicit sexual content',
  'counterfeit', 'knockoff replica',
  'live animal', 'live pet sale',
];

function assertNotProhibitedContent(template) {
  const haystack = [template.name, template.category, template.subcategory]
    .filter(Boolean).join(' ').toLowerCase();
  const match = PROHIBITED_CONTENT_PHRASES.find((phrase) => haystack.includes(phrase));
  if (match) {
    throw new HttpError(`This listing appears to violate higglehaven's prohibited-categories policy (matched "${match}")`, 400);
  }
}

// Digital goods (docs/SPEC.md §4: "Digital goods — narrow, conditional
// exception ... permitted if the listing includes (a) a representative 3D
// model [already required of every template regardless] and (b) a clear
// higglehaven-controlled disclaimer of what's actually delivered."). The
// disclaimer text is platform-controlled, not seller-authored freeform
// text — a seller picks one of these fixed keys, not their own wording, so
// `metadata.digitalGoodDisclaimer` only ever stores the key. There is no
// separate "isDigitalGood" flag: a template is a digital good exactly when
// this key is present, the same single-flag-in-metadata simplicity as
// flooring (migrations/0035) and extensibility.
const DIGITAL_GOOD_DISCLAIMER_TEXT = {
  'gift-card': 'This is a digital gift card to a real business, delivered as a code — not a physical item.',
  'art-file': 'This is a digital art or print file, delivered as a download — not a physical item.',
  'software-tool': 'This is a higglehaven-ecosystem software tool, delivered as a download or activation — not a physical item.',
};

function assertValidDigitalGoodDisclaimer(metadata) {
  if (metadata.digitalGoodDisclaimer === undefined) return;
  if (!DIGITAL_GOOD_DISCLAIMER_TEXT[metadata.digitalGoodDisclaimer]) {
    throw new HttpError(`metadata.digitalGoodDisclaimer must be one of: ${Object.keys(DIGITAL_GOOD_DISCLAIMER_TEXT).join(', ')}`, 400);
  }
}

// "No-returns-policy respected as seller-set default" (docs/SPEC.md §5) —
// a seller-set flag on the product itself, same single-key-in-metadata
// simplicity as digitalGoodDisclaimer above. Absent/false means returns
// are accepted (the spec's own default), so this key is only ever written
// when a seller actively opts out.
function assertValidNoReturns(metadata) {
  if (metadata.noReturns === undefined) return;
  if (typeof metadata.noReturns !== 'boolean') {
    throw new HttpError('metadata.noReturns must be a boolean', 400);
  }
}

function validateTemplate(input, fallbackId) {
  const dimensions = input.dimensions || {};
  const template = {
    templateId: stringValue(input.templateId || fallbackId, 'templateId'),
    name: stringValue(input.name, 'name'),
    category: input.category || 'placeholder',
    subcategory: input.subcategory || null,
    color: stringValue(input.color, 'color'),
    dimensions: {
      width: positiveNumber(dimensions.width, 'dimensions.width'),
      depth: positiveNumber(dimensions.depth, 'dimensions.depth'),
      height: positiveNumber(dimensions.height, 'dimensions.height'),
    },
    priceCents: optionalInteger(input.priceCents, 'priceCents'),
    sellerId: input.sellerId || null,
    modelUrl: input.modelUrl || null,
    metadata: input.metadata || {},
  };
  JSON.stringify(template.metadata);
  assertNotProhibitedContent(template);
  assertValidDigitalGoodDisclaimer(template.metadata);
  assertValidNoReturns(template.metadata);
  return template;
}

function validateLandlet(input, fallbackId) {
  const center = input.center || {};
  const landlet = {
    landletId: stringValue(input.landletId || fallbackId, 'landletId'),
    name: stringValue(input.name, 'name'),
    areaM2: positiveNumber(input.areaM2, 'areaM2'),
    center: {
      x: finiteNumber(center.x ?? input.centerX ?? 0, 'center.x'),
      y: finiteNumber(center.y ?? input.centerY ?? 0, 'center.y'),
    },
    status: landletStatus(input.status || 'greenbelt'),
    ownerBuilderId: input.ownerBuilderId || null,
    landClass: positiveInteger(input.landClass ?? 1, 'landClass'),
    polygon: validatePolygon(input.polygon || []),
    generatedAt: input.generatedAt || null,
    claimableAt: input.claimableAt || null,
    activeVersionId: input.activeVersionId || null,
    metadata: input.metadata || {},
  };
  JSON.stringify(landlet.metadata);
  return landlet;
}

function validateWorld(input) {
  const world = {
    worldId: 'default-world',
    radiusM: finiteNumber(input.radiusM, 'radiusM'),
    expansionIncrementM: positiveNumber(input.expansionIncrementM, 'expansionIncrementM'),
    greenbeltMinRatio: ratioNumber(input.greenbeltMinRatio, 'greenbeltMinRatio'),
    coordinateRotationDeg: finiteNumber(input.coordinateRotationDeg, 'coordinateRotationDeg'),
    dayCycleHours: positiveNumber(input.dayCycleHours, 'dayCycleHours'),
    metadata: input.metadata || {},
  };
  if (world.radiusM < 0) throw new HttpError('radiusM must be zero or greater', 400);
  JSON.stringify(world.metadata);
  return world;
}

function validateInstance(input, fallbackId) {
  return {
    instanceId: stringValue(input.instanceId || input.id || fallbackId, 'instanceId'),
    landletId: stringValue(input.landletId || 'starter-landlet', 'landletId'),
    templateId: stringValue(input.templateId, 'templateId'),
    x: finiteNumber(input.x, 'x'),
    y: finiteNumber(input.y, 'y'),
    z: finiteNumber(input.z ?? 0, 'z'),
    rotationX: finiteNumber(input.rotationX ?? 0, 'rotationX'),
    rotationY: finiteNumber(input.rotationY ?? 0, 'rotationY'),
    rotationZ: finiteNumber(input.rotationZ ?? 0, 'rotationZ'),
    label: input.label || null,
    crop: validateCropShape(input.crop),
    scale: validateScale(input.scale),
    // docs/API.md's "Community signs" — per-*instance* opt-in (unlike
    // flooring's per-template metadata flag), since any single placement of
    // any product can become a sign independently of its other copies.
    isCommunitySign: input.isCommunitySign === true,
    // docs/API.md's "Community calendar" — same per-instance opt-in
    // reasoning as isCommunitySign, independent of it.
    isCommunityCalendar: input.isCommunityCalendar === true,
  };
}

// A real uniform Resize (see docs/API.md's "Frontend-only Resize"),
// entirely separate from crop's per-axis shortening — 1 means "rendered
// at the template's own declared size." Bounded (loosely) against zero,
// negative, and non-finite values reaching the database at all; the
// frontend applies its own tighter [0.001, 1000] clamp for what a drag or
// typed value can actually produce, so this is a backstop against a
// malformed request, not the real UX limit.
function validateScale(value) {
  if (value === undefined || value === null) return 1;
  return positiveNumber(value, 'scale');
}

// { x?: number, y?: number, z?: number } — how far a builder has cropped
// this instance down from its template's max size along each axis (see
// assertCropWithinTemplateBounds, which checks the values themselves
// against the template's declared extensible range once the referenced
// template is known).
function validateCropShape(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError('crop must be an object', 400);
  }
  const crop = {};
  for (const [axis, value] of Object.entries(input)) {
    if (!['x', 'y', 'z'].includes(axis)) {
      throw new HttpError(`crop key "${axis}" must be one of x, y, z`, 400);
    }
    crop[axis] = positiveNumber(value, `crop.${axis}`);
  }
  return crop;
}

function templateParams(template) {
  return [template.templateId, template.name, template.category, template.subcategory, template.color, template.dimensions.width, template.dimensions.depth, template.dimensions.height, template.priceCents, template.sellerId, template.modelUrl, JSON.stringify(template.metadata)];
}

function instanceParams(instance) {
  return [instance.instanceId, instance.landletId, instance.templateId, instance.x, instance.y,
    instance.z, instance.rotationX, instance.rotationY, instance.rotationZ, instance.label,
    JSON.stringify(instance.crop), instance.scale, instance.isCommunitySign ? 1 : 0,
    instance.isCommunityCalendar ? 1 : 0];
}

function landletParams(landlet) {
  return [landlet.landletId, landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.status, landlet.ownerBuilderId, landlet.landClass, JSON.stringify(landlet.polygon), landlet.generatedAt, landlet.claimableAt, JSON.stringify(landlet.metadata)];
}

function templateFromRow(row) {
  return {
    templateId: row.template_id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    color: row.color,
    dimensions: { width: row.width_m, depth: row.depth_m, height: row.height_m },
    priceCents: row.price_cents,
    sellerId: row.seller_id,
    modelUrl: row.model_url,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function instanceFromRow(row) {
  return {
    instanceId: row.instance_id,
    id: row.instance_id,
    landletId: row.landlet_id,
    templateId: row.template_id,
    x: row.x_m,
    y: row.y_m,
    z: row.z_m,
    rotationX: row.rotation_x_rad,
    rotationY: row.rotation_y_rad,
    rotationZ: row.rotation_z_rad,
    label: row.label,
    crop: JSON.parse(row.crop_json || '{}'),
    scale: row.scale,
    isCommunitySign: Boolean(row.is_community_sign),
    isCommunityCalendar: Boolean(row.is_community_calendar),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function landletFromRow(row) {
  return {
    landletId: row.landlet_id,
    name: row.name,
    areaM2: row.area_m2,
    center: { x: row.center_x_m, y: row.center_y_m },
    status: row.status,
    ownerBuilderId: row.owner_builder_id,
    landClass: row.land_class ?? 1,
    polygon: JSON.parse(row.polygon_json || '[]'),
    generatedAt: row.generated_at,
    claimableAt: row.claimable_at,
    activeVersionId: row.active_version_id || null,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function candidateFromRow(row) {
  return {
    landletId: row.landlet_id,
    name: row.name,
    areaM2: row.area_m2,
    center: { x: row.center_x_m, y: row.center_y_m },
    landClass: row.land_class,
    polygon: JSON.parse(row.polygon_json || '[]'),
    metadata: JSON.parse(row.metadata_json || '{}'),
    materializedAt: row.materialized_at,
    ringId: row.ring_id || null,
    createdAt: row.created_at,
  };
}

function landCandidateRingFromRow(row) {
  const ring = {
    ringId: row.ring_id,
    innerRadiusM: row.inner_radius_m,
    outerRadiusM: row.outer_radius_m,
    candidateCount: row.candidate_count,
    distribution: row.distribution,
    startAngleRad: row.start_angle_rad,
    adjacentToRingId: row.adjacent_to_ring_id || null,
    createdAt: row.created_at,
  };
  if (row.stored_candidate_count !== undefined) {
    ring.adjacentChildRingId = row.adjacent_child_ring_id || null;
    ring.lifecycle = {
      storedCandidates: row.stored_candidate_count || 0,
      pendingCandidates: row.pending_candidate_count || 0,
      materializedCandidates: row.materialized_candidate_count || 0,
      completedLandlets: row.completed_landlet_count || 0,
      greenbeltLandlets: row.greenbelt_landlet_count || 0,
    };
  }
  return ring;
}

function versionFromRow(row) {
  return {
    versionId: row.version_id,
    landletId: row.landlet_id,
    versionNumber: row.version_number,
    name: row.name,
    instanceCount: row.instance_count || 0,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
  };
}

function versionInstanceFromRow(row) {
  return {
    instanceId: row.source_instance_id,
    id: row.source_instance_id,
    templateId: row.template_id,
    x: row.x_m,
    y: row.y_m,
    z: row.z_m,
    rotationX: row.rotation_x_rad,
    rotationY: row.rotation_y_rad,
    rotationZ: row.rotation_z_rad,
    label: row.label,
    crop: JSON.parse(row.crop_json || '{}'),
    scale: row.scale,
  };
}

function worldFromRow(row, counts) {
  const totalLandlets = counts?.total || 0;
  const greenbeltLandlets = counts?.greenbelt || 0;
  return {
    worldId: row.world_id,
    radiusM: row.radius_m,
    expansionIncrementM: row.expansion_increment_m,
    greenbeltMinRatio: row.greenbelt_min_ratio,
    coordinateRotationDeg: row.coordinate_rotation_deg,
    dayCycleHours: row.day_cycle_hours,
    landletCounts: counts ? {
      total: totalLandlets,
      greenbelt: greenbeltLandlets,
      claimed: counts.claimed || 0,
      generating: counts.generating || 0,
      greenbeltRatio: totalLandlets === 0 ? 0 : greenbeltLandlets / totalLandlets,
    } : undefined,
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function landletStatus(value) {
  if (!['greenbelt', 'claimed', 'generating'].includes(value)) {
    throw new HttpError('status must be greenbelt, claimed, or generating', 400);
  }
  return value;
}

function validatePolygon(value) {
  if (!Array.isArray(value)) throw new HttpError('polygon must be an array', 400);
  return value.map((point, index) => {
    if (!point || typeof point !== 'object') throw new HttpError(`polygon[${index}] must be an object`, 400);
    return {
      x: finiteNumber(point.x, `polygon[${index}].x`),
      y: finiteNumber(point.y, `polygon[${index}].y`),
    };
  });
}

function ratioNumber(value, field) {
  const number = finiteNumber(value, field);
  if (number < 0 || number > 1) throw new HttpError(`${field} must be between 0 and 1`, 400);
  return number;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(`${field} must be a positive integer`, 400);
  return number;
}

function stringValue(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(`${field} is required`, 400);
  return value.trim();
}

function positiveNumber(value, field) {
  const number = finiteNumber(value, field);
  if (number <= 0) throw new HttpError(`${field} must be greater than zero`, 400);
  return number;
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(`${field} must be a finite number`, 400);
  return number;
}

function optionalInteger(value, field) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpError(`${field} must be a non-negative integer`, 400);
  return number;
}

function queryLimit(value, defaultValue) {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) throw new HttpError('limit must be an integer between 1 and 100', 400);
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new HttpError('limit must be an integer between 1 and 100', 400);
  return limit;
}

function queryNonnegativeInteger(value, field) {
  if (value === null) return null;
  const text = stringValue(value, field);
  if (!/^\d+$/.test(text)) throw new HttpError(`${field} must be a non-negative integer`, 400);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new HttpError(`${field} must be a non-negative integer`, 400);
  }
  return number;
}

function queryPositiveNumber(value, field) {
  if (value === null) return null;
  const text = stringValue(value, field);
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) {
    throw new HttpError(`${field} must be a positive number`, 400);
  }
  return number;
}

function encodeCursor(createdAt, id) {
  const bytes = new TextEncoder().encode(JSON.stringify([createdAt, id]));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string') throw new Error();
    return { createdAt: decoded[0], id: decoded[1] };
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

function encodeVersionCursor(versionNumber) {
  return btoa(String(versionNumber));
}

function decodeVersionCursor(value) {
  if (value === null) return null;
  try {
    const decoded = atob(value);
    if (!/^\d+$/.test(decoded)) throw new Error();
    const versionNumber = Number(decoded);
    if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0) throw new Error();
    return versionNumber;
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

function encodeCatalogCursor(name, templateId) {
  const bytes = new TextEncoder().encode(JSON.stringify([name, templateId]));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCatalogCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== 'string' || decoded[0] === '' ||
        typeof decoded[1] !== 'string' || decoded[1] === '') throw new Error();
    return { name: decoded[0], templateId: decoded[1] };
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

function encodeCatalogPriceCursor(priceCents, templateId) {
  const bytes = new TextEncoder().encode(JSON.stringify([priceCents, templateId]));
  return btoa(String.fromCharCode(...bytes));
}

function decodeCatalogPriceCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 2
      || !Number.isSafeInteger(decoded[0]) || decoded[0] < 0
      || typeof decoded[1] !== 'string' || decoded[1] === '') throw new Error();
    return { priceCents: decoded[0], templateId: decoded[1] };
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: JSON_HEADERS });
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
