import { describe, expect, it } from 'vitest';
import {
  findOversizedTestFiles, WORKER_TEST_COUNT_WARNING, WORKER_LINE_COUNT_WARNING, E2E_LINE_COUNT_WARNING,
} from './check-test-file-size.mjs';

// #2498: proactively warn on a worker/*.test.js file approaching the known
// vitest-pool-workers crash range (#385/#389/#1853/#2448), or an
// e2e/*.test.mjs file just getting generally large -- never a hard
// failure, see this script's own header for why.
describe('findOversizedTestFiles (#2498)', () => {
  it('returns no warnings for small files', () => {
    const files = [
      { path: 'worker/small.test.js', source: 'it("a", () => {});\nit("b", () => {});\n' },
      { path: 'e2e/small.test.mjs', source: 'console.log("tiny");\n' },
    ];
    expect(findOversizedTestFiles(files)).toEqual([]);
  });

  it('warns on a worker test file at or above the test-count threshold', () => {
    const source = Array.from({ length: WORKER_TEST_COUNT_WARNING }, (_, i) => `it("test ${i}", () => {});`).join('\n');
    const files = [{ path: 'worker/big.test.js', source }];
    const warnings = findOversizedTestFiles(files);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ path: 'worker/big.test.js', tests: WORKER_TEST_COUNT_WARNING, threshold: 'worker' });
  });

  it('does not warn just below the worker test-count threshold', () => {
    const count = WORKER_TEST_COUNT_WARNING - 1;
    const source = Array.from({ length: count }, (_, i) => `it("test ${i}", () => {});`).join('\n');
    const files = [{ path: 'worker/almost.test.js', source }];
    expect(findOversizedTestFiles(files)).toEqual([]);
  });

  it('counts it.only and it.skip toward the worker test-count threshold', () => {
    const source = Array.from({ length: WORKER_TEST_COUNT_WARNING }, (_, i) => {
      const variant = i % 2 === 0 ? 'it.only' : 'it.skip';
      return `${variant}("test ${i}", () => {});`;
    }).join('\n');
    const files = [{ path: 'worker/variants.test.js', source }];
    const warnings = findOversizedTestFiles(files);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].tests).toBe(WORKER_TEST_COUNT_WARNING);
  });

  it('warns on a worker test file at or above the line-count threshold, even with few tests', () => {
    const source = `it("one", () => {});\n${'// padding line\n'.repeat(WORKER_LINE_COUNT_WARNING)}`;
    const files = [{ path: 'worker/bulky.test.js', source }];
    const warnings = findOversizedTestFiles(files);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].threshold).toBe('worker');
  });

  it('warns on an e2e test file at or above its own, more generous line-count threshold', () => {
    const source = '// padding line\n'.repeat(E2E_LINE_COUNT_WARNING);
    const files = [{ path: 'e2e/bulky.test.mjs', source }];
    const warnings = findOversizedTestFiles(files);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ path: 'e2e/bulky.test.mjs', tests: null, threshold: 'e2e' });
  });

  it('does not warn just below the e2e line-count threshold', () => {
    const source = '// padding line\n'.repeat(E2E_LINE_COUNT_WARNING - 2);
    const files = [{ path: 'e2e/almost.test.mjs', source }];
    expect(findOversizedTestFiles(files)).toEqual([]);
  });

  it('reports multiple oversized files independently', () => {
    const workerSource = Array.from({ length: WORKER_TEST_COUNT_WARNING }, (_, i) => `it("t${i}", () => {});`).join('\n');
    const e2eSource = '// padding line\n'.repeat(E2E_LINE_COUNT_WARNING);
    const files = [
      { path: 'worker/a.test.js', source: workerSource },
      { path: 'e2e/b.test.mjs', source: e2eSource },
    ];
    const warnings = findOversizedTestFiles(files);
    expect(warnings.map((w) => w.path)).toEqual(['worker/a.test.js', 'e2e/b.test.mjs']);
  });
});
