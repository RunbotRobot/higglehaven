import { describe, expect, it } from 'vitest';
import { routeTests, undocumentedRoutes } from './check-api-routes-documented.mjs';

// #4496: the pure halves only; main() reads the real files and runs as part of pretest.
describe('check-api-routes-documented (#4496)', () => {
  const src = [
    "if (request.method === 'POST' && route.length === 2 && route[1] === 'change-email') {",
    "if (route[0] === 'ncmec-reports') {",
    'const x = 1;',
  ].join('\n');

  it('reads the literals and the method off each route test', () => {
    expect(routeTests(src)).toEqual([
      { line: 1, literals: ['change-email'], method: 'POST' },
      { line: 2, literals: ['ncmec-reports'], method: null },
    ]);
  });

  it('reports a route that has no line in the document', () => {
    const doc = '### `POST /api/ncmec-reports`\n';
    const problems = undocumentedRoutes(routeTests(src), doc);
    expect(problems.map((p) => p.missing)).toEqual(['change-email', 'change-email']);
  });

  it('passes a route that is documented with its method', () => {
    const doc = '### `POST /api/auth/change-email`\n### `GET /api/ncmec-reports`\n';
    expect(undocumentedRoutes(routeTests(src), doc)).toEqual([]);
  });

  it('wants the method beside the path, not only the path', () => {
    const doc = 'the /change-email page\n\n\n\n\n\n\nPOST elsewhere\n/ncmec-reports\n';
    const problems = undocumentedRoutes(routeTests(src), doc);
    expect(problems).toHaveLength(1);
    expect(problems[0].why).toMatch(/POST/);
  });

  it('does not take /change-email for a longer segment', () => {
    const doc = 'POST /change-email-address\n/ncmec-reports\n';
    expect(undocumentedRoutes(routeTests(src), doc).length).toBeGreaterThan(0);
  });
});
