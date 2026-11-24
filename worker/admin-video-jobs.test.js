// #4122: the admin dashboard's Video-to-3D jobs panel: the list, and "Check the saved result" on a failed job.
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';

const originalFetch = globalThis.fetch;
let taskResponse;
let downloadResponse;
let adminSession;
let builder;
let counter = 0;

function glb(extra = 0) {
  const encoded = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }));
  const chunkLength = Math.ceil(encoded.length / 4) * 4 + extra * 4;
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

async function failedJob({ withTask = true, status = 'failed' } = {}) {
  counter += 1;
  const jobId = `job-4122-${counter}`;
  await env.DB.prepare(`
    INSERT INTO video_generation_jobs (job_id, builder_id, status, provider_task_id, error_message, processed_at)
    VALUES (?, ?, ?, ?, 'The model was made, but we couldn''t save it.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).bind(jobId, builder.builderId, status, withTask ? `task-4122-${counter}` : null).run();
  return jobId;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.TRIPO_API_KEY = 'test-tripo-api-key';
  adminSession = (await signupAdmin('video-jobs-admin')).session;
  builder = await signupBuilder('video-jobs-builder');
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://openapi.tripo3d.ai/v3/tasks/')) return taskResponse();
    if (url === 'https://fake-tripo-cdn.test/out.glb') return downloadResponse();
    return originalFetch(input, init);
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  env.TRIPO_API_KEY = undefined;
});

const task = (data) => () => new Response(JSON.stringify({ code: 0, data }), { status: 200 });

describe('admin Video-to-3D jobs (#4122)', () => {
  it('refuses a signed-out caller and a signed-in non-admin, for the list and the check', async () => {
    const jobId = await failedJob();
    expect((await api('/admin-video-jobs')).response.status).toBe(401);
    expect((await api('/admin-video-jobs', builder.session())).response.status).toBe(403);
    expect((await api(`/admin-video-jobs/${jobId}/check`, { ...builder.session(), method: 'POST' })).response.status).toBe(403);
  });

  it('lists jobs with their kept reason, and the builder never sees that reason', async () => {
    const jobId = await failedJob();
    await env.DB.prepare('UPDATE video_generation_jobs SET failure_detail = ? WHERE job_id = ?')
      .bind(JSON.stringify({ reason: 'too_big', bytes: 25000000 }), jobId).run();
    const list = await api('/admin-video-jobs', adminSession());
    expect(list.response.status).toBe(200);
    const row = list.body.jobs.find((j) => j.jobId === jobId);
    expect(row.detail.reason).toBe('too_big');
    expect(row.canCheck).toBe(true);
    expect(row.username).toBe('video-jobs-builder');
    const own = await api(`/video-generation-jobs/${jobId}`, builder.session());
    expect(JSON.stringify(own.body)).not.toMatch(/too_big|failure/i);
  });

  it('a check that finds a model we would now keep says so, writes nothing and leaves the job and credit alone', async () => {
    const jobId = await failedJob();
    taskResponse = task({ status: 'success', output: { model_url: 'https://fake-tripo-cdn.test/out.glb', pbr_model: 'x' } });
    downloadResponse = () => new Response(glb(), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
    const before = await env.DB.prepare('SELECT video_generation_credits AS c FROM builders WHERE builder_id = ?').bind(builder.builderId).first();
    const result = await api(`/admin-video-jobs/${jobId}/check`, { ...adminSession(), method: 'POST' });
    expect(result.response.status).toBe(200);
    expect(result.body.detail.reason).toBe('would_save_now');
    expect(result.body.detail.outputKeys).toEqual(['model_url', 'pbr_model']);
    const row = await env.DB.prepare('SELECT status, model_url FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
    expect(row.status).toBe('failed');
    expect(row.model_url).toBeNull();
    const after = await env.DB.prepare('SELECT video_generation_credits AS c FROM builders WHERE builder_id = ?').bind(builder.builderId).first();
    expect(after.c).toBe(before.c);
    const logged = await env.DB.prepare("SELECT 1 AS hit FROM admin_action_log WHERE action_type = 'video_job_result_checked' AND target_id = ?").bind(jobId).first();
    expect(logged).toBeTruthy();
  });

  it('a check names each way the result can still not be kept', async () => {
    const expectations = [
      [task({ status: 'success', output: { model_url: 'https://fake-tripo-cdn.test/out.glb' } }), () => new Response('Gone', { status: 403 }), 'download_refused'],
      [task({ status: 'success', output: { model_url: 'https://fake-tripo-cdn.test/out.glb' } }), () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'not_a_glb'],
      [task({ status: 'success', output: {} }), () => new Response('', { status: 200 }), 'no_model_url'],
      [task({ status: 'running' }), () => new Response('', { status: 200 }), 'task_not_successful'],
    ];
    for (const [tripo, download, reason] of expectations) {
      const jobId = await failedJob();
      taskResponse = tripo;
      downloadResponse = download;
      const result = await api(`/admin-video-jobs/${jobId}/check`, { ...adminSession(), method: 'POST' });
      expect(result.body.detail.reason).toBe(reason);
      const stored = await env.DB.prepare('SELECT failure_detail FROM video_generation_jobs WHERE job_id = ?').bind(jobId).first();
      expect(JSON.parse(stored.failure_detail).reason).toBe(reason);
    }
  });

  it('refuses a job that did not fail or never reached the provider', async () => {
    const ok = await failedJob({ status: 'complete' });
    expect((await api(`/admin-video-jobs/${ok}/check`, { ...adminSession(), method: 'POST' })).response.status).toBe(409);
    const noTask = await failedJob({ withTask: false });
    expect((await api(`/admin-video-jobs/${noTask}/check`, { ...adminSession(), method: 'POST' })).response.status).toBe(409);
    expect((await api('/admin-video-jobs/nope/check', { ...adminSession(), method: 'POST' })).response.status).toBe(404);
  });
});
