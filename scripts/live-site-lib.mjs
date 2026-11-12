// #3430 (part of #3428): the pure parts of scripts/live-site.mjs, the tool a
// fleet session uses to look at the running site the way a person does. Kept
// free of Playwright so the plain vitest pool can test them.

// The owner's usual view: a current Android phone.
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
export const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

export const FLEET_NAME_PATTERN = /^higglehaven[0-9]{1,3}$/;
export const WALK_DIRECTIONS = ['forward', 'back', 'left', 'right'];
export const MODES = ['shop', 'build', 'sell'];

// Joystick drag vector per direction, as a fraction of the joystick's radius
// (screen y grows downward, so "forward" is up).
export const WALK_VECTORS = {
  forward: [0, -1],
  back: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

// #3479: the camera is steered by the look joystick (held, it turns the view at a
// steady rate; up and down are the pitch), not by dragging the page, so `aim`
// holds that joystick. Directions are as the thumb moves it, on the screen.
export const AIM_VECTORS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
export const AIM_DIRECTIONS = Object.keys(AIM_VECTORS);

// A step is `command` or `command:arg:arg`. Returns { command, args } or throws
// one plain line naming what is wrong.
export function parseStep(token) {
  const [command, ...args] = String(token).split(':');
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
    case 'mode':
      need(1);
      if (!MODES.includes(args[0])) throw new Error(`step "${token}": mode must be one of ${MODES.join(', ')}`);
      return { command, args: [args[0]] };
    case 'wait':
      need(1);
      if (!(Number(args[0]) >= 0)) throw new Error(`step "${token}": milliseconds must be a number`);
      return { command, args: [Number(args[0])] };
    case 'shot':
      return { command, args: [args[0] || ''] };
    case 'fly':
    case 'settings':
    case 'idle':
    case 'stats':
      return { command, args: [] };
    default:
      throw new Error(`unknown step "${token}" (steps: walk, aim, look, tap, mode, wait, shot, fly, settings, idle, stats)`);
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

// The flags: --url, --name, --desktop, --login, --out, --timing (repeatable).
// Everything else is a step.
export function parseArgs(argv, env = {}) {
  const options = {
    url: env.LIVE_SITE_URL || 'https://higglehaven.com',
    name: env.LIVE_SITE_NAME || null,
    desktop: false,
    login: 'fleet',
    out: env.LIVE_SITE_OUT || null,
    timing: [],
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
    else if (arg === '--name') options.name = value();
    else if (arg === '--desktop') options.desktop = true;
    else if (arg === '--login') options.login = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--timing') options.timing.push(value());
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else steps.push(parseStep(arg));
  }
  if (!['fleet', 'local'].includes(options.login)) throw new Error('--login must be "fleet" (the live site) or "local" (a wrangler dev instance)');
  if (!options.name) throw new Error('--name is required: this session\'s name, e.g. --name higglehaven10');
  if (options.login === 'fleet' && !FLEET_NAME_PATTERN.test(options.name)) throw new Error(`--name "${options.name}" is not a fleet name (higglehaven followed by digits)`);
  return { options, steps };
}
