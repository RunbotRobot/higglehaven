const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url).catch((error) => {
        console.error(error);
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        return json({ error: 'Internal server error' }, 500);
      });
    }

    return env.ASSETS.fetch(request);
  },
};

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

  if (route[0] === 'instances') {
    return handleInstances(request, env.DB, route, url);
  }

  return json({ error: 'Not found' }, 404);
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
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, z_m, rotation_z_rad, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(instance.instanceId, instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationZ, instance.label).run();
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
      SET landlet_id = ?, template_id = ?, x_m = ?, y_m = ?, z_m = ?, rotation_z_rad = ?, label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE instance_id = ?
    `).bind(instance.landletId, instance.templateId, instance.x, instance.y, instance.z, instance.rotationZ, instance.label, route[1]).run();
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

// placed_instances has FK columns for landlet_id/template_id, but a
// nonexistent reference otherwise surfaces as a raw SQLite constraint
// failure — caught by the generic top-level handler as an opaque 500
// instead of a useful 400. Checking existence up front gives a clear error
// instead of the client needing to reverse-engineer a database error.
async function assertReferenceExists(db, table, column, value, field) {
  const row = await db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).bind(value).first();
  if (!row) throw new HttpError(`${field} "${value}" does not exist`, 400);
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

function validateInstance(input, fallbackId) {
  return {
    instanceId: stringValue(input.instanceId || input.id || fallbackId, 'instanceId'),
    landletId: input.landletId || 'starter-landlet',
    templateId: stringValue(input.templateId, 'templateId'),
    x: finiteNumber(input.x, 'x'),
    y: finiteNumber(input.y, 'y'),
    z: finiteNumber(input.z ?? 0, 'z'),
    rotationZ: finiteNumber(input.rotationZ ?? 0, 'rotationZ'),
    label: input.label || null,
  };
}

function templateParams(template) {
  return [template.templateId, template.name, template.category, template.subcategory, template.color, template.dimensions.width, template.dimensions.depth, template.dimensions.height, template.priceCents, template.sellerId, template.modelUrl, JSON.stringify(template.metadata)];
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
    rotationZ: row.rotation_z_rad,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
