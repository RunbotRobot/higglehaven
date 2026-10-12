import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupUnreferencedModels, reserveVideoGenerationJob } from './index.js';
import { api, signupBuilder } from './test-helpers.js';

// Own file (own D1/worker isolate — see test-helpers.js's own comment on
// why the suite is split by file) so configuring TRIPO_API_KEY/
// TRIPO_WEBHOOK_SECRET here can't leak into any other file relying on
// either staying unset to exercise a 503-unconfigured path for a
// same-shaped endpoint elsewhere. Unlike Didit/OpenAI, this suite mocks
// the vendor outright (same idiom worker/tax-1099-filing-race.test.js's
// own globalThis.fetch override uses for TaxBandits) so the full job
// lifecycle — create, poll-reconcile, webhook — is exercised end-to-end,
// not just up to a 503.
let createCallCount = 0;
let taskCounter = 0;
let nextTaskStatus = 'success';
const FAKE_MODEL_DOWNLOAD_URL = 'https://fake-tripo-cdn.test/output/model.glb';
// #1673: a distinct, always-failing download URL for the "Tripo reports
// success but the output URL is already expired/unreachable" case, so
// that test doesn't depend on mutating FAKE_MODEL_DOWNLOAD_URL's own
// response out from under any other test file sharing this isolate.
const BROKEN_MODEL_DOWNLOAD_URL = 'https://fake-tripo-cdn.test/output/expired.glb';
let nextModelDownloadUrl = FAKE_MODEL_DOWNLOAD_URL;
const originalFetch = globalThis.fetch;

function minimalGlbBytes() {
  const payload = JSON.stringify({ asset: { version: '2.0' } });
  const encoded = new TextEncoder().encode(payload);
  const chunkLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(20 + chunkLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, chunkLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(encoded, 20);
  bytes.fill(0x20, 20 + encoded.length);
  return bytes;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.TRIPO_API_KEY = 'test-tripo-api-key';
  env.TRIPO_WEBHOOK_SECRET = 'test-tripo-webhook-secret';

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://openapi.tripo3d.com/v3/files') {
      createCallCount += 1;
      return new Response(JSON.stringify({ code: 0, data: { file_token: `token-${createCallCount}` } }), { status: 200 });
    }
    if (url === 'https://openapi.tripo3d.com/v3/generation/multiview-to-model') {
      const body = JSON.parse(init.body);
      if (!body.inputs || body.inputs.length < 2) {
        return new Response(JSON.stringify({ code: 1, message: 'at least 2 views required' }), { status: 400 });
      }
      taskCounter += 1;
      // A unique task_id per call -- idx_video_generation_jobs_provider_task_id
      // (migrations/0119) rejects two job rows sharing one, and this suite
      // creates many jobs across many tests.
      return new Response(JSON.stringify({ code: 0, data: { task_id: `task-${taskCounter}` } }), { status: 200 });
    }
    if (url.startsWith('https://openapi.tripo3d.com/v3/tasks/')) {
      const taskId = url.slice('https://openapi.tripo3d.com/v3/tasks/'.length);
      if (nextTaskStatus === 'success') {
        return new Response(JSON.stringify({
          code: 0,
          data: { task_id: taskId, status: 'success', output: { model_url: nextModelDownloadUrl } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { task_id: taskId, status: nextTaskStatus } }), { status: 200 });
    }
    if (url === FAKE_MODEL_DOWNLOAD_URL) {
      return new Response(minimalGlbBytes(), { status: 200 });
    }
    if (url === BROKEN_MODEL_DOWNLOAD_URL) {
      return new Response('Gone', { status: 404 });
    }
    return originalFetch(input, init);
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  env.TRIPO_API_KEY = undefined;
  env.TRIPO_WEBHOOK_SECRET = undefined;
});

function frameFile(name = 'frame.png', type = 'image/png', size = 16) {
  return new File([new Uint8Array(size)], name, { type });
}

function jobCreateForm({ front = frameFile(), left = frameFile(), back, right } = {}) {
  const form = new FormData();
  if (front) form.set('front', front);
  if (left) form.set('left', left);
  if (back) form.set('back', back);
  if (right) form.set('right', right);
  return form;
}

async function postJobCreate(form, { headers } = {}) {
  return SELF.fetch('https://higglehaven.test/api/video-generation-jobs', { method: 'POST', body: form, headers });
}

async function signTripoPayload(timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.TRIPO_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signatureBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return [...signatureBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function postWebhook(payloadObject, { signatureHeader, body, timestamp } = {}) {
  const rawBody = body !== undefined ? body : JSON.stringify(payloadObject);
  const headers = { 'content-type': 'application/json' };
  if (signatureHeader !== undefined) {
    headers['tripo-webhook-signature'] = signatureHeader;
  } else {
    const ts = timestamp !== undefined ? timestamp : Math.floor(Date.now() / 1000);
    headers['tripo-webhook-signature'] = `t=${ts},v1=${await signTripoPayload(ts, rawBody)}`;
  }
  return SELF.fetch('https://higglehaven.test/api/auth/video-generation-webhook', { method: 'POST', headers, body: rawBody });
}

describe('Video-to-3D job creation (#1619)', () => {
  it('requires a session', async () => {
    const rejected = await postJobCreate(jobCreateForm());
    expect(rejected.status).toBe(401);
  });

  it('rejects a missing front view before checking configuration or rate limits', async () => {
    const builder = await signupBuilder('video-gen-missing-front');
    const rejected = await postJobCreate(
      jobCreateForm({ front: null, left: frameFile(), back: frameFile() }),
      { headers: { cookie: `hh_session=${builder.sessionToken}` } },
    );
    expect(rejected.status).toBe(400);
  });

  it('rejects fewer than 2 views', async () => {
    const builder = await signupBuilder('video-gen-too-few-views');
    const rejected = await postJobCreate(
      jobCreateForm({ front: frameFile(), left: null }),
      { headers: { cookie: `hh_session=${builder.sessionToken}` } },
    );
    expect(rejected.status).toBe(400);
  });

  it('rejects an oversized view image', async () => {
    const builder = await signupBuilder('video-gen-oversized');
    const rejected = await postJobCreate(
      jobCreateForm({ front: frameFile('front.png', 'image/png', 11 * 1024 * 1024) }),
      { headers: { cookie: `hh_session=${builder.sessionToken}` } },
    );
    expect(rejected.status).toBe(413);
  });

  it('rejects a view image with an unsupported content type', async () => {
    const builder = await signupBuilder('video-gen-bad-type');
    const rejected = await postJobCreate(
      jobCreateForm({ front: frameFile('front.gif', 'image/gif') }),
      { headers: { cookie: `hh_session=${builder.sessionToken}` } },
    );
    expect(rejected.status).toBe(415);
  });

  it('kicks off a real job and the status endpoint reconciles it to complete', async () => {
    const builder = await signupBuilder('video-gen-happy-path');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.status).toBe('processing');
    expect(createdBody.jobId).toMatch(/^job-/);

    nextTaskStatus = 'success';
    const status = await api(`/video-generation-jobs/${createdBody.jobId}`, builder.session());
    expect(status.response.status).toBe(200);
    expect(status.body.status).toBe('complete');
    expect(status.body.modelUrl).toMatch(/^\/uploads\/models\/[0-9a-f]{64}\.glb$/);

    // Reconciling again is a safe no-op (processed_at guard) rather than
    // re-downloading/re-storing.
    const again = await api(`/video-generation-jobs/${createdBody.jobId}`, builder.session());
    expect(again.body).toEqual(status.body);
  });

  it('records a failed job when Tripo reports a terminal failure status', async () => {
    const builder = await signupBuilder('video-gen-failure-path');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const createdBody = await created.json();

    nextTaskStatus = 'banned';
    const status = await api(`/video-generation-jobs/${createdBody.jobId}`, builder.session());
    expect(status.body.status).toBe('failed');
    expect(status.body.error).toMatch(/banned/);
    nextTaskStatus = 'success';
  });

  it('#1673: fails the job immediately (not stuck processing) when Tripo reports success but the model download fails', async () => {
    const builder = await signupBuilder('video-gen-broken-download');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const createdBody = await created.json();

    nextTaskStatus = 'success';
    nextModelDownloadUrl = BROKEN_MODEL_DOWNLOAD_URL;
    try {
      const status = await api(`/video-generation-jobs/${createdBody.jobId}`, builder.session());
      expect(status.body.status).toBe('failed');
      expect(status.body.error).toMatch(/retrieve the generated model/);

      const row = await env.DB.prepare('SELECT status, processed_at FROM video_generation_jobs WHERE job_id = ?').bind(createdBody.jobId).first();
      expect(row.status).toBe('failed');
      expect(row.processed_at).not.toBeNull();
    } finally {
      nextModelDownloadUrl = FAKE_MODEL_DOWNLOAD_URL;
    }
  });

  it('leaves a job processing on a non-terminal status like "running"', async () => {
    const builder = await signupBuilder('video-gen-running');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const createdBody = await created.json();

    nextTaskStatus = 'running';
    const status = await api(`/video-generation-jobs/${createdBody.jobId}`, builder.session());
    expect(status.body.status).toBe('processing');
    expect(status.body.modelUrl).toBeFalsy();
    nextTaskStatus = 'success';
  });

  it('hands back the already-in-flight job instead of starting a second one', async () => {
    const builder = await signupBuilder('video-gen-dedup');
    const first = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const firstBody = await first.json();

    const second = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.jobId).toBe(firstBody.jobId);

    const rows = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE builder_id = ?').bind(builder.builderId).all();
    expect(rows.results).toHaveLength(1);
  });

  it('rate-limits repeated job-creation attempts from the same builder', async () => {
    const builder = await signupBuilder('video-gen-rate-limit');
    // Each attempt must land as a distinct job (not the dedup path above),
    // so each gets reconciled to a terminal state before the next fires.
    for (let i = 0; i < 10; i++) {
      const attempt = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
      expect(attempt.status).not.toBe(429);
      const body = await attempt.json();
      await api(`/video-generation-jobs/${body.jobId}`, builder.session());
    }
    const limited = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    expect(limited.status).toBe(429);
  });

  it('returns 503 once past validation when Tripo is not configured', async () => {
    const builder = await signupBuilder('video-gen-503');
    env.TRIPO_API_KEY = undefined;
    try {
      const rejected = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
      expect(rejected.status).toBe(503);
    } finally {
      env.TRIPO_API_KEY = 'test-tripo-api-key';
    }
  });
});

describe('reserveVideoGenerationJob (#1619)', () => {
  it('reserves a pending row for the first caller', async () => {
    const builder = await signupBuilder('video-gen-reserve-first');
    const result = await reserveVideoGenerationJob(env.DB, builder.builderId);
    expect(result.reservationId).not.toBeNull();
    expect(result.existing).toBeNull();

    const rows = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE builder_id = ?').bind(builder.builderId).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].job_id).toBe(result.reservationId);
    expect(rows.results[0].status).toBe('pending');
  });

  it('hands the existing reservation back to a concurrent second caller instead of creating a duplicate', async () => {
    const builder = await signupBuilder('video-gen-reserve-race');
    const [first, second] = await Promise.all([
      reserveVideoGenerationJob(env.DB, builder.builderId),
      reserveVideoGenerationJob(env.DB, builder.builderId),
    ]);
    const winner = first.reservationId ? first : second;
    const loser = first.reservationId ? second : first;
    expect(winner.reservationId).not.toBeNull();
    expect(loser.reservationId).toBeNull();
    expect(loser.existing.job_id).toBe(winner.reservationId);

    const rows = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE builder_id = ?').bind(builder.builderId).all();
    expect(rows.results).toHaveLength(1);
  });

  it('allows a fresh reservation once the previous job is processed', async () => {
    const builder = await signupBuilder('video-gen-reserve-reprocessed');
    const first = await reserveVideoGenerationJob(env.DB, builder.builderId);
    await env.DB.prepare(`
      UPDATE video_generation_jobs SET status = 'failed', processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE job_id = ?
    `).bind(first.reservationId).run();

    const second = await reserveVideoGenerationJob(env.DB, builder.builderId);
    expect(second.reservationId).not.toBeNull();
    expect(second.reservationId).not.toBe(first.reservationId);
  });
});

describe('Video-to-3D job status polling (#1619)', () => {
  it('requires a session', async () => {
    const rejected = await SELF.fetch('https://higglehaven.test/api/video-generation-jobs/job-does-not-exist');
    expect(rejected.status).toBe(401);
  });

  it('returns 404 for a job that does not exist', async () => {
    const builder = await signupBuilder('video-gen-status-404');
    const rejected = await api('/video-generation-jobs/job-does-not-exist', builder.session());
    expect(rejected.response.status).toBe(404);
  });

  it('returns 403 for a job owned by a different builder', async () => {
    const owner = await signupBuilder('video-gen-status-owner');
    const intruder = await signupBuilder('video-gen-status-intruder');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${owner.sessionToken}` } });
    const { jobId } = await created.json();

    const rejected = await api(`/video-generation-jobs/${jobId}`, intruder.session());
    expect(rejected.response.status).toBe(403);
  });

  // #1037's own reasoning for GET .../didit-verification-status, applied
  // here: rate-limited before the tripoConfigured check inside
  // reconcileVideoGenerationJob (not after), so the limiter still fires
  // regardless of configuration.
  it('rate-limits repeated polls of a still-processing job', async () => {
    const builder = await signupBuilder('video-gen-status-rate-limit');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();
    nextTaskStatus = 'running';

    for (let i = 0; i < 120; i++) {
      const response = await api(`/video-generation-jobs/${jobId}`, builder.session());
      expect(response.response.status).toBe(200);
    }
    const limited = await api(`/video-generation-jobs/${jobId}`, builder.session());
    expect(limited.response.status).toBe(429);
    nextTaskStatus = 'success';
  });
});

describe('Video-to-3D webhook (#1619)', () => {
  it('rejects a webhook with a missing or malformed signature header', async () => {
    const noSig = await postWebhook({ data: { task_id: 'task-abc123', status: 'success' } }, { signatureHeader: '' });
    expect(noSig.status).toBe(401);

    const malformed = await postWebhook({ data: { task_id: 'task-abc123', status: 'success' } }, { signatureHeader: 'not-a-real-signature' });
    expect(malformed.status).toBe(401);
  });

  it('rejects a webhook with a wrong signature', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const wrong = await postWebhook(
      { data: { task_id: 'task-abc123', status: 'success' } },
      { signatureHeader: `t=${timestamp},v1=${'a'.repeat(64)}` },
    );
    expect(wrong.status).toBe(401);
  });

  // #1659: same `t=...,v1=...` scheme as the Stripe webhook (stripe-webhook.
  // test.js's own "too old" case) -- a correctly-signed-but-stale delivery
  // must still be rejected, not just a wrong/missing signature.
  it('rejects a webhook whose signature is correctly signed but too old', async () => {
    const builder = await signupBuilder('video-gen-webhook-stale-timestamp');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();
    const row = await env.DB.prepare('SELECT provider_task_id FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();

    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    const stale = await postWebhook(
      { data: { task_id: row.provider_task_id, status: 'success', output: { model_url: FAKE_MODEL_DOWNLOAD_URL } } },
      { timestamp: staleTimestamp },
    );
    expect(stale.status).toBe(401);

    const updated = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
    expect(updated.status).toBe('processing');
    expect(updated.processed_at).toBeNull();
  });

  it('is a safe no-op for an unknown task_id', async () => {
    const response = await postWebhook({ data: { task_id: 'task-does-not-exist', status: 'success' } });
    expect(response.status).toBe(200);
    const rows = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE provider_task_id = ?').bind('task-does-not-exist').all();
    expect(rows.results).toHaveLength(0);
  });

  it('applies a task.completed delivery by downloading and storing the model', async () => {
    const builder = await signupBuilder('video-gen-webhook-completed');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();
    const row = await env.DB.prepare('SELECT provider_task_id FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();

    const response = await postWebhook({
      type: 'task.completed',
      data: { task_id: row.provider_task_id, status: 'success', output: { model_url: FAKE_MODEL_DOWNLOAD_URL } },
    });
    expect(response.status).toBe(200);

    const updated = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
    expect(updated.status).toBe('complete');
    expect(updated.model_url).toMatch(/^\/uploads\/models\/[0-9a-f]{64}\.glb$/);
    expect(updated.processed_at).not.toBeNull();
  });

  // #1644: a completed job's model has no catalog_templates row of its own
  // yet (that's only created once a human finishes the upload wizard,
  // #1620) -- cleanupUnreferencedModels used to only check catalog_templates'
  // model_url/image_url columns, so this real, billed R2 object looked
  // "unreferenced" and got swept by the next cron run within minutes of
  // generation completing. Same shape as the #774 image_url regression test
  // above, just for this second writer into the same bucket/scheme.
  it('treats a video-generation job\'s model_url as still referenced, not an orphan to sweep', async () => {
    const builder = await signupBuilder('video-gen-cleanup-still-referenced');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();
    const row = await env.DB.prepare('SELECT provider_task_id FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();

    const webhook = await postWebhook({
      type: 'task.completed',
      data: { task_id: row.provider_task_id, status: 'success', output: { model_url: FAKE_MODEL_DOWNLOAD_URL } },
    });
    expect(webhook.status).toBe(200);
    const { model_url: modelUrl } = await env.DB.prepare('SELECT model_url FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();

    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: false, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).not.toContain(modelUrl);
    expect((await SELF.fetch(`https://higglehaven.test${modelUrl}`)).status).toBe(200);
  });

  it('applies a task.failed delivery', async () => {
    const builder = await signupBuilder('video-gen-webhook-failed');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();
    const row = await env.DB.prepare('SELECT provider_task_id FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();

    const response = await postWebhook({
      type: 'task.failed',
      data: { task_id: row.provider_task_id, status: 'failed', error: { code: 'task_failed', message: 'Generation failed' } },
    });
    expect(response.status).toBe(200);

    const updated = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
    expect(updated.status).toBe('failed');
    expect(updated.model_url).toBeNull();
  });

  // Guards against a duplicate webhook delivery (Tripo, like most webhook
  // senders, retries on a non-2xx response or timeout) double-applying.
  it('ignores a repeat delivery for an already-processed job', async () => {
    const builder = await signupBuilder('video-gen-webhook-duplicate');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();
    const row = await env.DB.prepare('SELECT provider_task_id FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();

    const first = await postWebhook({ data: { task_id: row.provider_task_id, status: 'failed' } });
    expect(first.status).toBe(200);

    const replay = await postWebhook({ data: { task_id: row.provider_task_id, status: 'success', output: { model_url: FAKE_MODEL_DOWNLOAD_URL } } });
    expect(replay.status).toBe(200);

    const updated = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
    // Still 'failed' from the first delivery -- the replay's 'success' was
    // ignored, not re-applied on top.
    expect(updated.status).toBe('failed');
  });

  it('returns 503 when the webhook secret is not configured', async () => {
    env.TRIPO_WEBHOOK_SECRET = undefined;
    try {
      const response = await SELF.fetch('https://higglehaven.test/api/auth/video-generation-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'tripo-webhook-signature': 't=1,v1=abc' },
        body: JSON.stringify({ data: { task_id: 'task-abc123', status: 'success' } }),
      });
      expect(response.status).toBe(503);
    } finally {
      env.TRIPO_WEBHOOK_SECRET = 'test-tripo-webhook-secret';
    }
  });
});

// #1645: migrations/0119 declared video_generation_jobs.builder_id with no
// ON DELETE clause at all (D1/SQLite's own restrictive default), the one
// REFERENCES builders(builder_id) FK in the whole schema still missing an
// explicit behavior after migrations/0091 and 0093 closed every other one
// -- DELETE /api/builders/:id threw an unhandled constraint-violation error
// for any builder who had ever started a video-to-3D job. migrations/0120
// rebuilt the table with ON DELETE CASCADE; mirrors
// worker/didit-verification.test.js's own "still cascades a deleted
// builder into its own X" regression style for the other tables that
// migration's own sibling migrations (0091/0093) touched.
describe('video_generation_jobs cascades on builder deletion (#1645)', () => {
  it('cascades a deleted builder into its own video_generation_jobs', async () => {
    const builder = await signupBuilder('video-gen-builder-delete-cascade');
    const created = await postJobCreate(jobCreateForm(), { headers: { cookie: `hh_session=${builder.sessionToken}` } });
    const { jobId } = await created.json();

    await env.DB.prepare('DELETE FROM builders WHERE builder_id = ?').bind(builder.builderId).run();

    const { results } = await env.DB.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(jobId).all();
    expect(results).toHaveLength(0);
  });
});
