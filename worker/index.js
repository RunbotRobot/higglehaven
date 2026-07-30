import { landletMaxWorldRadius, landletMinWorldRadius } from './geometry.js';

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

async function getTotalStorageBytes(bucket) {
  let total = 0;
  let cursor;
  do {
    const listing = await bucket.list({ cursor, limit: 1000 });
    for (const object of listing.objects) total += object.size;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return total;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
  const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/uploads\//, ''));
  const object = await env.MODELS.get(key);
  if (!object) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('access-control-allow-origin', '*');
  // Uploaded files are content-addressed-ish (random key per upload, never
  // overwritten in place — see handleModelUpload) and never change once
  // stored, so a long-lived cache is always safe.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
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

  if (route[0] === 'catalog') {
    return handleCatalog(request, env.DB, route, url);
  }

  if (route[0] === 'landlets') {
    return handleLandlets(request, env.DB, route, url);
  }

  if (route[0] === 'land-candidates') {
    return handleLandCandidates(request, env.DB, route);
  }

  if (route[0] === 'world') {
    return handleWorld(request, env.DB, route);
  }

  if (route[0] === 'instances') {
    return handleInstances(request, env.DB, route, url);
  }

  if (route[0] === 'models' && route.length === 1 && request.method === 'POST') {
    return handleModelUpload(request, env);
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

  const currentTotal = await getTotalStorageBytes(env.MODELS);
  const remainingBudget = MAX_TOTAL_STORAGE_BYTES - currentTotal;

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
  if (file.size > remainingBudget) {
    throw new HttpError(
      `File is ${formatBytes(file.size)}, but only ${formatBytes(Math.max(remainingBudget, 0))} of storage headroom is left (${formatBytes(MAX_TOTAL_STORAGE_BYTES)} total cap)`,
      507,
    );
  }

  const bytes = await file.arrayBuffer();
  validateGlb(bytes);

  const key = `models/${crypto.randomUUID()}.glb`;
  await env.MODELS.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
  return json({ modelUrl: `/uploads/${key}`, sourceName: file.name || 'model.glb', sizeBytes: bytes.byteLength }, 201);
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

async function handleCatalog(request, db, route, url) {
  if (request.method === 'GET' && route.length === 1) {
    const category = url.searchParams.get('category');
    const statement = category
      ? db.prepare('SELECT * FROM catalog_templates WHERE category = ? ORDER BY name').bind(category)
      : db.prepare('SELECT * FROM catalog_templates ORDER BY name');
    const { results } = await statement.all();
    return json({ templates: results.map(templateFromRow) });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM catalog_templates WHERE template_id = ?').bind(route[1]).first();
    return row ? json({ template: templateFromRow(row) }) : json({ error: 'Catalog template not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const template = validateTemplate(input, crypto.randomUUID());
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
    await db.prepare(`
      UPDATE catalog_templates
      SET name = ?, category = ?, subcategory = ?, color = ?, width_m = ?, depth_m = ?, height_m = ?,
          price_cents = ?, seller_id = ?, model_url = ?, metadata_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE template_id = ?
    `).bind(template.name, template.category, template.subcategory, template.color, template.dimensions.width, template.dimensions.depth, template.dimensions.height, template.priceCents, template.sellerId, template.modelUrl, JSON.stringify(template.metadata), route[1]).run();
    return json({ template });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await db.prepare('DELETE FROM catalog_templates WHERE template_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
}

async function handleLandletVersions(request, db, route) {
  const landletId = route[1];

  if (request.method === 'GET' && route.length === 3) {
    await requireLandlet(db, landletId);
    const { results } = await db.prepare(`
      SELECT v.*, COUNT(i.source_instance_id) AS instance_count
      FROM landlet_versions v
      LEFT JOIN version_instances i ON i.version_id = v.version_id
      WHERE v.landlet_id = ?
      GROUP BY v.version_id
      ORDER BY v.version_number DESC
    `).bind(landletId).all();
    return json({ versions: results.map(versionFromRow) });
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
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label)
        SELECT ?, instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label
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

async function handleLandlets(request, db, route, url) {
  if (route.length >= 3 && route[2] === 'versions') {
    return handleLandletVersions(request, db, route);
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
    const ownerBuilderId = url.searchParams.get('ownerBuilderId');
    let statement;

    if (status && ownerBuilderId) {
      statement = db.prepare('SELECT * FROM landlets WHERE status = ? AND owner_builder_id = ? ORDER BY created_at').bind(status, ownerBuilderId);
    } else if (status) {
      statement = db.prepare('SELECT * FROM landlets WHERE status = ? ORDER BY created_at').bind(status);
    } else if (ownerBuilderId) {
      statement = db.prepare('SELECT * FROM landlets WHERE owner_builder_id = ? ORDER BY created_at').bind(ownerBuilderId);
    } else {
      statement = db.prepare('SELECT * FROM landlets ORDER BY created_at');
    }

    const { results } = await statement.all();
    return json({ landlets: results.map(landletFromRow) });
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
    }

    const row = await db.prepare('SELECT * FROM landlets WHERE landlet_id = ?').bind(route[1]).first();
    return json({ landlet: landletFromRow(row) });
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const landlet = validateLandlet(input, crypto.randomUUID());
    await db.prepare(`
      INSERT INTO landlets
        (landlet_id, name, area_m2, center_x_m, center_y_m, status, owner_builder_id, land_class, polygon_json, generated_at, claimable_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...landletParams(landlet)).run();
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
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE landlet_id = ?
    `).bind(landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.status, landlet.ownerBuilderId, landlet.landClass, JSON.stringify(landlet.polygon), landlet.generatedAt, landlet.claimableAt, JSON.stringify(landlet.metadata), route[1]).run();
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

    const versionId = crypto.randomUUID();
    const versionName = input.versionName === undefined ? null : stringValue(input.versionName, 'versionName');
    const versionMetadata = input.versionMetadata || {};
    JSON.stringify(versionMetadata);

    await db.batch([
      db.prepare('DELETE FROM placed_instances WHERE landlet_id = ?').bind(landletId),
      db.prepare(`
        INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label)
        SELECT
          json_extract(value, '$.instanceId'), ?, json_extract(value, '$.templateId'),
          json_extract(value, '$.x'), json_extract(value, '$.y'), json_extract(value, '$.z'),
          json_extract(value, '$.rotationX'), json_extract(value, '$.rotationY'), json_extract(value, '$.rotationZ'),
          json_extract(value, '$.label')
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
          (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label)
        SELECT ?, instance_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label
        FROM placed_instances WHERE landlet_id = ?
      `).bind(versionId, landletId),
    ]);

    const { results } = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? ORDER BY created_at').bind(landletId).all();
    const version = await getVersion(db, landletId, versionId);
    return json({ instances: results.map(instanceFromRow), version });
  }

  return json({ error: 'Not found' }, 404);
}

async function handleLandCandidates(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    const { results } = await db.prepare('SELECT * FROM landlet_candidates ORDER BY created_at').all();
    return json({ candidates: results.map(candidateFromRow) });
  }

  if (request.method === 'GET' && route.length === 2) {
    const row = await db.prepare('SELECT * FROM landlet_candidates WHERE landlet_id = ?').bind(route[1]).first();
    return row ? json({ candidate: candidateFromRow(row) }) : json({ error: 'Land candidate not found' }, 404);
  }

  if (request.method === 'POST' && route.length === 1) {
    const input = await readJson(request);
    const landlet = validateLandlet({ ...input, status: 'generating', ownerBuilderId: null }, crypto.randomUUID());
    const row = {
      landlet_id: landlet.landletId,
      name: landlet.name,
      area_m2: landlet.areaM2,
      center_x_m: landlet.center.x,
      center_y_m: landlet.center.y,
      land_class: landlet.landClass,
      polygon_json: JSON.stringify(landlet.polygon),
      metadata_json: JSON.stringify(landlet.metadata),
    };
    const settings = await getWorldSettings(db);
    const started = landletMinWorldRadius(row) <= settings.radius_m;
    await db.batch([
      db.prepare(`
      INSERT INTO landlet_candidates
        (landlet_id, name, area_m2, center_x_m, center_y_m, land_class, polygon_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(row.landlet_id, row.name, row.area_m2, row.center_x_m, row.center_y_m, row.land_class, row.polygon_json, row.metadata_json),
      ...(started ? candidateMaterializationStatements(db, [row]) : []),
    ]);

    const candidate = await db.prepare('SELECT * FROM landlet_candidates WHERE landlet_id = ?').bind(landlet.landletId).first();
    const materialized = started ? await requireLandlet(db, landlet.landletId) : null;
    return json({ candidate: candidateFromRow(candidate), landlet: materialized ? landletFromRow(materialized) : null }, 201);
  }

  return json({ error: 'Not found' }, 404);
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
    const { results } = await db.prepare("SELECT * FROM landlets WHERE status = 'generating' AND generated_at IS NOT NULL").all();
    const enclosed = results.filter((row) => landletMaxWorldRadius(row) <= newRadiusM);
    const pending = await db.prepare('SELECT * FROM landlet_candidates WHERE materialized_at IS NULL').all();
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
         polygon_json, generated_at, claimable_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, 'generating', NULL, ?, ?, NULL, NULL, ?)
    `).bind(row.landlet_id, row.name, row.area_m2, row.center_x_m, row.center_y_m, row.land_class, row.polygon_json, row.metadata_json),
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
  if (request.method === 'GET' && route.length === 1) {
    const landletId = url.searchParams.get('landletId') || 'starter-landlet';
    const { results } = await db.prepare('SELECT * FROM placed_instances WHERE landlet_id = ? ORDER BY created_at').bind(landletId).all();
    return json({ instances: results.map(instanceFromRow) });
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
    await db.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_x_rad, rotation_y_rad, rotation_z_rad, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(instance.instanceId, instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationX, instance.rotationY, instance.rotationZ, instance.label).run();
    return json({ instance }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    const existing = await db.prepare('SELECT * FROM placed_instances WHERE instance_id = ?').bind(route[1]).first();
    if (!existing) return json({ error: 'Instance not found' }, 404);
    const input = await readJson(request);
    const instance = validateInstance({ ...instanceFromRow(existing), ...input, instanceId: route[1] }, route[1]);
    await assertReferenceExists(db, 'catalog_templates', 'template_id', instance.templateId, 'templateId');
    await assertReferenceExists(db, 'landlets', 'landlet_id', instance.landletId, 'landletId');
    await db.prepare(`
      UPDATE placed_instances
      SET landlet_id = ?, template_id = ?, x_m = ?, y_m = ?, z_m = ?, rotation_x_rad = ?, rotation_y_rad = ?, rotation_z_rad = ?, label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE instance_id = ?
    `).bind(instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationX, instance.rotationY, instance.rotationZ, instance.label, route[1]).run();
    return json({ instance });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await db.prepare('DELETE FROM placed_instances WHERE instance_id = ?').bind(route[1]).run();
    return json({ deleted: true });
  }

  return json({ error: 'Not found' }, 404);
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
    landletId: input.landletId || 'starter-landlet',
    templateId: stringValue(input.templateId, 'templateId'),
    x: finiteNumber(input.x, 'x'),
    y: finiteNumber(input.y, 'y'),
    z: finiteNumber(input.z ?? 0, 'z'),
    rotationX: finiteNumber(input.rotationX ?? 0, 'rotationX'),
    rotationY: finiteNumber(input.rotationY ?? 0, 'rotationY'),
    rotationZ: finiteNumber(input.rotationZ ?? 0, 'rotationZ'),
    label: input.label || null,
  };
}

function templateParams(template) {
  return [template.templateId, template.name, template.category, template.subcategory, template.color, template.dimensions.width, template.dimensions.depth, template.dimensions.height, template.priceCents, template.sellerId, template.modelUrl, JSON.stringify(template.metadata)];
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
    createdAt: row.created_at,
  };
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: JSON_HEADERS });
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
