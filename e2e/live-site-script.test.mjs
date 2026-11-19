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

// ---- 4. The flower's steps and motion stills (#3817) ----
const flower = await run(['--name', 'higglehaven9', 'idle', 'land', 'walk:forward:800:burst:walk:3:300', 'menu', 'leaf:settings', 'shot:settings']);
check(flower.code === 0, `land, a walk with a burst, menu and a leaf all run (code ${flower.code}, stderr ${flower.stderr.slice(0, 200)})`);
try {
  const f = JSON.parse(flower.stdout);
  const stills = f.screenshots.filter((file) => /-walk-\d\.png$/.test(file));
  check(stills.length === 3 && stills.every((file) => fs.existsSync(file) && fs.statSync(file).size > 5000), `the burst gives three numbered stills (${stills.join(', ')})`);
} catch {
  check(false, 'the flower run prints a report');
}
// A control a step cannot find is one plain line naming the step, within 40 seconds.
const missing = await run(['--name', 'higglehaven9', 'idle', 'tap:#no-such-control']);
check(missing.code === 2 && /step "tap:#no-such-control" failed: "#no-such-control" is not on screen/.test(missing.stderr), `a control that is not there fails with one line naming the step (${missing.stderr.trim().slice(0, 160)})`);

// #3930: --with opens a second signed-in page; peer steps move, photograph and speak for it, and its
// errors are reported apart. Against a local server any two plain names will do.
const twoPages = await run(['--name', 'localtester', '--with', 'localfriend', 'idle', 'land', 'peer:join', 'peer:shot:beside', 'peer:pos'], { login: 'local' });
check(twoPages.code === 0, `a run with a second page exits 0 (code ${twoPages.code}, stderr ${twoPages.stderr.slice(0, 300)})`);
try {
  const t = JSON.parse(twoPages.stdout);
  check(t.steps.every((st) => st.ok), `every step, peer steps included, succeeded (${JSON.stringify(t.steps)})`);
  check(t.peer?.name === 'localfriend' && Array.isArray(t.peer.consoleErrors), `the second page is reported apart (${JSON.stringify(t.peer)})`);
  const peerShot = t.screenshots.find((file) => /peer-beside/.test(file));
  check(Boolean(peerShot) && fs.existsSync(peerShot) && fs.statSync(peerShot).size > 5000, `the second page's screenshot exists (${peerShot})`);
  const join = t.steps.find((st) => st.step === 'peer:join');
  check(join?.pos?.avatar && Number.isFinite(join.pos.avatar.x), `peer:join reports where the second avatar stands (${JSON.stringify(join)})`);
} catch {
  check(false, `the two-page run prints a report (${twoPages.stdout.slice(0, 200)})`);
}
// A throwaway local account is not ID-verified, so it cannot chat: peer:say says why in one line.
const cannotSay = await run(['--name', 'localtester', '--with', 'localfriend', 'idle', 'peer:say:hello'], { login: 'local' });
check(cannotSay.code === 2 && /not ID-verified/.test(cannotSay.stderr), `peer:say on an unverified account fails with one plain line (${cannotSay.stderr.trim().slice(0, 200)})`);
// On the live site only a fleet account may be the second page, and it stops before any browser opens.
const notFleet = await run(['--name', 'higglehaven9', '--with', 'someoneelse', 'idle']);
check(notFleet.code === 1 && /only fleet accounts/.test(notFleet.stderr), `a non-fleet second account is refused (${notFleet.stderr.trim().slice(0, 160)})`);

fs.rmSync(outDir, { recursive: true, force: true });
await finish({ close: async () => {} }, { pass, label: '#3430: scripts/live-site.mjs signs in, walks, screenshots at phone size, and reports timings and frame figures without printing a credential' });
