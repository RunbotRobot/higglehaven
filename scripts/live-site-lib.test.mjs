import { describe, expect, it } from 'vitest';
import {
  parseStep, parseArgs, safeShotName, summarizeTimings, routeOf, durationFromTiming, gateRefusalMessage,
} from './live-site-lib.mjs';

describe('live-site steps (#3430)', () => {
  it('parses each step with its arguments', () => {
    expect(parseStep('walk:forward:3000')).toEqual({ command: 'walk', args: ['forward', 3000] });
    expect(parseStep('walk:left')).toEqual({ command: 'walk', args: ['left', 1000] });
    expect(parseStep('aim:up:1500')).toEqual({ command: 'aim', args: ['up', 1500] });
    expect(parseStep('aim:left')).toEqual({ command: 'aim', args: ['left', 1000] });
    expect(parseStep('look:40:-20')).toEqual({ command: 'look', args: [40, -20] });
    expect(parseStep('tap:120:300')).toEqual({ command: 'tap', args: [120, 300] });
    expect(parseStep('tap:#shop-fly-btn')).toEqual({ command: 'tap', args: ['#shop-fly-btn'] });
    expect(parseStep('tap:button:has-text("Settings")')).toEqual({ command: 'tap', args: ['button:has-text("Settings")'] });
    expect(parseStep('mode:build')).toEqual({ command: 'mode', args: ['build'] });
    expect(parseStep('shot:after-fly')).toEqual({ command: 'shot', args: ['after-fly'] });
    expect(parseStep('shot')).toEqual({ command: 'shot', args: [''] });
    expect(parseStep('idle')).toEqual({ command: 'idle', args: [] });
  });

  it('refuses a bad step with one plain line naming it', () => {
    expect(() => parseStep('walk:sideways')).toThrow(/direction must be one of/);
    expect(() => parseStep('walk')).toThrow(/needs 1 argument/);
    expect(() => parseStep('aim:forward')).toThrow(/direction must be one of up, down, left, right/);
    expect(() => parseStep('aim:up:0')).toThrow(/positive number/);
    expect(() => parseStep('look:1')).toThrow(/needs 2 argument/);
    expect(() => parseStep('mode:moon')).toThrow(/mode must be one of/);
    expect(() => parseStep('dance')).toThrow(/unknown step "dance"/);
  });
});

describe('live-site arguments (#3430)', () => {
  it('reads flags and steps, defaulting to the live site and a phone', () => {
    const { options, steps } = parseArgs(['--name', 'higglehaven10', '--timing', '/api/x', '--timing', '/api/y', 'idle', 'shot'], {});
    expect(options).toMatchObject({ url: 'https://higglehaven.com', name: 'higglehaven10', desktop: false, login: 'fleet', timing: ['/api/x', '/api/y'] });
    expect(steps.map((s) => s.command)).toEqual(['idle', 'shot']);
  });

  it('requires a fleet-shaped name for the live login, and any name locally', () => {
    expect(() => parseArgs(['idle'], {})).toThrow(/--name is required/);
    expect(() => parseArgs(['--name', 'someone', 'idle'], {})).toThrow(/not a fleet name/);
    expect(parseArgs(['--name', 'someone', '--login', 'local', 'idle'], {}).options.name).toBe('someone');
    expect(() => parseArgs(['--name', 'higglehaven3', '--login', 'magic'], {})).toThrow(/--login must be/);
  });

  it('rejects an unknown flag instead of treating it as a step', () => {
    expect(() => parseArgs(['--name', 'higglehaven3', '--cookie', 'x'], {})).toThrow(/unknown flag --cookie/);
  });
});

describe('live-site report helpers (#3430)', () => {
  it('keeps screenshot names to a safe file name', () => {
    expect(safeShotName('after fly!', 3)).toBe('03-after-fly.png');
    expect(safeShotName('../../etc/passwd', 1)).toBe('01-etc-passwd.png');
    expect(safeShotName('', 12)).toBe('12-shot.png');
  });

  it('summarizes request durations', () => {
    expect(summarizeTimings([])).toEqual({ count: 0 });
    expect(summarizeTimings([100, 300, 200, NaN])).toEqual({ count: 3, minMs: 100, medianMs: 200, maxMs: 300, avgMs: 200 });
  });

  it('groups routes by path with ids collapsed, never the query string', () => {
    expect(routeOf('https://x.test/api/landlets/3f2a9c1e-aaaa-bbbb-cccc-1234567890ab?token=secret')).toBe('/api/landlets/:id');
    expect(routeOf('https://x.test/api/credit-orbs/42/collect')).toBe('/api/credit-orbs/:id/collect');
  });

  it('reads a request duration from Playwright timing, null when unavailable', () => {
    expect(durationFromTiming({ startTime: 1, responseEnd: 87.5 })).toBe(87.5);
    expect(durationFromTiming({ responseEnd: -1 })).toBeNull();
    expect(durationFromTiming(null)).toBeNull();
  });

  it('says the key is not configured on a 401, with no header in the line', () => {
    const line = gateRefusalMessage(401);
    expect(line).toMatch(/fleet key is not configured/);
    expect(line).not.toMatch(/x-fleet-key/i);
  });
});
