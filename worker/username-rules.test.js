// #4383: a name that starts with higglehaven reads as the team, and an assistant's name followed by digits reads as
// that assistant. Both are reserved for anyone signing up or renaming on the real site; names that merely contain
// the word later stay free.
import { describe, expect, it } from 'vitest';
import { isReservedSkeleton, isLocalDevServer, usernameSkeleton } from './lib/username-rules.js';

const reserved = (name, options) => isReservedSkeleton(usernameSkeleton(name), options);

describe('names that read as the team (#4383)', () => {
  it('refuses anything that starts with higglehaven, however it is spelled', () => {
    for (const name of ['higglehaven17', 'Higgle haven 99', 'higglehaven-2', 'higglehaven_support', 'higglehavenfan', 'hіgglehaven7', 'HIGGLEHAVEN']) {
      expect(reserved(name), name).toBe(true);
    }
  });
  it('leaves a name that only contains it later, or part of it, free', () => {
    for (const name of ['haven', 'higgle', 'thehigglehavenfan', 'my higglehaven']) expect(reserved(name), name).toBe(false);
  });
  it('refuses an assistant name followed by digits, not a longer word that starts with it', () => {
    for (const name of ['juniper2', 'Juniper 42', 'sage7', 'fern-3']) expect(reserved(name), name).toBe(true);
    for (const name of ['fernando', 'sagebrush', 'mosscow', 'maple leaf']) expect(reserved(name), name).toBe(false);
  });
  it('lets a local server keep its session names (live-site --login local), but only those', () => {
    expect(reserved('higglehaven10', { allowSessionNames: true })).toBe(false);
    expect(reserved('higglehaven-support', { allowSessionNames: true })).toBe(true);
    expect(reserved('higglehaven10')).toBe(true);
  });
  it('knows a local dev server from the real site, by its own base URL', () => {
    expect(isLocalDevServer({ APP_BASE_URL: 'http://127.0.0.1:8787' })).toBe(true);
    expect(isLocalDevServer({ APP_BASE_URL: 'http://localhost:8787' })).toBe(true);
    expect(isLocalDevServer({ APP_BASE_URL: 'https://higglehaven.example' })).toBe(false);
    expect(isLocalDevServer({})).toBe(false);
    expect(isLocalDevServer(undefined)).toBe(false);
  });
});
