import { describe, expect, it } from 'vitest';
import { findMigrationNumberCollisions } from './check-migration-number-collisions.mjs';

// #1021: two independent PRs picking the same leading migration number
// (e.g. #1017 vs #1018, both `0090_*.sql`) used to only surface as a
// `mergeable_state: "dirty"` GitHub PR after the fact.
describe('findMigrationNumberCollisions (#1021)', () => {
  it('returns an empty array when every migration number is unique', () => {
    const filenames = [
      '0001_initial.sql',
      '0002_add_brick_template.sql',
      '0090_catalog_name_nocase_sort.sql',
    ];
    expect(findMigrationNumberCollisions(filenames)).toEqual([]);
  });

  it('reports a collision when two files share the same leading number', () => {
    const filenames = [
      '0090_catalog_name_nocase_sort.sql',
      '0090_owned_avatars_purchase_id_index.sql',
    ];
    expect(findMigrationNumberCollisions(filenames)).toEqual([
      {
        number: '0090',
        names: [
          '0090_catalog_name_nocase_sort.sql',
          '0090_owned_avatars_purchase_id_index.sql',
        ],
      },
    ]);
  });

  it('reports each colliding group independently when there are multiple', () => {
    const filenames = [
      '0058_a.sql',
      '0058_b.sql',
      '0058_c.sql',
      '0059_only.sql',
      '0060_x.sql',
      '0060_y.sql',
    ];
    expect(findMigrationNumberCollisions(filenames)).toEqual([
      { number: '0058', names: ['0058_a.sql', '0058_b.sql', '0058_c.sql'] },
      { number: '0060', names: ['0060_x.sql', '0060_y.sql'] },
    ]);
  });

  it('ignores filenames without a leading numeric prefix', () => {
    expect(findMigrationNumberCollisions(['README.sql', 'notes.sql'])).toEqual([]);
  });
});
