import { describe, expect, it } from 'vitest';
import {
  parseStep, parseArgs, safeShotName, summarizeTimings, routeOf, durationFromTiming, gateRefusalMessage,
  unionArea, summariseCover, coverTable,
} from './live-site-lib.mjs';

describe('live-site steps (#3430)', () => {
  it('parses each step with its arguments', () => {
    expect(parseStep('walk:forward:3000')).toEqual({ command: 'walk', args: ['forward', 3000] });
    expect(parseStep('walk:left')).toEqual({ command: 'walk', args: ['left', 1000] });
    expect(parseStep('aim:up:1500')).toEqual({ command: 'aim', args: ['up', 1500] });
    expect(parseStep('aim:left')).toEqual({ command: 'aim', args: ['left', 1000] });
    expect(parseStep('look:40:-20')).toEqual({ command: 'look', args: [40, -20] });
    expect(parseStep('tap:120:300')).toEqual({ command: 'tap', args: [120, 300] });
    expect(parseStep('tap:#account-menu-toggle')).toEqual({ command: 'tap', args: ['#account-menu-toggle'] });
    expect(parseStep('tap:button:has-text("Settings")')).toEqual({ command: 'tap', args: ['button:has-text("Settings")'] });
    expect(parseStep('mode:build')).toEqual({ command: 'mode', args: ['build'] });
    expect(parseStep('shot:after-fly')).toEqual({ command: 'shot', args: ['after-fly'] });
    expect(parseStep('shot')).toEqual({ command: 'shot', args: [''] });
    expect(parseStep('idle')).toEqual({ command: 'idle', args: [] });
    expect(parseStep('marks')).toEqual({ command: 'marks', args: [] }); // #3873
  });

  it('parses the flower steps, land and a burst (#3817)', () => {
    expect(parseStep('menu')).toEqual({ command: 'menu', args: [] });
    expect(parseStep('land')).toEqual({ command: 'land', args: [] });
    expect(parseStep('petal:build')).toEqual({ command: 'petal', args: ['build'] });
    expect(parseStep('leaf:help')).toEqual({ command: 'leaf', args: ['help'] });
    expect(parseStep('burst:legs:4:250')).toEqual({ command: 'burst', args: ['legs', 4, 250] });
    expect(parseStep('walk:forward:2000:burst:walk:4:500')).toEqual({ command: 'walk', args: ['forward', 2000], burst: { name: 'walk', count: 4, ms: 500 } });
    expect(parseStep('leaf:friends:burst:unfold:3:200')).toEqual({ command: 'leaf', args: ['friends'], burst: { name: 'unfold', count: 3, ms: 200 } });
    expect(parseStep('settings')).toEqual({ command: 'settings', args: [] });
  });

  it('refuses a bad flower step or burst with one plain line (#3817)', () => {
    expect(() => parseStep('petal:moon')).toThrow(/petal must be one of/);
    expect(() => parseStep('leaf:wardrobe')).toThrow(/leaf must be one of notices, friends, purchases, settings, help/);
    expect(() => parseStep('leaf')).toThrow(/needs 1 argument/);
    expect(() => parseStep('burst:legs:4')).toThrow(/burst needs a name, a count and milliseconds apart/);
    expect(() => parseStep('walk:forward:1000:burst:w:99:500')).toThrow(/count must be a whole number from 1 to 12/);
    expect(() => parseStep('walk:forward:1000:burst:w:3:5')).toThrow(/milliseconds apart must be from 50 to 5000/);
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

  it('parses a key press and refuses a bad key name', () => {
    expect(parseStep('key:KeyN')).toMatchObject({ command: 'key', args: ['KeyN'] });
    expect(parseStep('key:Shift+KeyN')).toMatchObject({ command: 'key', args: ['Shift+KeyN'] });
    expect(() => parseStep('key')).toThrow(/needs 1 argument/);
    expect(() => parseStep('key:a b')).toThrow(/key name/);
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

// #3542: how much of the screen the interface covers.
describe('unionArea', () => {
  const rect = (x, y, width, height) => ({ x, y, width, height });

  it('is the plain area of one rectangle and zero for none or empty ones', () => {
    expect(unionArea([])).toBe(0);
    expect(unionArea([rect(10, 10, 30, 20)])).toBe(600);
    expect(unionArea([rect(0, 0, 0, 50), rect(5, 5, 10, 0)])).toBe(0);
  });

  it('counts overlap once', () => {
    // Two 10x10 squares overlapping in a 5x5 corner: 100 + 100 - 25.
    expect(unionArea([rect(0, 0, 10, 10), rect(5, 5, 10, 10)])).toBe(175);
    // A rectangle inside another adds nothing; identical ones add nothing.
    expect(unionArea([rect(0, 0, 100, 100), rect(10, 10, 20, 20), rect(0, 0, 100, 100)])).toBe(10000);
  });

  it('adds separate rectangles and handles a plus-shaped overlap', () => {
    expect(unionArea([rect(0, 0, 10, 10), rect(20, 0, 10, 10)])).toBe(200);
    // A 30x10 bar crossed by a 10x30 bar: 300 + 300 - 100.
    expect(unionArea([rect(0, 10, 30, 10), rect(10, 0, 10, 30)])).toBe(500);
  });

  it('merges touching and chained intervals within a slab', () => {
    // Three stacked rectangles in one column, the first two touching, the third overlapping the second.
    expect(unionArea([rect(0, 0, 10, 10), rect(0, 10, 10, 10), rect(0, 15, 10, 10)])).toBe(250);
  });
});

describe('summariseCover', () => {
  const viewport = { width: 100, height: 100 };

  it('reports the union share, the root count and the largest root', () => {
    const elements = [
      { selector: 'div#sheet', rect: { x: 0, y: 50, width: 100, height: 50 }, root: true, solid: false }, // half the screen, translucent
      { selector: 'button.close', rect: { x: 80, y: 60, width: 10, height: 10 }, root: false, solid: true }, // inside the sheet
      { selector: 'div.pill', rect: { x: 0, y: 0, width: 20, height: 10 }, root: true, solid: true },
    ];
    expect(summariseCover(elements, viewport)).toEqual({
      coverShare: 0.52,
      solidShare: 0.03, // the pill (2%) and the close button (1%): the dim sheet does not hide anything
      elementCount: 2,
      largest: { selector: 'div#sheet', share: 0.5 },
    });
  });

  it('clips to the viewport, so what hangs off the edge is not counted', () => {
    const elements = [{ selector: 'div.wide', rect: { x: 50, y: -20, width: 100, height: 40 }, root: true, solid: true }];
    // Visible part: x 50..100, y 0..20.
    expect(summariseCover(elements, viewport)).toEqual({ coverShare: 0.1, solidShare: 0.1, elementCount: 1, largest: { selector: 'div.wide', share: 0.1 } });
  });

  it('says so when nothing is over the world', () => {
    expect(summariseCover([], viewport)).toEqual({ coverShare: 0, solidShare: 0, elementCount: 0, largest: null });
    expect(summariseCover([{ selector: 'div.off', rect: { x: 200, y: 200, width: 10, height: 10 }, root: true, solid: true }], viewport).elementCount).toBe(0);
  });
});

describe('coverTable and the cover flags', () => {
  it('prints one row per state, with a reason for one that could not be measured', () => {
    const table = coverTable([
      { state: 'Shop', cover: { coverShare: 0.1234, solidShare: 0.08, elementCount: 7, largest: { selector: 'div#hud', share: 0.05 } } },
      { state: 'Assistant panel', note: 'needs an assistant on shift' },
    ]);
    expect(table).toContain('| Shop | 12.3% | 8.0% | 7 | `div#hud` (5.0%) |');
    expect(table).toContain('| Assistant panel | not measured | | | needs an assistant on shift |');
    expect(table.split('\n')).toHaveLength(4);
  });

  it('parses the cover step and the --cover-report flag', () => {
    expect(parseStep('cover')).toEqual({ command: 'cover', args: [] });
    expect(parseArgs(['--name', 'higglehaven3', '--cover-report'], {}).options.coverReport).toBe(true);
    expect(parseArgs(['--name', 'higglehaven3'], {}).options.coverReport).toBe(false);
  });
});

describe('the throttle flag (#3736)', () => {
  it('is off unless asked for, and takes no value', () => {
    expect(parseArgs(['--name', 'higglehaven3'], {}).options.throttle).toBe(false);
    const { options, steps } = parseArgs(['--name', 'higglehaven3', '--throttle', 'idle'], {});
    expect(options.throttle).toBe(true);
    expect(steps).toHaveLength(1);
  });
});
