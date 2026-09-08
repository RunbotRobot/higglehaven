import { describe, expect, it } from 'vitest';
import { computeMissingMigrations } from './index.js';

describe('computeMissingMigrations (#499)', () => {
  it('returns nothing when every manifest entry is applied', () => {
    const applied = ['0001_initial.sql', '0002_add_brick_template.sql'];
    const manifest = ['0001_initial.sql', '0002_add_brick_template.sql'];
    expect(computeMissingMigrations(applied, manifest)).toEqual([]);
  });

  it('reports manifest entries missing from d1_migrations, in manifest order', () => {
    const applied = ['0001_initial.sql'];
    const manifest = ['0001_initial.sql', '0002_add_brick_template.sql', '0003_catalog_real_models.sql'];
    expect(computeMissingMigrations(applied, manifest)).toEqual([
      '0002_add_brick_template.sql',
      '0003_catalog_real_models.sql',
    ]);
  });

  it('does not flag drift for migrations applied but no longer in the manifest', () => {
    // Not the failure mode #488/#499 care about (production falling behind
    // main) — extra applied rows are harmless here, e.g. a squash/rename
    // that intentionally dropped an old filename from migrations/.
    const applied = ['0001_initial.sql', '0002_add_brick_template.sql'];
    const manifest = ['0001_initial.sql'];
    expect(computeMissingMigrations(applied, manifest)).toEqual([]);
  });

  it('treats an empty manifest and an empty applied set as no drift', () => {
    expect(computeMissingMigrations([], [])).toEqual([]);
  });
});
