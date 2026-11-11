// #3458 (part of #3444): the assistant's shift programs, run as real processes
// against the local dev server with a throwaway fleet key. The shift program
// signs in as the assistant, goes on shift and waits; a scripted shopper (an
// adult, signed up through the API) asks a question; the program exits with
// the waiting message on stdout; the reply program answers, files a card and
// ends the conversation; the shopper reads the reply. No browser. Nothing
// printed may contain a cookie or the key.
import { execSync, spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { finish } from './helpers.mjs';

const exec = promisify(execFile);
const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8787';
const FLEET_KEY = 'e2e-fleet-key-not-a-secret';
const root = new URL('..', import.meta.url).pathname;
const env = { ...process.env, LIVE_SITE_FLEET_KEY: FLEET_KEY };

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const d1 = (sql) => JSON.parse(execSync(`npx wrangler d1 execute higglehaven-db --local --json --command "${sql}"`, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString());

async function reply(args) {
  try {
    const { stdout, stderr } = await exec('node', ['scripts/assistant-reply.mjs', '--url', BASE_URL, '--name', 'juniper', ...args], { cwd: root, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

// The shift program in the background, polling fast for the test.
const shift = spawn('node', ['scripts/assistant-shift.mjs', '--url', BASE_URL, '--name', 'juniper', '--poll', '1', '--max-seconds', '120'], { cwd: root, env });
let shiftOut = ''; let shiftErr = '';
shift.stdout.on('data', (d) => { shiftOut += d; });
shift.stderr.on('data', (d) => { shiftErr += d; });
const shiftExited = new Promise((resolve) => shift.on('exit', (code) => resolve(code)));

// A scripted shopper: an adult, through the real signup.
const email = `shift-shopper-${Date.now()}@example.com`;
const signup = await fetch(`${BASE_URL}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password: 'a fine long password here', username: 'ShiftShopper', ageAttested: true }),
});
check(signup.status === 201 || signup.status === 200, `shopper signs up (${signup.status})`);
const cookie = signup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
d1(`UPDATE users SET trust_tier = 'id_verified' WHERE email = '${email}'`);

// Wait for the assistant account to exist and be on shift, then ask.
let assistantUserId = null; let started = null;
for (let i = 0; i < 30 && !(started && started.status === 201); i += 1) {
  const rows = d1("SELECT user_id FROM users WHERE email LIKE 'assistant-juniper%'")[0].results;
  assistantUserId = rows[0]?.user_id || null;
  if (assistantUserId) {
    started = await fetch(`${BASE_URL}/api/assistant-chat/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ assistantUserId, text: 'Where do I find the bakery?' }),
    });
  }
  if (!(started && started.status === 201)) await sleep(1000);
}
check(started && started.status === 201, `the shopper's question is accepted once the assistant is on shift (${started && started.status})`);
const conversationId = (await started.json()).conversation?.conversationId;

// The shift program exits with the message.
const code = await Promise.race([shiftExited, sleep(30000).then(() => 'timeout')]);
check(code === 0, `the shift program exits 0 when a question arrives (${code}; ${shiftErr.trim().slice(0, 160)})`);
let waiting = {};
try { waiting = JSON.parse(shiftOut); } catch { check(false, `the shift program prints one JSON object (${shiftOut.slice(0, 160)})`); }
check(waiting.conversationId === conversationId, 'it names the conversation');
check(waiting.message?.text === 'Where do I find the bakery?', `it carries the shopper's words (${JSON.stringify(waiting.message)})`);
if (code === 'timeout') shift.kill();

// Reply, then escalate, then end.
const sent = await reply(['reply', conversationId, '--text', 'Down the lane, past the fountain!']);
check(sent.code === 0, `reply succeeds (${sent.stderr.trim().slice(0, 160)})`);
const current = await (await fetch(`${BASE_URL}/api/assistant-chat/current?afterSeq=0`, { headers: { cookie } })).json();
check((current.messages || []).some((m) => /past the fountain/.test(m.text)), 'the shopper reads the reply');
const filed = await reply(['escalate', conversationId, '--text', 'Asked where a shop is; nothing for the team.']);
check(filed.code === 0 && JSON.parse(filed.stdout || '{}').cardId, `escalate files a card (${filed.stderr.trim().slice(0, 160)} ${filed.stdout.slice(0, 80)})`);
const ended = await reply(['end', conversationId]);
check(ended.code === 0, `end succeeds (${ended.stderr.trim().slice(0, 160)})`);

// Plain failures, one line each.
const noText = await reply(['reply', conversationId]);
check(noText.code === 1 && /needs --text/.test(noText.stderr), `a reply with no text is refused (${noText.stderr.trim()})`);
const badName = await exec('node', ['scripts/assistant-shift.mjs', '--url', BASE_URL, '--name', 'higglehaven4'], { cwd: root, env }).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr }));
check(badName.code === 1 && /not an assistant name/.test(badName.stderr), `a coding session's name is not an assistant (${badName.stderr.trim()})`);

check(!(shiftOut + shiftErr + sent.stdout + sent.stderr + filed.stdout + filed.stderr).match(new RegExp(`hh_session|set-cookie|${FLEET_KEY}`, 'i')), 'no cookie or key appears in any output');

await finish({ close: async () => {} }, { pass, label: '#3458: the assistant shift programs wait, hand back a question, reply, file a card and end, without printing a credential' });
