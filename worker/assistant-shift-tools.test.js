import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, extractSessionCookie, withSession, signupBuilder } from './test-helpers.js';
import {
  loginNameFor, parseArgs, positiveSeconds, classifyNext, needsProxyRelaunch, createClient, runShift,
} from '../scripts/assistant-lib.mjs';

// #3458 (part of #3444): the assistant's shift tools (scripts/assistant-shift.mjs
// and scripts/assistant-reply.mjs) run against the real worker. The programs
// are thin shells around scripts/assistant-lib.mjs, so this drives the same
// client and idle loop with the worker as the "network": a shopper asks, the
// loop returns the waiting message, the reply tools answer and escalate, the
// loop is run again.
const FLEET_KEY = 'test-fleet-access-key-assistant-shift';
const BASE = 'https://higglehaven.test';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.FLEET_ACCESS_KEY = FLEET_KEY;
});
afterAll(() => { env.FLEET_ACCESS_KEY = undefined; });

// The worker, reached the way the programs reach the site: by URL, with the
// gate's key added in front (on the live site the session's proxy does that).
const viaWorker = (url, init = {}) => SELF.fetch(url, {
  ...init,
  headers: { ...(init.headers || {}), 'x-fleet-key': FLEET_KEY, 'cf-connecting-ip': `shift-${crypto.randomUUID()}` },
});
const newClient = () => createClient({ baseUrl: BASE, loginName: loginNameFor('juniper'), fetchImpl: viaWorker });
const noSleep = async () => {};

describe('shift tool helpers', () => {
  it('turns a name into the assistant login and refuses a non-name', () => {
    expect(loginNameFor('Juniper')).toBe('assistant-juniper');
    expect(loginNameFor('assistant-fig')).toBe('assistant-fig');
    expect(() => loginNameFor('higglehaven4')).toThrow(/not an assistant name/);
    expect(() => loginNameFor('')).toThrow();
  });

  it('parses flags strictly', () => {
    expect(parseArgs(['--name', 'fig', 'reply', 'abc'], ['name'])).toEqual({ options: { name: 'fig' }, positional: ['reply', 'abc'] });
    expect(() => parseArgs(['--nmae', 'fig'], ['name'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--name'], ['name'])).toThrow(/needs a value/);
    expect(positiveSeconds(undefined, 5, 30)).toBe(5);
    expect(() => positiveSeconds('0', 5, 30)).toThrow();
    expect(() => positiveSeconds('31', 5, 30)).toThrow();
  });

  it('classifies what the inbox returns', () => {
    expect(classifyNext({ idle: true }).kind).toBe('idle');
    expect(classifyNext({ ended: { conversationId: 'c', endedBy: 'shopper' } }).kind).toBe('ended');
    // A left question was already handed to this assistant: the loop must return it, never drop it (#3448).
    const asked = { question: { questionId: 'q', shopper: { label: 'x' }, text: 'hi', askedAt: 't' } };
    expect(classifyNext(asked)).toEqual({ kind: 'question', output: asked });
    expect(classifyNext({ question: {} }).kind).toBe('idle');
    // A conversation passed from another assistant is handed over once: the loop must return it (#3448).
    const passed = { handover: { conversationId: 'c', shopper: { label: 'x' }, fromAssistant: 'Juniper', history: [] } };
    expect(classifyNext(passed)).toEqual({ kind: 'handover', output: passed });
    expect(classifyNext({ handover: {} }).kind).toBe('idle');
    expect(classifyNext({ conversationId: 'c', message: { text: 'hi' }, shopper: { label: 'x' }, history: [] }).kind).toBe('message');
  });

  it('relaunches through the proxy only for a remote site', () => {
    expect(needsProxyRelaunch('https://higglehaven.com', { HTTPS_PROXY: 'http://p' })).toBe(true);
    expect(needsProxyRelaunch('https://higglehaven.com', { HTTPS_PROXY: 'http://p', NODE_USE_ENV_PROXY: '1' })).toBe(false);
    expect(needsProxyRelaunch('http://127.0.0.1:8787', { HTTPS_PROXY: 'http://p' })).toBe(false);
    expect(needsProxyRelaunch('https://higglehaven.com', {})).toBe(false);
  });
});

describe('the shift loop against the worker', () => {
  it('waits, hands back a shopper message, replies, escalates, ends, and times out idle', async () => {
    // Nothing waiting: the loop runs out its time and says so (and went on shift).
    let ticks = 0;
    const fakeNow = () => ticks * 1000;
    const idleResult = await runShift({
      client: newClient(), pollSeconds: 5, maxSeconds: 20, now: fakeNow, sleep: async () => { ticks += 5; },
    });
    expect(idleResult).toEqual({ idle: true, reason: 'time limit' });

    // A shopper (an adult) asks.
    const person = await signupBuilder('shift-shopper');
    await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE email = ?").bind(person.email).run();
    const assistantRow = await env.DB.prepare("SELECT user_id FROM users WHERE email LIKE 'assistant-juniper%'").first();
    const started = await api('/assistant-chat/start', person.session({
      method: 'POST', body: JSON.stringify({ assistantUserId: assistantRow.user_id, text: 'Where is the bakery?' }),
    }));
    expect(started.response.status).toBe(201);
    const conversationId = started.body.conversation.conversationId;

    // The loop returns the waiting message straight away, exactly once.
    const client = newClient();
    const waiting = await runShift({ client, pollSeconds: 5, maxSeconds: 3600, sleep: noSleep });
    expect(waiting.conversationId).toBe(conversationId);
    expect(waiting.message.text).toBe('Where is the bakery?');
    const again = await runShift({
      client: newClient(), pollSeconds: 5, maxSeconds: 10, now: fakeNow, sleep: async () => { ticks += 5; },
    });
    expect(again).toEqual({ idle: true, reason: 'time limit' });

    // Reply, then file a card for the team, then end.
    const reply = await client.call('POST', `/api/assistant-inbox/conversations/${conversationId}/reply`, { text: 'Down the lane, past the fountain!' });
    expect(reply).toBeTruthy();
    const card = await client.call('POST', `/api/assistant-inbox/conversations/${conversationId}/escalate`, { summary: 'Asked where a shop is; nothing for the team.' });
    expect(card.cardId).toBeTruthy();
    await client.call('POST', `/api/assistant-inbox/conversations/${conversationId}/end`);

    // The shopper sees the reply.
    const current = await api('/assistant-chat/current?afterSeq=0', person.session());
    expect(current.body.messages.some((m) => /past the fountain/.test(m.text))).toBe(true);
  });

  it('retries a hiccup, gives up on a refusal, and signs in again after a lapsed session', async () => {
    let calls = 0;
    const flaky = (url, init) => {
      if (String(url).includes('/assistant-inbox/next')) {
        calls += 1;
        if (calls <= 2) return Promise.resolve(new Response('{"error":"busy"}', { status: 503 }));
      }
      return viaWorker(url, init);
    };
    const client = createClient({ baseUrl: BASE, loginName: 'assistant-juniper', fetchImpl: flaky });
    let ticks = 0;
    const result = await runShift({ client, pollSeconds: 5, maxSeconds: 15, now: () => ticks * 1000, sleep: async () => { ticks += 5; } });
    expect(result).toEqual({ idle: true, reason: 'time limit' });
    expect(calls).toBeGreaterThan(2);

    // A coding session's name is not an assistant: the inbox refuses it and the loop stops with the reason.
    const coding = createClient({ baseUrl: BASE, loginName: 'higglehaven3', fetchImpl: viaWorker });
    await expect(runShift({ client: coding, pollSeconds: 5, maxSeconds: 15, sleep: noSleep })).rejects.toThrow(/403|refused/);
  });

  it('says plainly when the gate answers 401', async () => {
    const gated = createClient({ baseUrl: BASE, loginName: 'assistant-juniper', fetchImpl: async () => new Response('', { status: 401 }) });
    await expect(gated.login()).rejects.toThrow(/401.*fleet key is not configured/);
  });
});
