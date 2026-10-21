// #1619: a video-to-3D job that never reaches a terminal status on
// Tripo's side (provider silence, a dropped webhook with no further poll
// ever arriving) used to sit in 'processing' forever, with no automatic
// timeout/expiry -- the one piece of #1619's original scope its own PR
// (#1626) left unimplemented. This covers the periodic-sweep half
// (expireStaleVideoGenerationJobs, called from scheduled() on the
// existing cron) in its own file -- no TRIPO_API_KEY/mocked fetch needed
// here (same reasoning avatar-presence-cleanup.test.js gives for its own
// separate file), since this sweep never calls out to Tripo at all.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { expireStaleVideoGenerationJobs } from './lib/video-generation.js';
import { signupBuilder } from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

let seedCounter = 0;

async function seedJob(builderId, { status, ageMs, processed = false }) {
  seedCounter += 1;
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const jobId = `job-timeout-test-${seedCounter}`;
  await env.DB.prepare(`
    INSERT INTO video_generation_jobs (job_id, builder_id, provider_task_id, status, created_at, processed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(jobId, builderId, `task-timeout-test-${seedCounter}`, status, createdAt, processed ? createdAt : null).run();
  return jobId;
}

describe('expireStaleVideoGenerationJobs (#1619)', () => {
  it('marks a long-stuck processing job failed, and leaves a fresh one untouched', async () => {
    const stale = await signupBuilder('video-timeout-stale');
    const fresh = await signupBuilder('video-timeout-fresh');
    const staleJobId = await seedJob(stale.builderId, { status: 'processing', ageMs: 20 * 60 * 1000 }); // 20 minutes old
    const freshJobId = await seedJob(fresh.builderId, { status: 'processing', ageMs: 30 * 1000 }); // 30 seconds old

    await expireStaleVideoGenerationJobs(env.DB);

    const staleRow = await env.DB.prepare('SELECT status, error_message, processed_at FROM video_generation_jobs WHERE job_id = ?').bind(staleJobId).first();
    expect(staleRow.status).toBe('failed');
    expect(staleRow.error_message).toMatch(/timed out/i);
    expect(staleRow.processed_at).toBeTruthy();

    const freshRow = await env.DB.prepare('SELECT status, processed_at FROM video_generation_jobs WHERE job_id = ?').bind(freshJobId).first();
    expect(freshRow.status).toBe('processing');
    expect(freshRow.processed_at).toBeNull();
  });

  it('never touches a job already resolved, or one still pending (not yet processing), regardless of age', async () => {
    const alreadyComplete = await signupBuilder('video-timeout-complete');
    const stillPending = await signupBuilder('video-timeout-pending');
    const completeJobId = await seedJob(alreadyComplete.builderId, { status: 'complete', ageMs: 60 * 60 * 1000, processed: true }); // 1 hour old, already resolved
    const pendingJobId = await seedJob(stillPending.builderId, { status: 'pending', ageMs: 60 * 60 * 1000 }); // 1 hour old, never reached Tripo

    await expireStaleVideoGenerationJobs(env.DB);

    const completeRow = await env.DB.prepare('SELECT status FROM video_generation_jobs WHERE job_id = ?').bind(completeJobId).first();
    expect(completeRow.status).toBe('complete');

    const pendingRow = await env.DB.prepare('SELECT status, processed_at FROM video_generation_jobs WHERE job_id = ?').bind(pendingJobId).first();
    expect(pendingRow.status).toBe('pending');
    expect(pendingRow.processed_at).toBeNull();
  });

  it('is a no-op when there are no stale processing jobs', async () => {
    const fresh = await signupBuilder('video-timeout-noop');
    const freshJobId = await seedJob(fresh.builderId, { status: 'processing', ageMs: 1000 });

    await expireStaleVideoGenerationJobs(env.DB);

    const row = await env.DB.prepare('SELECT status FROM video_generation_jobs WHERE job_id = ?').bind(freshJobId).first();
    expect(row.status).toBe('processing');
  });
});
