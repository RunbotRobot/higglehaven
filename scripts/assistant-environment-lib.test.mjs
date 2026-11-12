import { describe, expect, it } from 'vitest';
import { PROGRAM_FILES, buildSetupScript, permissionRules, INSTALL_DIR, REPLY_ACTIONS } from './assistant-environment-lib.mjs';
import { resolveBaseUrl, LIVE_SITE_URL } from './assistant-lib.mjs';

// #3458: the generated setup script and the permission rules.
const COMMIT = 'a'.repeat(40);
// Any 64-hex values do: the unit tests check the text, e2e/assistant-environment-setup.test.mjs runs it.
const SUMS = Object.fromEntries(PROGRAM_FILES.map((name, i) => [name, String(i + 1).repeat(64).slice(0, 64)]));

describe('buildSetupScript', () => {
  it('names the pinned commit, the public host and every checksum, and fits the environment field', () => {
    const script = buildSetupScript({ commit: COMMIT, files: SUMS });
    expect(script).toContain(`COMMIT=${COMMIT}`);
    expect(script).toContain('https://raw.githubusercontent.com/RunbotRobot/higglehaven/$COMMIT/scripts');
    for (const name of PROGRAM_FILES) expect(script).toContain(`${SUMS[name]}  ${name}`);
    const lines = script.split('\n');
    expect(lines.length).toBeLessThanOrEqual(100);
    expect(Math.max(...lines.map((l) => new TextEncoder().encode(l).length))).toBeLessThanOrEqual(200);
    expect(script).not.toMatch(/\r|[\u0000-\u0008]/);
    expect(script).not.toMatch(/--location|curl [^\n]*-L /); // a redirect must not be able to change the host
  });

  it('refuses a short commit, a malformed repository and a missing or bad checksum', () => {
    expect(() => buildSetupScript({ commit: 'abc', files: SUMS })).toThrow(/40-character/);
    expect(() => buildSetupScript({ commit: COMMIT, files: SUMS, repo: 'no slash' })).toThrow(/owner\/name/);
    expect(() => buildSetupScript({ commit: COMMIT, files: { ...SUMS, 'assistant-lib.mjs': 'zz' } })).toThrow(/assistant-lib\.mjs/);
    const { 'assistant-reply.mjs': _dropped, ...partial } = SUMS;
    expect(() => buildSetupScript({ commit: COMMIT, files: partial })).toThrow(/assistant-reply\.mjs/);
  });
});

describe('permissionRules', () => {
  it('uses default mode and pre-approves only the fixed program invocations for one name', () => {
    const { permissions } = permissionRules('Juniper');
    expect(permissions.defaultMode).toBe('default');
    expect(permissions.allow).toContain(`Bash(node ${INSTALL_DIR}/assistant-shift.mjs --name juniper)`);
    for (const action of REPLY_ACTIONS) expect(permissions.allow).toContain(`Bash(node ${INSTALL_DIR}/assistant-reply.mjs --name juniper ${action}:*)`);
    expect(permissions.allow).toHaveLength(1 + REPLY_ACTIONS.length);
    expect(permissions.allow.every((rule) => rule.startsWith(`Bash(node ${INSTALL_DIR}/`))).toBe(true);
  });

  it('accepts the long login form and refuses anything that is not an assistant name', () => {
    expect(permissionRules('assistant-fig').permissions.allow[0]).toContain('--name fig)');
    expect(() => permissionRules('higglehaven4')).toThrow(/not an assistant name/);
    expect(() => permissionRules('')).toThrow();
    expect(() => permissionRules('juniper; rm -rf /')).toThrow();
  });
});

describe('resolveBaseUrl', () => {
  it('allows only the live site or a local server, so a later --url cannot send requests elsewhere', () => {
    expect(resolveBaseUrl(undefined)).toBe(LIVE_SITE_URL);
    expect(resolveBaseUrl('https://higglehaven.com/')).toBe(LIVE_SITE_URL);
    expect(resolveBaseUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(resolveBaseUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => resolveBaseUrl('https://example.com')).toThrow(/live site or a local server/);
    expect(() => resolveBaseUrl('https://higglehaven.com.evil.test')).toThrow();
    expect(() => resolveBaseUrl('http://127.0.0.1.evil.test')).toThrow();
  });
});
