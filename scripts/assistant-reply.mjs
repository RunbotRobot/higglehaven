#!/usr/bin/env node
// #3458 (part of #3444): the assistant's other shift commands. Each run signs in
// as the assistant's own fleet account, does one thing, prints the server's
// answer as one JSON line and exits. No browser, no cookie ever printed.
//
//   node scripts/assistant-reply.mjs --name juniper reply    <conversationId> --text "Hi! ..."
//   node scripts/assistant-reply.mjs --name juniper end      <conversationId>
//   node scripts/assistant-reply.mjs --name juniper escalate <conversationId> --text "They are asking about a refund."
//   node scripts/assistant-reply.mjs --name juniper handover <conversationId>
//
// `handover` passes the conversation to another assistant who is on shift and
// free (the server picks one; it answers 409 if nobody is). Tell the person who
// they are talking to now. The next assistant is given the conversation so far.
//
// A question left for the assistants (the shift program prints it as
// { "question": ... }) is answered or passed on by its id:
//   node scripts/assistant-reply.mjs --name juniper answer-question   <questionId> --text "Open Sell mode ..."
//   node scripts/assistant-reply.mjs --name juniper escalate-question <questionId> --text "They are asking about a refund." --say "I have passed this to the team."
//
// `escalate-question` also needs `--say`: what the person reads, because a person who left a question is
// not in a conversation and hears nothing else (#3748). `--text` is for the team, `--say` is for them.
// `--kind problem|suggestion|question` says what the card is (a bug, an idea, or
// a request for help; left out, it is a question), so the team can tell them
// apart (#3532). `escalate` files a card for the team; --text is YOUR short summary of what is
// being asked. The server adds the shopper's own words in a quoted field, so
// never paste their words into the summary. docs/API.md "Assistant chat".
// --text is refused unless it is one plain line (checkCommandText, #3523).
import { spawnSync } from 'node:child_process';
import { parseArgs, loginNameFor, needsProxyRelaunch, resolveBaseUrl, createClient, checkCommandText, accentLandlets } from './assistant-lib.mjs';

const fail = (message) => {
  console.error(`assistant-reply: ${message}`);
  process.exit(1);
};

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2), ['name', 'url', 'text', 'kind', 'say']);
} catch (error) { fail(error.message); }
const { options, positional } = parsed;
const [action, conversationId] = positional; // the id is a conversation's, or a question's for the two *-question commands
if (!options.name) fail('--name is required (for example --name juniper)');
if (!['reply', 'end', 'escalate', 'handover', 'answer-question', 'escalate-question'].includes(action)) {
  fail('the first word must be reply, end, escalate, handover, answer-question or escalate-question');
}
if (!conversationId || !/^[A-Za-z0-9_-]+$/.test(conversationId)) fail('an id is required after the command');
if (action !== 'end' && action !== 'handover' && !(options.text || '').trim()) fail(`${action} needs --text "..."`);
if (action === 'escalate-question' && !(options.say || '').trim()) fail('escalate-question needs --say "...": what the person will read, as well as --text for the team');
if (options.say !== undefined && action !== 'escalate-question') fail('--say goes only with escalate-question');
for (const value of [options.text, options.say]) {
  if (value === undefined) continue;
  const problem = checkCommandText(value);
  if (problem) fail(problem);
}
if (options.kind !== undefined && !['problem', 'suggestion', 'question'].includes(options.kind)) fail('--kind must be problem, suggestion or question');
if (options.kind !== undefined && !action.startsWith('escalate')) fail('--kind goes with escalate or escalate-question');
let baseUrl;
try { baseUrl = resolveBaseUrl(options.url); } catch (error) { fail(error.message); }

if (needsProxyRelaunch(baseUrl, process.env)) {
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(child.status ?? 1);
}

try {
  const client = createClient({ baseUrl, loginName: loginNameFor(options.name), localFleetKey: process.env.LIVE_SITE_FLEET_KEY });
  // #3748: a 5xx (a deploy landing at the wrong second) on sign-in or on the call is tried once
  // more after a short pause; a 4xx never is.
  const retryOnce = async (fn) => {
    try { return await fn(); } catch (error) {
      if (!(error?.status >= 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return fn();
    }
  };
  await retryOnce(() => client.login());
  const id = encodeURIComponent(conversationId);
  const path = {
    reply: `/api/assistant-inbox/conversations/${id}/reply`,
    end: `/api/assistant-inbox/conversations/${id}/end`,
    escalate: `/api/assistant-inbox/conversations/${id}/escalate`,
    handover: `/api/assistant-inbox/conversations/${id}/handover`,
    'answer-question': `/api/assistant-inbox/questions/${id}/answer`,
    'escalate-question': `/api/assistant-inbox/questions/${id}/escalate`,
  }[action];
  // #3613: what a shopper will read gets the lándlet accent restored if the model dropped it.
  const shopperText = options.text === undefined ? undefined : accentLandlets(options.text);
  const body = { reply: { text: shopperText }, 'answer-question': { text: shopperText }, escalate: { summary: options.text, kind: options.kind }, 'escalate-question': { summary: options.text, kind: options.kind, say: options.say === undefined ? undefined : accentLandlets(options.say) } }[action];
  const result = await retryOnce(() => client.call('POST', path, body));
  process.stdout.write(`${JSON.stringify(result ?? { ok: true })}\n`);
} catch (error) {
  fail(error.message);
}
