import { describe, expect, it } from 'vitest';
import { listSourceFiles } from './check-worker-imports.mjs';

// #2684: only listSourceFiles (pure file-discovery, no real fs access
// beyond the injected readdir stub) is tested here. checkModuleImports/
// main() drive a real Node dynamic import() plus a node:module register()
// loader hook -- deliberately untested at this layer, since this test
// file runs inside vitest.config.js's single shared cloudflareTest pool
// (scripts/**/*.test.mjs, worker/**/*.test.js, and src/**/*.test.js all
// share one `test.include`), not plain Node. That side-effecting half is
// exercised for real by `pretest` itself (same precedent as this repo's
// check-migrations-manifest-fresh.mjs, whose own side-effecting main()
// has no dedicated test file either).
describe('listSourceFiles (#2684)', () => {
  function fakeFs(tree) {
    return (dir) => (tree.get(dir) || []).map((entry) => ({
      name: entry.name,
      isDirectory: () => Boolean(entry.isDir),
    }));
  }

  it('lists .js files directly in the directory', () => {
    const tree = new Map([
      ['/w', [{ name: 'index.js' }, { name: 'index.test.js' }, { name: 'migrations-manifest.json' }]],
    ]);
    expect(listSourceFiles('/w', fakeFs(tree))).toEqual(['/w/index.js']);
  });

  it('recurses into subdirectories', () => {
    const tree = new Map([
      ['/w', [{ name: 'index.js' }, { name: 'lib', isDir: true }]],
      ['/w/lib', [{ name: 'auth.js' }, { name: 'auth.test.js' }]],
    ]);
    expect(listSourceFiles('/w', fakeFs(tree))).toEqual(['/w/index.js', '/w/lib/auth.js']);
  });

  it('excludes test-helpers.js (depends on the cloudflare:test virtual module)', () => {
    const tree = new Map([
      ['/w', [{ name: 'index.js' }, { name: 'test-helpers.js' }]],
    ]);
    expect(listSourceFiles('/w', fakeFs(tree))).toEqual(['/w/index.js']);
  });

  it('returns an empty list for a directory with only excluded files', () => {
    const tree = new Map([
      ['/w', [{ name: 'a.test.js' }, { name: 'test-helpers.js' }, { name: 'data.json' }]],
    ]);
    expect(listSourceFiles('/w', fakeFs(tree))).toEqual([]);
  });
});
