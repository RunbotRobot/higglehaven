// #3430 (part of #3428): scripts/live-site.mjs, the tool a fleet session uses to
// look at the running site as a person does. Run against the local dev server
// with a throwaway fleet key: sign in through the real fleet login (#3429) as a fleet
// name, walk the avatar, take a phone-size screenshot, read back a timing for a
// known route and a frame-time figure, and check it never prints a cookie.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finish } from './helpers.mjs';

const exec = promisify(execFile);
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-site-e2e-'));

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

// run-all.mjs starts this file's wrangler dev with this throwaway fleet key.
const FLEET_KEY = 'e2e-fleet-key-not-a-secret';

async function run(args, { login = 'fleet', key = FLEET_KEY } = {}) {
  const env = { ...process.env };
  if (key) env.LIVE_SITE_FLEET_KEY = key;
  else delete env.LIVE_SITE_FLEET_KEY;
  try {
    const { stdout, stderr } = await exec('node', ['scripts/live-site.mjs', '--url', BASE_URL, '--login', login, '--out', outDir, ...args], { env, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

// ---- 1. A phone-size run: walk, screenshot, a timing, frame figures ----
const phone = await run(['--name', 'higglehaven9', '--timing', '/api/landlets', 'idle', 'walk:forward:1500', 'aim:up:300', 'aim:down:300', 'shot:walked', 'stats']);
check(phone.code === 0, `phone run exits 0 (code ${phone.code}, stderr ${phone.stderr.slice(0, 200)})`);
let report = {};
try {
  report = JSON.parse(phone.stdout);
} catch {
  check(false, `phone run prints one JSON report (got ${phone.stdout.slice(0, 200)})`);
}
check(report.device === 'phone', `defaults to the phone view (${report.device})`);
check(report.steps?.every((s) => s.ok), `every step succeeded (${JSON.stringify(report.steps)})`);
const shot = report.screenshots?.[0];
check(Boolean(shot) && fs.existsSync(shot) && fs.statSync(shot).size > 5000, `the screenshot exists and is not empty (${shot})`);
if (shot && fs.existsSync(shot)) {
  const png = fs.readFileSync(shot);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  check(width === 390 && height === 844, `the screenshot is phone size, 390x844 (${width}x${height})`);
}
const timingKeys = Object.keys(report.timings || {});
check(timingKeys.some((k) => k.includes('/api/landlets') && report.timings[k].count > 0 && report.timings[k].maxMs >= 0), `a timing is read back for /api/landlets (${timingKeys.join(', ')})`);
check(report.frame && Number.isFinite(report.frame.longestFrameMs) && report.frame.longestFrameMs > 0, `a frame-time figure is reported (${JSON.stringify(report.frame)})`);
check(report.frame && typeof report.frame.longTasks?.count === 'number', 'a long-task count is reported');
// #3483: where in the run a long task fell. Each step says when it ended in the
// page's clock, and the startup phase (before the first step) is reported on
// its own, so a stall on the title screen is not mistaken for one in flight.
check(report.steps?.every((s) => Number.isFinite(s.endedAtMs)), `every step reports when it ended (${JSON.stringify(report.steps)})`);
check(report.startup && typeof report.startup.longTasks?.count === 'number', `the startup phase is reported on its own (${JSON.stringify(report.startup)})`);
check(!/hh_session|set-cookie/i.test(phone.stdout + phone.stderr), 'no cookie or header appears in the output');

// ---- 2. Desktop on request ----
const desktop = await run(['--name', 'localtester', '--desktop', 'idle', 'shot'], { login: 'local' });
check(desktop.code === 0, `desktop run exits 0 (code ${desktop.code}, stderr ${desktop.stderr.slice(0, 200)})`);
try {
  const d = JSON.parse(desktop.stdout);
  const png = fs.readFileSync(d.screenshots[0]);
  check(d.device === 'desktop' && png.readUInt32BE(16) === 1280, `--desktop gives a 1280 wide view (${png.readUInt32BE(16)})`);
} catch {
  check(false, 'desktop run prints a report with a screenshot');
}

// ---- 2b. The fleet login: the key is required, and a refusal is one plain line ----
const noKey = await run(['--name', 'higglehaven9', 'idle'], { key: null });
check(noKey.code === 1 && /answered 404/.test(noKey.stderr), `without the key the fleet login is refused in one plain line (${noKey.stderr.trim().slice(0, 140)})`);
const wrongKey = await run(['--name', 'higglehaven9', 'idle'], { key: 'not-the-key' });
check(wrongKey.code === 1 && /answered 404/.test(wrongKey.stderr), `with a wrong key it is refused the same way (${wrongKey.stderr.trim().slice(0, 140)})`);
check(!(noKey.stdout + noKey.stderr + wrongKey.stdout + wrongKey.stderr + phone.stdout + phone.stderr).includes(FLEET_KEY), 'the fleet key never appears in any output');

// ---- 3. Plain failures: a bad step, and a name that is not a fleet name ----
const badStep = await run(['--name', 'higglehaven9', 'dance']);
check(badStep.code === 1 && /unknown step "dance"/.test(badStep.stderr), `an unknown step fails with one plain line (${badStep.stderr.trim().slice(0, 120)})`);
const liveBadName = await exec('node', ['scripts/live-site.mjs', '--url', BASE_URL, '--name', 'someone', 'idle']).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr }));
check(liveBadName.code === 1 && /not a fleet name/.test(liveBadName.stderr), `a non-fleet name is refused for the live login (${liveBadName.stderr.trim().slice(0, 120)})`);

fs.rmSync(outDir, { recursive: true, force: true });
await finish({ close: async () => {} }, { pass, label: '#3430: scripts/live-site.mjs signs in, walks, screenshots at phone size, and reports timings and frame figures without printing a credential' });
