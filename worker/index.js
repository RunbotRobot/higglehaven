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
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        console.error(error);
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

  if (route[0] === 'landlets') {
    return handleLandlets(request, env.DB, route, url);
  }

  if (route[0] === 'world') {
    return handleWorld(request, env.DB, route);
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


async function handleLandlets(request, db, route, url) {
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

async function handleWorld(request, db, route) {
  if (request.method === 'GET' && route.length === 1) {
    const settings = await getWorldSettings(db);
    const counts = await db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'greenbelt' THEN 1 ELSE 0 END) AS greenbelt,
        SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
        SUM(CASE WHEN status = 'generating' THEN 1 ELSE 0 END) AS generating
      FROM landlets
    `).first();
    return json({ world: worldFromRow(settings, counts) });
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
  return request.json();
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

function landletParams(landlet) {
  return [landlet.landletId, landlet.name, landlet.areaM2, landlet.center.x, landlet.center.y, landlet.status, landlet.ownerBuilderId, landlet.landClass, JSON.stringify(landlet.polygon), landlet.generatedAt, landlet.claimableAt, JSON.stringify(landlet.metadata)];
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
    metadata: JSON.parse(row.metadata_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
