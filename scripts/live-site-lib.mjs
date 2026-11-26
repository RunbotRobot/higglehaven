// #3430 (part of #3428): the pure parts of scripts/live-site.mjs, the tool a
// fleet session uses to look at the running site the way a person does. Kept
// free of Playwright so the plain vitest pool can test them.

// The owner's usual view: a current Android phone.
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
export const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

// #3874: a touch screen of any size (a phone on its side, a tablet), for looking at the flower
// where it has not been looked at: --size 844x390, --size 768x1024.
export function touchDeviceForSize(text) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(String(text));
  if (!match) throw new Error('--size must look like 844x390 (width x height in CSS pixels)');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 200 || height < 200 || width > 4000 || height > 4000) throw new Error('--size must be between 200 and 4000 pixels each way');
  return { width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
}

export const FLEET_NAME_PATTERN = /^higglehaven[0-9]{1,3}$/;
export const WALK_DIRECTIONS = ['forward', 'back', 'left', 'right'];
export const MODES = ['shop', 'build', 'sell'];
// #3817: steps named for what a person does with the flower, so a look does not depend on
// where a control happens to sit this week. The selector is the leaf's button in the open menu.
export const LEAF_BUTTONS = {
  notices: '#notifications-btn',
  friends: '#friends-btn',
  purchases: '#my-purchases-btn',
  settings: '#settings-btn',
  help: '.bud-petal[id$="-help"]',
};
export const LEAVES = Object.keys(LEAF_BUTTONS);
export const BURST_MAX_COUNT = 12;

// Drag direction for a walk (a unit vector scaled by the caller)
// (screen y grows downward, so "forward" is up).
export const WALK_VECTORS = {
  forward: [0, -1],
  back: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

// #3479/#3650/#3749: the camera is steered by a finger dragged from the right half (held, it turns the view at a
// steady rate; up and down are the pitch), not by dragging the page, so `aim`
// holds that finger. Directions are as the finger moves, on the screen.
export const AIM_VECTORS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
export const AIM_DIRECTIONS = Object.keys(AIM_VECTORS);

// #3542 (part of #3539, "the world is the product; every piece of interface has to earn
// the space it takes from it"): how much of the screen the interface covers, as a number
// an interface change can report before and after.
//
// How it is counted: every visible element that paints something itself (a background,
// a border, an image or icon, a form control, or its own text) is a rectangle; each is
// clipped to the viewport and the share is the area of their UNION, so a button inside a
// panel inside a sheet counts once. A translucent surface counts by its full area (a pale
// pane hides less than a solid one, but it is still a pane over the world; the report does
// not discount opacity); the separate "solid" share counts only what is opaque (a surface
// with a background at least 95% opaque, an image, an icon, a control, or text), which is
// what actually hides the world rather than dimming it. Text counts as the box of its
// glyphs, not of the box it sits in.
// An element's own children are not "distinct elements": the count is of ROOTS, painted
// elements with no painted ancestor, so a panel with twelve controls is one.

// Area of the union of axis-aligned rectangles ({ x, y, width, height }), by sweeping the
// distinct x edges and merging the y intervals of every rectangle spanning each slab.
export function unionArea(rects) {
  const boxes = rects
    .map((r) => ({ x0: r.x, x1: r.x + r.width, y0: r.y, y1: r.y + r.height }))
    .filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
  if (!boxes.length) return 0;
  const xs = [...new Set(boxes.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const left = xs[i];
    const right = xs[i + 1];
    const spans = boxes.filter((b) => b.x0 <= left && b.x1 >= right).map((b) => [b.y0, b.y1]).sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let [curStart, curEnd] = spans.length ? spans[0] : [0, 0];
    for (let k = 1; k < spans.length; k += 1) {
      if (spans[k][0] > curEnd) {
        covered += curEnd - curStart;
        [curStart, curEnd] = spans[k];
      } else if (spans[k][1] > curEnd) {
        curEnd = spans[k][1];
      }
    }
    covered += curEnd - curStart;
    area += covered * (right - left);
  }
  return area;
}

function clipToViewport(rect, viewport) {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(viewport.width, rect.x + rect.width);
  const y1 = Math.min(viewport.height, rect.y + rect.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// elements: [{ selector, rect: { x, y, width, height }, root: boolean, solid: boolean }] as
// the page reports them. Returns { coverShare, solidShare, elementCount, largest:
// { selector, share } | null }, shares as fractions of the viewport rounded to four places.
export function summariseCover(elements, viewport) {
  const total = viewport.width * viewport.height;
  const round = (n) => Math.round(n * 10000) / 10000;
  const clipped = elements.map((el) => ({ el, rect: clipToViewport(el.rect, viewport) })).filter((c) => c.rect.width > 0 && c.rect.height > 0);
  const roots = clipped.filter((c) => c.el.root);
  let largest = null;
  for (const c of roots) {
    const share = (c.rect.width * c.rect.height) / total;
    if (!largest || share > largest.share) largest = { selector: c.el.selector, share };
  }
  return {
    coverShare: total > 0 ? round(unionArea(clipped.map((c) => c.rect)) / total) : 0,
    solidShare: total > 0 ? round(unionArea(clipped.filter((c) => c.el.solid).map((c) => c.rect)) / total) : 0,
    elementCount: roots.length,
    largest: largest ? { selector: largest.selector, share: round(largest.share) } : null,
  };
}

// One markdown table of states, as `--cover-report` prints it. rows: [{ state, cover?, note? }].
export function coverTable(rows) {
  const percent = (share) => `${(share * 100).toFixed(1)}%`;
  const lines = ['| State | Covered | Solid | Elements | Largest (share of screen) |', '| --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    if (!row.cover) {
      lines.push(`| ${row.state} | not measured | | | ${row.note || ''} |`);
      continue;
    }
    const { coverShare, solidShare, elementCount, largest } = row.cover;
    lines.push(`| ${row.state} | ${percent(coverShare)} | ${percent(solidShare)} | ${elementCount} | ${largest ? `\`${largest.selector}\` (${percent(largest.share)})` : 'none'} |`);
  }
  return lines.join('\n');
}

// #3935: what a `budget` step can hold a run to. The long-task figures are meaningful under the CPU
// throttle of --phone; the frame time is software GL on the cloud machine, so a budget on it says so.
export const BUDGET_METRICS = {
  longtask: { label: 'longest long task', unit: 'ms', read: (stats) => stats?.longTasks?.longestMs ?? null },
  longtasks: { label: 'long tasks', unit: '', read: (stats) => stats?.longTasks?.count ?? null },
  frame: { label: 'longest frame', unit: 'ms', read: (stats) => stats?.longestFrameMs ?? null, caution: 'frame time on the cloud machine is software GL, not a phone GPU: trust it only as a comparison against the same run before' },
};

// Pure: the figures so far (the `stats` step's shape) against one budget. Returns what to put in the
// report: the value, the limit, whether it is within, and one plain line either way.
export function evaluateBudget(metric, limit, stats) {
  const spec = BUDGET_METRICS[metric];
  if (!spec) throw new Error(`unknown budget metric "${metric}"`);
  const value = spec.read(stats);
  const unit = spec.unit ? ` ${spec.unit}` : '';
  if (value === null || !Number.isFinite(value)) {
    return { metric, limit, value: null, within: false, line: `budget ${metric}:${limit}: no figure (the page's frame monitor did not answer)` };
  }
  const within = value <= limit;
  return {
    metric,
    limit,
    value,
    within,
    line: `budget ${metric}:${limit}: ${spec.label} ${value}${unit} is ${within ? 'within' : 'OVER'} the limit of ${limit}${unit}`,
    ...(spec.caution ? { caution: spec.caution } : {}),
  };
}

// A step is `command` or `command:arg:arg`. Returns { command, args } or throws
// one plain line naming what is wrong.
export function parseStep(token) {
  const [command, ...allArgs] = String(token).split(':');
  // #3817: any step may end in `:burst:<name>:<count>:<ms>`, which takes <count> stills <ms> apart
  // while the step runs (a held walk, a tap's animation), so motion can be seen.
  let args = allArgs;
  let burst = null;
  const burstAt = command === 'burst' ? -1 : allArgs.indexOf('burst');
  if (burstAt >= 0) {
    args = allArgs.slice(0, burstAt);
    burst = parseBurst(token, allArgs.slice(burstAt + 1));
  }
  const parsed = parseStepWithoutBurst(token, command, args);
  return burst ? { ...parsed, burst } : parsed;
}

function parseBurst(token, parts) {
  const [name, count, ms] = parts;
  if (parts.length !== 3 || !name) throw new Error(`step "${token}": burst needs a name, a count and milliseconds apart (burst:walk:4:500)`);
  if (!(Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= BURST_MAX_COUNT)) throw new Error(`step "${token}": burst count must be a whole number from 1 to ${BURST_MAX_COUNT}`);
  if (!(Number(ms) >= 50 && Number(ms) <= 5000)) throw new Error(`step "${token}": burst milliseconds apart must be from 50 to 5000`);
  return { name, count: Number(count), ms: Number(ms) };
}

function parseStepWithoutBurst(token, command, args) {
  const need = (n) => {
    if (args.length < n) throw new Error(`step "${token}": "${command}" needs ${n} argument(s)`);
  };
  switch (command) {
    case 'walk':
      need(1);
      if (!WALK_DIRECTIONS.includes(args[0])) throw new Error(`step "${token}": direction must be one of ${WALK_DIRECTIONS.join(', ')}`);
      if (args[1] !== undefined && !(Number(args[1]) > 0)) throw new Error(`step "${token}": milliseconds must be a positive number`);
      return { command, args: [args[0], Number(args[1] ?? 1000)] };
    case 'aim':
      need(1);
      if (!AIM_DIRECTIONS.includes(args[0])) throw new Error(`step "${token}": direction must be one of ${AIM_DIRECTIONS.join(', ')}`);
      if (args[1] !== undefined && !(Number(args[1]) > 0)) throw new Error(`step "${token}": milliseconds must be a positive number`);
      return { command, args: [args[0], Number(args[1] ?? 1000)] };
    case 'rise':
      // #4105: a thumb sliding along the right edge, up to rise and down to sink.
      need(1);
      if (!['up', 'down'].includes(args[0])) throw new Error(`step "${token}": direction must be up or down`);
      if (args[1] !== undefined && !(Number(args[1]) > 0)) throw new Error(`step "${token}": milliseconds must be a positive number`);
      return { command, args: [args[0], Number(args[1] ?? 1000)] };
    case 'look':
      need(2);
      if (!Number.isFinite(Number(args[0])) || !Number.isFinite(Number(args[1]))) throw new Error(`step "${token}": look needs two numbers (pixels right, pixels down)`);
      return { command, args: [Number(args[0]), Number(args[1])] };
    case 'tap':
      need(1);
      // tap:<x>:<y> at a point, or tap:<css selector> on a named control. A
      // selector may contain ":" (pseudo-classes), so rejoin everything.
      if (args.length === 2 && args.every((a) => a !== '' && Number.isFinite(Number(a)))) return { command, args: [Number(args[0]), Number(args[1])] };
      return { command, args: [args.join(':')] };
    case 'item': {
      // #3930: item[:n] taps the n-th placed item that is on screen in Build (counted left to right,
      // 1 by default), so the item's card and selection tools can be looked at without aiming at a pixel.
      const n = args[0] === undefined || args[0] === '' ? 1 : Number(args[0]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`step "${token}": item needs a whole number from 1 (which placed item, left to right)`);
      return { command, args: [n] };
    }
    case 'dragitem': {
      // #4198: dragitem:<n>:<dx>:<dy>: select the n-th placed item on screen in Build and drag it dx, dy pixels.
      need(3);
      const n = Number(args[0]);
      const dx = Number(args[1]);
      const dy = Number(args[2]);
      if (!Number.isInteger(n) || n < 1 || !Number.isFinite(dx) || !Number.isFinite(dy) || args.length !== 3) {
        throw new Error(`step "${token}": dragitem needs an item number from 1 and two pixel distances (dragitem:2:250:0)`);
      }
      return { command, args: [n, dx, dy] };
    }
    case 'mode':
      need(1);
      if (!MODES.includes(args[0])) throw new Error(`step "${token}": mode must be one of ${MODES.join(', ')}`);
      return { command, args: [args[0]] };
    case 'wait':
      need(1);
      if (!(Number(args[0]) >= 0)) throw new Error(`step "${token}": milliseconds must be a number`);
      return { command, args: [Number(args[0])] };
    case 'slow': {
      // slow:<rate>: the page's CSS animations and transitions run at that fraction of their speed
      // (slow:0.1 is ten times slower), so a burst can catch a 300 ms unfold even where each still
      // takes longer than that; slow:1 puts them back (#3876).
      need(1);
      if (!(Number(args[0]) >= 0.02 && Number(args[0]) <= 1)) throw new Error(`step "${token}": slow needs a rate from 0.02 to 1 (slow:0.1 is ten times slower, slow:1 is normal)`);
      return { command, args: [Number(args[0])] };
    }
    case 'key':
      // key:KeyN, key:Escape, key:Shift+KeyN: one Playwright key name.
      need(1);
      if (!/^[A-Za-z0-9+]+$/.test(args[0])) throw new Error(`step "${token}": key needs a key name such as KeyN, Escape or Shift+KeyN`);
      return { command, args: [args[0]] };
    case 'shot':
      return { command, args: [args[0] || ''] };
    case 'burst': {
      const { name, count, ms } = parseBurst(token, args);
      return { command, args: [name, count, ms] };
    }
    case 'petal':
      need(1);
      if (!MODES.includes(args[0])) throw new Error(`step "${token}": petal must be one of ${MODES.join(', ')}`);
      return { command, args: [args[0]] };
    case 'leaf':
      need(1);
      if (!LEAVES.includes(args[0])) throw new Error(`step "${token}": leaf must be one of ${LEAVES.join(', ')}`);
      return { command, args: [args[0]] };
    case 'budget': {
      // budget:<metric>:<limit> (#3935): fail the run when the figures since the last lap (or the start)
      // pass a stated limit, so a change can say "within budget" with a number.
      need(2);
      if (!BUDGET_METRICS[args[0]]) throw new Error(`step "${token}": budget metric must be one of ${Object.keys(BUDGET_METRICS).join(', ')}`);
      if (args.length !== 2 || args[1] === '' || !(Number(args[1]) > 0)) throw new Error(`step "${token}": budget needs a limit above zero (budget:${args[0]}:600)`);
      return { command, args: [args[0], Number(args[1])] };
    }
    case 'peer': {
      // peer:join | peer:shot[:name] | peer:pos | peer:say:<text>: the second page's steps (--with, #3930).
      need(1);
      const [what, ...rest] = args;
      if (!PEER_STEPS.includes(what)) throw new Error(`step "${token}": peer must be one of ${PEER_STEPS.join(', ')}`);
      if (what === 'say') {
        const text = rest.join(':').trim();
        if (!text) throw new Error(`step "${token}": peer:say needs the words to say`);
        if (text.length > 280) throw new Error(`step "${token}": peer:say is at most 280 characters`);
        return { command, args: [what, text] };
      }
      return { command, args: [what, rest[0] || ''] };
    }
    case 'tp': {
      // tp:<landletId>: stand in the middle of that lándlet (#4491), so presence runs there.
      need(1);
      if (!/^[a-z0-9-]{3,80}$/.test(args[0])) throw new Error(`step "${token}": tp needs a lándlet id like central-mosaic-012`);
      return { command, args: [args[0]] };
    }
    case 'menu':
    case 'pushpeer':
    case 'land':
    case 'fly':
    case 'settings':
    case 'idle':
    case 'stats':
    case 'lap':
    case 'cover':
    case 'pos':
    case 'marks':
      return { command, args: [] };
    default:
      throw new Error(`unknown step "${token}" (steps: peer, walk, aim, rise, look, tap, item, dragitem, key, slow, mode, menu, petal, leaf, fly, land, tp, pushpeer, settings, wait, shot, burst, idle, stats, lap, budget, cover, pos, marks)`);
  }
}

// Screenshot names become file names: keep them to a safe set.
export function safeShotName(name, index) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${String(index).padStart(2, '0')}-${cleaned || 'shot'}.png`;
}

// Reduce a list of request durations (ms) to the figures a session reads.
export function summarizeTimings(durationsMs) {
  const sorted = durationsMs.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n) => Math.round(n * 10) / 10;
  return { count: sorted.length, minMs: round(sorted[0]), medianMs: round(at(0.5)), maxMs: round(sorted[sorted.length - 1]), avgMs: round(sum / sorted.length) };
}

// The route a request's URL belongs to, for grouping: path only, with long
// id-like segments replaced so /api/landlets/abc123 groups with its siblings.
export function routeOf(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return String(url);
  }
  return path.split('/').map((seg) => (/^[0-9a-f-]{8,}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg)).join('/');
}

// Playwright's request.timing() is relative to startTime; the request took
// responseEnd ms. -1 means "not available".
export function durationFromTiming(timing) {
  if (!timing || !(timing.responseEnd >= 0)) return null;
  return timing.responseEnd;
}

// The plain line printed when the gate refuses, never any header.
export function gateRefusalMessage(status) {
  return `The site answered ${status}: the preview gate did not accept this session, so the fleet key is not configured for this environment (see #3428). Nothing else was tried.`;
}

// The flags: --url, --name, --desktop, --login, --out, --timing (repeatable), --server-timing, --cover-report.
// Everything else is a step.
// #3736: `--throttle` -- a slow phone on a slow connection, so a wait that is
// invisible on fast hardware shows up. The standard "slow 4G" mobile profile.
export const THROTTLE_PROFILE = { name: 'throttle', cpuSlowdown: 4, latencyMs: 150, downKbps: 1600, upKbps: 750 };

// #3935: `--phone` -- what a frame costs on a phone, not on a cloud machine. The script side of this
// machine is far faster than a phone's, so the CPU is slowed 4x through the DevTools protocol, and the
// network is a phone on a home connection (20/5 Mbps, 40 ms), not a slow one: a figure from it is about
// the app's own work, where `--throttle` is about waiting on a bad connection. `limits` is printed in
// the report so a number is never read without it.
export const PHONE_PROFILE = {
  name: 'phone', cpuSlowdown: 4, latencyMs: 40, downKbps: 20000, upKbps: 5000,
  limits: 'Trust: long tasks, longest script task and request timings (the CPU is slowed 4x, the network is a phone on home wifi). '
    + 'Do not trust: frame time and anything GPU-bound (this is software GL, not a phone GPU, and its draw time says nothing of a real one). '
    + 'For the GPU use triangles and draw calls per frame (scripts/live-frame-cost.mjs), which do not depend on the machine.',
};

export function profileFor(options) {
  if (options.phone) return PHONE_PROFILE;
  if (options.throttle) return THROTTLE_PROFILE;
  return null;
}

// Slows the page the way the profile says. `cdp` is a DevTools session on the page.
export async function applyProfile(cdp, profile) {
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: profile.latencyMs, downloadThroughput: profile.downKbps * 1024 / 8, uploadThroughput: profile.upKbps * 1024 / 8,
  });
}

const PEER_STEPS = ['join', 'shot', 'pos', 'say'];

export function parseArgs(argv, env = {}) {
  const options = {
    url: env.LIVE_SITE_URL || 'https://higglehaven.com',
    query: '', // #4440: a query string for the landing page, such as ?bloom=ring, for a look behind a switch in the address
    name: env.LIVE_SITE_NAME || null,
    desktop: false,
    size: null,
    login: 'fleet',
    out: env.LIVE_SITE_OUT || null,
    timing: [],
    with: null,
    coverReport: false,
    throttle: false,
    phone: false,
    serverTiming: false,
  };
  const steps = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--url') options.url = value();
    else if (arg === '--query') options.query = value();
    else if (arg === '--name') options.name = value();
    else if (arg === '--desktop') options.desktop = true;
    else if (arg === '--size') options.size = touchDeviceForSize(value());
    else if (arg === '--login') options.login = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--timing') options.timing.push(value());
    else if (arg === '--with') options.with = value();
    else if (arg === '--cover-report') options.coverReport = true;
    else if (arg === '--throttle') options.throttle = true;
    else if (arg === '--phone') options.phone = true;
    else if (arg === '--server-timing') options.serverTiming = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else steps.push(parseStep(arg));
  }
  if (options.phone && options.throttle) throw new Error('--phone and --throttle do not go together: --phone is a phone on a home connection, --throttle a phone on a slow one');
  if (options.size && options.desktop) throw new Error('--size and --desktop do not go together: --size is a touch screen of that size');
  if (!['fleet', 'local'].includes(options.login)) throw new Error('--login must be "fleet" (the live site) or "local" (a wrangler dev instance)');
  if (!options.name) throw new Error('--name is required: this session\'s name, e.g. --name higglehaven10');
  if (options.login === 'fleet' && !FLEET_NAME_PATTERN.test(options.name)) throw new Error(`--name "${options.name}" is not a fleet name (higglehaven followed by digits)`);
  if (options.with !== null) {
    // #3930: a second signed-in page. On the live site only a fleet account may stand there: it is
    // never a real person's account, so nothing is ever done as one.
    if (options.login === 'fleet' && !FLEET_NAME_PATTERN.test(options.with)) throw new Error(`--with "${options.with}" is not a fleet name (higglehaven followed by digits): only fleet accounts may be used as a second page`);
    if (options.login === 'local' && !/^[a-z0-9][a-z0-9_-]{1,30}$/i.test(options.with)) throw new Error(`--with "${options.with}" is not a plain account name`);
    if (options.with === options.name) throw new Error('--with must be a different account from --name');
  }
  if (steps.some((step) => step.command === 'peer') && options.with === null) throw new Error('peer steps need --with <name>: a second account to stand beside this one');
  return { options, steps };
}

// #3464: a `Server-Timing` value from the worker ('d1;dur=42;desc="5 trips"') as numbers, or null.
export function parseServerTiming(value) {
  const match = /d1;dur=(\d+(?:\.\d+)?);desc="(\d+) trips?"/.exec(value || '');
  return match ? { d1Ms: Number(match[1]), trips: Number(match[2]) } : null;
}

// One line per timed route: how many D1 trips and how long they took, as medians over the runs seen.
export function summariseServerTimings(samples) {
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  return { runs: samples.length, d1MsMedian: median(samples.map((s) => s.d1Ms)), tripsMedian: median(samples.map((s) => s.trips)) };
}
