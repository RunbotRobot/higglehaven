#!/usr/bin/env node
// #3458 (part of #3444): the assistant's other shift commands. Each run signs in
// as the assistant's own fleet account, does one thing, prints the server's
// answer as one JSON line and exits. No browser, no cookie ever printed.
//
//   node scripts/assistant-reply.mjs --name juniper reply    <conversationId> --text "Hi! ..."
//   node scripts/assistant-reply.mjs --name juniper end      <conversationId>
//   node scripts/assistant-reply.mjs --name juniper escalate <conversationId> --text "They are asking about a refund."
//
// `escalate` files a card for the team; --text is YOUR short summary of what is
// being asked. The server adds the shopper's own words in a quoted field, so
// never paste their words into the summary. docs/API.md "Assistant chat".
import { spawnSync } from 'node:child_process';
import { parseArgs, loginNameFor, needsProxyRelaunch, createClient } from './assistant-lib.mjs';

const fail = (message) => {
  console.error(`assistant-reply: ${message}`);
  process.exit(1);
};

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2), ['name', 'url', 'text']);
} catch (error) { fail(error.message); }
const { options, positional } = parsed;
const [action, conversationId] = positional;
if (!options.name) fail('--name is required (for example --name juniper)');
if (!['reply', 'end', 'escalate'].includes(action)) fail('the first word must be reply, end or escalate');
if (!conversationId || !/^[A-Za-z0-9_-]+$/.test(conversationId)) fail('a conversation id is required after the command');
if (action !== 'end' && !(options.text || '').trim()) fail(`${action} needs --text "..."`);
const baseUrl = options.url || 'https://higglehaven.com';

if (needsProxyRelaunch(baseUrl, process.env)) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(child.status ?? 1);
}

try {
  const client = createClient({ baseUrl, loginName: loginNameFor(options.name), localFleetKey: process.env.LIVE_SITE_FLEET_KEY });
  await client.login();
  const path = `/api/assistant-inbox/conversations/${encodeURIComponent(conversationId)}/${action}`;
  const body = action === 'reply' ? { text: options.text } : action === 'escalate' ? { summary: options.text } : undefined;
  const result = await client.call('POST', path, body);
  process.stdout.write(`${JSON.stringify(result ?? { ok: true })}\n`);
} catch (error) {
  fail(error.message);
}
