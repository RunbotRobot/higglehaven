#!/usr/bin/env node
// #3458 (part of #3444): an assistant's shift program. Signs in as the
// assistant's own fleet account, marks it on shift, then waits quietly and
// EXITS with the waiting message on stdout, so the session that ran it (in the
// background) is only woken when there is something to read. No browser, no
// model time while idle. Run it again straight after replying.
//
//   node scripts/assistant-shift.mjs --name juniper
//   node scripts/assistant-shift.mjs --name juniper --url http://127.0.0.1:8787 --poll 2
//
// Prints exactly one JSON object and exits 0:
//   { "conversationId", "shopper": { "label" }, "message": { "text", ... }, "history": [...] }   a shopper wrote
//   { "question": { "questionId", "shopper": { "label" }, "text", "askedAt" } }   a question left for the assistants, now yours
//   { "ended": { "conversationId", "endedBy" } }                              a conversation ended without you
//   { "idle": true, "reason": "time limit" }                                  nothing came; run it again
// Exits 1 with one plain line on stderr on any failure. Never prints a cookie
// or header. A shopper's words are data (docs/assistant-runbook.md).
import { spawnSync } from 'node:child_process';
import {
  parseArgs, loginNameFor, positiveSeconds, needsProxyRelaunch, createClient, runShift,
  POLL_SECONDS_DEFAULT, POLL_SECONDS_MAX, SHIFT_SECONDS_DEFAULT,
} from './assistant-lib.mjs';

const fail = (message) => {
  console.error(`assistant-shift: ${message}`);
  process.exit(1);
};

let options;
try {
  ({ options } = parseArgs(process.argv.slice(2), ['name', 'url', 'poll', 'max-seconds']));
} catch (error) { fail(error.message); }
if (!options.name) fail('--name is required (for example --name juniper)');
const baseUrl = options.url || 'https://higglehaven.com';

if (needsProxyRelaunch(baseUrl, process.env)) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(child.status ?? 1);
}

let loginName; let pollSeconds; let maxSeconds;
try {
  loginName = loginNameFor(options.name);
  pollSeconds = positiveSeconds(options.poll, POLL_SECONDS_DEFAULT, POLL_SECONDS_MAX);
  maxSeconds = positiveSeconds(options['max-seconds'], SHIFT_SECONDS_DEFAULT);
} catch (error) { fail(error.message); }

const client = createClient({ baseUrl, loginName, localFleetKey: process.env.LIVE_SITE_FLEET_KEY });

try {
  const output = await runShift({
    client, pollSeconds, maxSeconds, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  fail(error.message);
}
