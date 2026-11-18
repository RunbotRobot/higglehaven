// #3737 (part of #3735): public/_headers is what gives the content-hashed build files a
// year-long immutable cache. It is a plain text file with a rule per path, and two rules that
// match one path are MERGED by the static assets service (a path would get two Cache-Control
// values), so this pins the shape: the hashed rule exists and is immutable, nothing caches
// index.html or the unhashed script, and no two rules overlap.
import { describe, it, expect } from 'vitest';
import text from '../public/_headers?raw';

function parse(source) {
  const rules = [];
  let current = null;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = { path: line.trim(), headers: {} }; rules.push(current); continue; }
    const at = line.indexOf(':');
    current.headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return rules;
}
const rules = parse(text);
const matches = (rule, path) => (rule.path.endsWith('/*') ? path.startsWith(rule.path.slice(0, -1)) : rule.path === path);

describe('public/_headers', () => {
  it('caches the hashed build files for a year, immutable', () => {
    const rule = rules.find((r) => r.path === '/assets/*');
    expect(rule?.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never caches index.html or the unhashed head script', () => {
    for (const path of ['/', '/index.html', '/viewport-refresh.js', '/admin-dashboard.html']) {
      expect(rules.filter((r) => matches(r, path))).toEqual([]);
    }
  });

  it('gives every path at most one rule, so Cache-Control is never merged', () => {
    const samples = ['/assets/index-abc.js', '/assets/three-abc.js', '/wordmark.png', '/bird-standing.png', '/bird-flying.png', '/favicon.svg', '/models/crate.glb', '/', '/viewport-refresh.js'];
    for (const path of samples) expect(rules.filter((r) => matches(r, path)).length).toBeLessThanOrEqual(1);
  });

  it('only ever sets Cache-Control, and nothing immutable outside /assets/', () => {
    for (const rule of rules) {
      expect(Object.keys(rule.headers)).toEqual(['cache-control']);
      if (rule.path !== '/assets/*') expect(rule.headers['cache-control']).not.toMatch(/immutable/);
    }
  });
});
