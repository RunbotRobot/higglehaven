import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder } from './test-helpers.js';

// Own file (own D1/worker isolate — see test-helpers.js's own comment on
// why the suite is split by file) specifically so setting
// env.DIDIT_WEBHOOK_SECRET here can't leak into worker/reviews-auth.test.js,
// which relies on it staying unset to exercise the 503-unconfigured path
// for the same endpoint. DIDIT_API_KEY is deliberately left unset even in
// this file — nothing here needs a real outbound call to Didit, only the
// webhook's own signature verification and DB reconciliation.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.DIDIT_WEBHOOK_SECRET = 'test-didit-webhook-secret';
});

afterAll(() => {
  env.DIDIT_WEBHOOK_SECRET = undefined;
});

async function signDiditPayload(payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.DIDIT_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return [...signatureBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function postDiditWebhook(payloadObject, { signature, body } = {}) {
  const rawBody = body !== undefined ? body : JSON.stringify(payloadObject);
  const headers = { 'content-type': 'application/json' };
  headers['x-signature'] = signature !== undefined ? signature : await signDiditPayload(rawBody);
  return SELF.fetch('https://higglehaven.test/api/auth/didit-webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

async function insertPendingSession(email) {
  const sessionId = `sess-${crypto.randomUUID()}`;
  await env.DB.prepare(`
    INSERT INTO didit_verification_sessions (session_id, user_id, status)
    VALUES (?, (SELECT user_id FROM users WHERE email = ?), 'pending')
  `).bind(sessionId, email).run();
  return sessionId;
}

describe('Didit verification webhook (#589)', () => {
  it('rejects a webhook with a missing or wrong signature', async () => {
    const builder = await signupBuilder('didit-webhook-badsig');
    const sessionId = await insertPendingSession(builder.email);

    const noSig = await postDiditWebhook({ session_id: sessionId, status: 'Approved' }, { signature: '' });
    expect(noSig.status).toBe(401);

    const wrongSig = await postDiditWebhook({ session_id: sessionId, status: 'Approved' }, { signature: 'a'.repeat(64) });
    expect(wrongSig.status).toBe(401);

    // Neither attempt actually changed anything.
    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('none');
  });

  it('raises trust_tier to id_verified on an Approved decision with a valid signature', async () => {
    const builder = await signupBuilder('didit-webhook-approved');
    const sessionId = await insertPendingSession(builder.email);

    const response = await postDiditWebhook({ session_id: sessionId, status: 'Approved' });
    expect(response.status).toBe(200);

    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('id_verified');
    const session = await env.DB.prepare('SELECT status, processed_at FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('approved');
    expect(session.processed_at).not.toBeNull();

    const status = await api('/auth/didit-verification-status', builder.session());
    expect(status.body).toEqual({ status: 'approved' });
  });

  it('records a Declined decision without raising trust_tier', async () => {
    const builder = await signupBuilder('didit-webhook-declined');
    const sessionId = await insertPendingSession(builder.email);

    const response = await postDiditWebhook({ session_id: sessionId, status: 'Declined' });
    expect(response.status).toBe(200);

    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('none');
    const session = await env.DB.prepare('SELECT status FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('declined');
  });

  it('leaves a session pending on a non-terminal status like "In Review"', async () => {
    const builder = await signupBuilder('didit-webhook-inreview');
    const sessionId = await insertPendingSession(builder.email);

    const response = await postDiditWebhook({ session_id: sessionId, status: 'In Review' });
    expect(response.status).toBe(200);

    const session = await env.DB.prepare('SELECT status, processed_at FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('pending');
    expect(session.processed_at).toBeNull();
  });

  it('is a safe no-op for an unknown session_id', async () => {
    const response = await postDiditWebhook({ session_id: 'sess-does-not-exist', status: 'Approved' });
    expect(response.status).toBe(200);
  });

  // Guards against a duplicate webhook delivery (Didit, like most
  // webhook senders, can redeliver) double-applying — e.g. re-raising an
  // already-processed 'declined' session to 'approved' on a stale retry.
  it('ignores a repeat delivery for an already-processed session', async () => {
    const builder = await signupBuilder('didit-webhook-duplicate');
    const sessionId = await insertPendingSession(builder.email);

    const first = await postDiditWebhook({ session_id: sessionId, status: 'Declined' });
    expect(first.status).toBe(200);

    const replay = await postDiditWebhook({ session_id: sessionId, status: 'Approved' });
    expect(replay.status).toBe(200);

    const user = await env.DB.prepare('SELECT trust_tier FROM users WHERE email = ?').bind(builder.email).first();
    expect(user.trust_tier).toBe('none'); // still 'none' — the first (declined) resolution stuck, the replay was ignored
    const session = await env.DB.prepare('SELECT status FROM didit_verification_sessions WHERE session_id = ?').bind(sessionId).first();
    expect(session.status).toBe('declined');
  });
});
