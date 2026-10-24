// #2719 (sub-issue of #2715, "[Tracking] In-app 'Submit Feedback' bug
// reports with automatic rendering-state capture"): POST /api/feedback/bug-report
// and GET /api/feedback/bug-reports/:id/screenshot (worker/lib/feedback.js).
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, extractSessionCookie, withSession, signup, signupAdmin } from './test-helpers.js';

let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('feedback-test-admin');
  adminSession = admin.session;
});

function screenshotFile(bytes = 16) {
  return new File([new Uint8Array(bytes)], 'feedback.png', { type: 'image/png' });
}

function metadataFor(overrides = {}) {
  return JSON.stringify({
    description: 'Something looked wrong',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX)',
    webglVendor: 'Google Inc.',
    userAgent: 'test-agent/1.0',
    platform: 'TestOS',
    renderStateBuffer: [{ t: 0, x: 1 }, { t: 1, x: 2 }],
    submittedAt: new Date().toISOString(),
    userId: 'forged-user-id-should-be-ignored',
    ...overrides,
  });
}

async function postBugReport({ screenshot = screenshotFile(), metadata = metadataFor(), session, headers } = {}) {
  const form = new FormData();
  if (screenshot !== null) form.set('screenshot', screenshot);
  if (metadata !== null) form.set('metadata', metadata);
  return SELF.fetch('https://higglehaven.test/api/feedback/bug-report', {
    method: 'POST',
    body: form,
    headers: {
      'cf-connecting-ip': `test-${crypto.randomUUID()}`,
      ...(session ? { cookie: `hh_session=${session}` } : {}),
      ...headers,
    },
  });
}

describe('POST /api/feedback/bug-report', () => {
  it('stores an anonymous report with a screenshot and ignores the client-forged userId', async () => {
    const response = await postBugReport();
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.reportId).toMatch(/^report-/);

    const row = await env.DB.prepare('SELECT * FROM bug_reports WHERE report_id = ?').bind(body.reportId).first();
    expect(row.user_id).toBeNull();
    expect(row.description).toBe('Something looked wrong');
    expect(row.webgl_renderer).toBe('ANGLE (NVIDIA, NVIDIA GeForce RTX)');
    expect(row.screenshot_url).toBe(`/api/feedback/bug-reports/${body.reportId}/screenshot`);
    expect(JSON.parse(row.render_state_buffer_json)).toEqual([{ t: 0, x: 1 }, { t: 1, x: 2 }]);
  });

  it('records the real session user_id, not a client-supplied one', async () => {
    const email = `feedback-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here');
    const sessionToken = extractSessionCookie(signedUp.response);
    const me = await api('/auth/me', withSession(sessionToken));

    const response = await postBugReport({ session: sessionToken });
    const body = await response.json();
    expect(response.status).toBe(201);

    const row = await env.DB.prepare('SELECT user_id FROM bug_reports WHERE report_id = ?').bind(body.reportId).first();
    expect(row.user_id).toBe(me.body.user.userId);
    expect(row.user_id).not.toBe('forged-user-id-should-be-ignored');
  });

  it('accepts a report with no screenshot at all', async () => {
    const response = await postBugReport({ screenshot: null });
    const body = await response.json();
    expect(response.status).toBe(201);
    const row = await env.DB.prepare('SELECT screenshot_url FROM bug_reports WHERE report_id = ?').bind(body.reportId).first();
    expect(row.screenshot_url).toBeNull();
  });

  it('defaults a missing/blank description to null rather than rejecting the report', async () => {
    const response = await postBugReport({ metadata: metadataFor({ description: undefined }) });
    const body = await response.json();
    expect(response.status).toBe(201);
    const row = await env.DB.prepare('SELECT description FROM bug_reports WHERE report_id = ?').bind(body.reportId).first();
    expect(row.description).toBeNull();
  });

  it('stores an empty render-state buffer when the client sends something other than an array', async () => {
    const response = await postBugReport({ metadata: metadataFor({ renderStateBuffer: 'not-an-array' }) });
    const body = await response.json();
    expect(response.status).toBe(201);
    const row = await env.DB.prepare('SELECT render_state_buffer_json FROM bug_reports WHERE report_id = ?').bind(body.reportId).first();
    expect(JSON.parse(row.render_state_buffer_json)).toEqual([]);
  });

  it('rejects a request with no metadata field', async () => {
    const response = await postBugReport({ metadata: null });
    expect(response.status).toBe(400);
  });

  it('rejects metadata that is not valid JSON', async () => {
    const response = await postBugReport({ metadata: 'not json at all' });
    expect(response.status).toBe(400);
  });

  it('rejects a description over the 280-character cap', async () => {
    const response = await postBugReport({ metadata: metadataFor({ description: 'x'.repeat(281) }) });
    expect(response.status).toBe(400);
  });

  it('rejects an oversized screenshot', async () => {
    const response = await postBugReport({ screenshot: screenshotFile(10 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
  });

  it('rejects a non-multipart body', async () => {
    const response = await SELF.fetch('https://higglehaven.test/api/feedback/bug-report', {
      method: 'POST',
      body: JSON.stringify({ metadata: metadataFor() }),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `test-${crypto.randomUUID()}` },
    });
    expect(response.status).toBe(415);
  });

  it('rate-limits repeated submissions from the same IP', async () => {
    const ip = `test-feedback-rate-limit-${crypto.randomUUID()}`;
    for (let i = 0; i < 20; i++) {
      const response = await postBugReport({ headers: { 'cf-connecting-ip': ip } });
      expect(response.status).toBe(201);
    }
    const limited = await postBugReport({ headers: { 'cf-connecting-ip': ip } });
    expect(limited.status).toBe(429);
  });
});

describe('GET /api/feedback/bug-reports/:reportId/screenshot', () => {
  it('serves the stored screenshot to an admin', async () => {
    const created = await (await postBugReport({ screenshot: screenshotFile(32) })).json();
    const response = await SELF.fetch(
      `https://higglehaven.test/api/feedback/bug-reports/${created.reportId}/screenshot`,
      adminSession(),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(32);
  });

  it('404s for a report with no screenshot', async () => {
    const created = await (await postBugReport({ screenshot: null })).json();
    const { response } = await api(`/feedback/bug-reports/${created.reportId}/screenshot`, adminSession());
    expect(response.status).toBe(404);
  });

  it('404s for an unknown report id', async () => {
    const { response } = await api('/feedback/bug-reports/report-does-not-exist/screenshot', adminSession());
    expect(response.status).toBe(404);
  });

  it('rejects a non-admin session', async () => {
    const email = `feedback-screenshot-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here');
    const sessionToken = extractSessionCookie(signedUp.response);
    const created = await (await postBugReport()).json();
    const { response } = await api(`/feedback/bug-reports/${created.reportId}/screenshot`, withSession(sessionToken));
    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const created = await (await postBugReport()).json();
    const { response } = await api(`/feedback/bug-reports/${created.reportId}/screenshot`);
    expect(response.status).toBe(401);
  });
});
