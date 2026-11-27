// #4601: migration 0246 rewrites the old `metadata.domesticOnly` flag into `metadata.shippingZones`. The test
// database already has every migration applied, so this runs the migration's own SQL again over rows set up in
// each old shape and checks what each becomes.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import migrationSql from '../migrations/0246_shipping_zones.sql?raw';

async function insertTemplate(templateId, metadataJson) {
  await env.DB.prepare(`
    INSERT INTO catalog_templates (template_id, name, category, subcategory, color, width_m, depth_m, height_m, price_cents, metadata_json)
    VALUES (?, ?, 'misc', 'misc', '#123456', 1, 1, 1, 100, ?)
  `).bind(templateId, templateId, metadataJson).run();
}
const metadataOf = async (templateId) => JSON.parse((await env.DB.prepare('SELECT metadata_json FROM catalog_templates WHERE template_id = ?').bind(templateId).first()).metadata_json);

describe('0246_shipping_zones', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await insertTemplate('ship-mig-us-only', '{"domesticOnly":true,"noReturns":true}');
    await insertTemplate('ship-mig-false', '{"domesticOnly":false,"noReturns":true}');
    await insertTemplate('ship-mig-none', '{"noReturns":true}');
    await insertTemplate('ship-mig-zones', '{"shippingZones":["us","ca"]}');
    const statements = migrationSql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
      .split(';').map((part) => part.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) await env.DB.prepare(statement).run();
  });

  it('turns a United States only flag into the one zone, keeping the rest of the metadata', async () => {
    expect(await metadataOf('ship-mig-us-only')).toEqual({ shippingZones: ['us'], noReturns: true });
  });

  it('drops a false flag (it already meant everywhere) and leaves other keys', async () => {
    expect(await metadataOf('ship-mig-false')).toEqual({ noReturns: true });
  });

  it('leaves a product with no flag, and one already on zones, as it was', async () => {
    expect(await metadataOf('ship-mig-none')).toEqual({ noReturns: true });
    expect(await metadataOf('ship-mig-zones')).toEqual({ shippingZones: ['us', 'ca'] });
  });
});
