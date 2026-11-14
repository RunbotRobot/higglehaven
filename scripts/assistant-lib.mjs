// #3458 (part of #3444): the parts of the assistant shift tools that need no
// network, plus the small HTTP client they share. An assistant is a separate
// Claude Code session whose only tools are a shell and these programs; it has
// no repository, no browser and no credentials beyond the live site's gate
// (which the session's network proxy adds, so no key is ever read here).
//
// Never prints or stores a cookie or a header value: the session cookie lives
// in memory for the length of one program run.

// The assistant's login is `assistant-` plus its agent name in lower case
// (docs/API.md "Agent names"); the worker holds the real list.
export const ASSISTANT_LOGIN_PATTERN = /^assistant-[a-z]{2,20}$/;
export const POLL_SECONDS_DEFAULT = 5;
// The server counts an assistant on shift for 90 seconds after its last
// request, so a poll slower than this would let it drop out of the world.
export const POLL_SECONDS_MAX = 30;
export const SHIFT_SECONDS_DEFAULT = 55 * 60;

// `--name juniper` (or `--name assistant-juniper`) -> the login name.
// #3523: the text of a reply, summary or answer is typed into a shell command
// line, and the permission rules match the command text. So that a stranger's
// words can never become part of a command, a --text is one line of at most
// TEXT_MAX characters made only of letters, digits, spaces and plain
// punctuation: never a double quote, dollar sign, backtick, backslash or line
// break (the characters that can end the quotes or start a substitution).
// Returns null when the text is fine, otherwise one plain sentence saying why.
export const TEXT_MAX = 1000;
export function checkCommandText(text) {
  const value = String(text ?? '');
  if (value.length > TEXT_MAX) return `--text is too long (${value.length} characters; at most ${TEXT_MAX})`;
  if (!/^[\p{L}\p{N} .,;:!?'()/-]+$/u.test(value)) {
    return 'the text may only use letters, digits, spaces and . , ; : ! ? \' ( ) / - on one line; never a double quote, dollar sign, backtick, backslash or line break';
  }
  return null;
}

export function loginNameFor(name) {
  const lower = String(name || '').trim().toLowerCase();
  const login = lower.startsWith('assistant-') ? lower : `assistant-${lower}`;
  if (!ASSISTANT_LOGIN_PATTERN.test(login)) throw new Error(`"${name}" is not an assistant name (use a name like juniper)`);
  return login;
}

// Flags are `--flag value`; the rest are positional. Unknown flags are errors,
// so a typo is not silently ignored.
export function parseArgs(argv, allowed) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (!allowed.includes(key)) throw new Error(`unknown flag --${key}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      options[key] = value;
      i += 1;
    } else positional.push(token);
  }
  return { options, positional };
}

export function positiveSeconds(value, fallback, max = Infinity) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!(n > 0) || n > max) throw new Error(`"${value}" is not a number of seconds between 1 and ${max}`);
  return n;
}

// What the idle loop does with one /next reply. `message`, `question` and
// `ended` hand control back to the session (the program prints it and exits);
// a `handover` is a conversation another assistant passed to this one: it is
// handed over once, so dropping it would leave the shopper waiting (#3448);
// anything else keeps waiting. A `question` is one the server has already
// handed to this assistant, so dropping it here would leave it stuck until it
// times out (#3448).
export function classifyNext(body) {
  if (body && body.conversationId && body.message) return { kind: 'message', output: body };
  if (body && body.handover && body.handover.conversationId) return { kind: 'handover', output: body };
  if (body && body.question && body.question.questionId) return { kind: 'question', output: body };
  if (body && body.ended) return { kind: 'ended', output: body };
  return { kind: 'idle' };
}

// The program talks to the live site through the session's proxy; a plain Node
// process does not use HTTPS_PROXY unless asked, so a run against anything but
// a local server re-runs itself with that switched on.
export function needsProxyRelaunch(baseUrl, env) {
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(baseUrl);
  return !isLocal && Boolean(env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY;
}

// The address the programs talk to is fixed: the live site, or a local server
// for testing. A permission rule that lets `--name juniper reply ...` through
// also lets later flags through, so --url must not be able to point a session's
// requests (and the fleet key its proxy adds) anywhere else.
export const LIVE_SITE_URL = 'https://higglehaven.com';
export function resolveBaseUrl(url) {
  if (url === undefined) return LIVE_SITE_URL;
  const trimmed = String(url).replace(/\/$/, '');
  if (trimmed === LIVE_SITE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(trimmed)) return trimmed;
  throw new Error('--url may only be the live site or a local server');
}

export class SiteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createClient({ baseUrl, loginName, fetchImpl = fetch, localFleetKey }) {
  const base = baseUrl.replace(/\/$/, '');
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base);
  let cookie = '';
  const headers = (extra = {}) => ({
    'content-type': 'application/json',
    // Only for a local server started with its own throwaway key; on the live
    // site the proxy adds the gate's key and this stays unset.
    ...(localFleetKey && isLocal ? { 'x-fleet-key': localFleetKey } : {}),
    ...(cookie ? { cookie } : {}),
    ...extra,
  });
  async function raw(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    let json = null;
    try { json = await response.json(); } catch { /* not JSON */ }
    return { status: response.status, json };
  }
  async function login() {
    const { status, json } = await raw('POST', '/api/auth/fleet-login', { name: loginName });
    if (status === 401) throw new SiteError('the live site answered 401: the fleet key is not configured for this environment', 401);
    if (status !== 200 && status !== 201) throw new SiteError(`sign-in refused (${status}): ${json?.error || 'no reason given'}`, status);
  }
  // One request; signs in again once if the session lapsed.
  async function call(method, path, body) {
    let result = await raw(method, path, body);
    if (result.status === 401 || result.status === 403) {
      await login();
      result = await raw(method, path, body);
    }
    if (result.status >= 400) throw new SiteError(`${method} ${path} failed (${result.status}): ${result.json?.error || 'no reason given'}`, result.status);
    return result.json;
  }
  return { login, call };
}

// The idle loop. Signs in, goes on shift, then polls until a shopper writes, a
// conversation ends without the assistant, or the time runs out. Returns the one
// object the program prints. A short network or server hiccup (a 5xx, a 429 or
// no answer at all) is retried; anything else, or five in a row, throws.
export async function runShift({ client, pollSeconds, maxSeconds, sleep, now = Date.now }) {
  await client.login();
  await client.call('POST', '/api/assistant-inbox/heartbeat');
  const deadline = now() + maxSeconds * 1000;
  let failures = 0;
  while (now() < deadline) {
    let body;
    try {
      body = await client.call('GET', '/api/assistant-inbox/next');
      failures = 0;
    } catch (error) {
      failures += 1;
      const retryable = !error.status || error.status >= 500 || error.status === 429;
      if (failures >= 5 || !retryable) throw error;
      await sleep(pollSeconds * 1000);
      continue;
    }
    const outcome = classifyNext(body);
    if (outcome.kind !== 'idle') return outcome.output;
    await sleep(pollSeconds * 1000);
  }
  return { idle: true, reason: 'time limit' };
}
