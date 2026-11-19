import { describe, it, expect } from 'vitest';
import liveSiteSource from './live-site.mjs?raw';
import { checkLocalUrl, parseSeedArgs, SEED_ACCOUNTS, SEED_PASSWORD } from './seed-local-world-lib.mjs';

// #3930: the seed is local only, and says so before it sends a single request.
describe('seed-local-world arguments', () => {
  it('defaults to the local wrangler dev address', () => {
    expect(parseSeedArgs([]).url).toBe('http://127.0.0.1:8787');
  });

  it('takes a local --url', () => {
    expect(parseSeedArgs(['--url', 'http://localhost:9000']).url).toBe('http://localhost:9000');
    expect(parseSeedArgs(['--url', 'http://127.0.0.1:8788/']).url).toBe('http://127.0.0.1:8788');
  });

  it('refuses any address that is not this machine, including look-alikes', () => {
    expect(() => checkLocalUrl('https://higglehaven.com')).toThrow(/refusing higglehaven\.com/);
    expect(() => checkLocalUrl('http://127.0.0.1.evil.example')).toThrow(/refusing/);
    expect(() => checkLocalUrl('http://localhost.evil.example:8787')).toThrow(/refusing/);
    expect(() => checkLocalUrl('http://example.com@127.0.0.1:8787@evil.example')).toThrow();
    expect(() => parseSeedArgs(['--url', 'https://higglehaven.com'])).toThrow(/refusing/);
  });

  it('refuses --remote and anything it does not know', () => {
    expect(() => parseSeedArgs(['--remote'])).toThrow(/--remote is refused/);
    expect(() => parseSeedArgs(['--wat'])).toThrow(/unknown argument/);
  });

  it('uses the names and password scripts/live-site.mjs signs a local account in with', () => {
    expect(SEED_ACCOUNTS).toEqual(['looker', 'neighbor']);
    expect(SEED_PASSWORD).toBe('live-site-local-password-123');
    // The two must not drift, or `--login local --name looker` would sign in to a different account.
    expect(liveSiteSource).toContain(`const password = '${SEED_PASSWORD}';`);
    expect(liveSiteSource).toContain("const email = `${name}@e2e.test`;"); // #3944 made the local login take the account name as an argument
  });
});
