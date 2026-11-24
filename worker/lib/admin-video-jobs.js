// #4122: the admin dashboard's Video-to-3D jobs panel. Two admin-only routes:
//   GET  /api/admin-video-jobs                       the most recent jobs, newest first, with why a failed one failed
//   POST /api/admin-video-jobs/:jobId/check          "Check the saved result": asks the provider about a failed job's
//                                                    task (free) and tries the store step without writing anything
// Nothing here changes a job's status or a credit, and nothing is ever returned to the builder. Built for today's
// size: the latest 50 jobs, no paging, until there are enough jobs that 50 does not reach back a week.
import { json, HttpError } from './http.js';
import { requireAdmin } from './auth.js';
import { checkRateLimit } from './rate-limit.js';
import { adminActionLogStatement } from './admin-log.js';
import { checkVideoGenerationJobResult } from './video-generation.js';

const ADMIN_VIDEO_JOBS_LIMIT = 50;
const ADMIN_VIDEO_JOB_CHECK_RATE_LIMIT_MAX = 10;

function parseDetail(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { reason: 'unreadable' }; }
}

export async function handleAdminVideoJobs(request, env, db, route) {
  const admin = await requireAdmin(request, db);

  if (request.method === 'GET' && route.length === 1) {
    const { results } = await db.prepare(`
      SELECT j.job_id, j.status, j.created_at, j.processed_at, j.error_message, j.failure_detail,
             j.provider_task_id, u.username
      FROM video_generation_jobs j
      LEFT JOIN builders b ON b.builder_id = j.builder_id
      LEFT JOIN users u ON u.user_id = b.user_id
      ORDER BY j.created_at DESC LIMIT ?
    `).bind(ADMIN_VIDEO_JOBS_LIMIT).all();
    return json({
      limit: ADMIN_VIDEO_JOBS_LIMIT,
      jobs: results.map((row) => ({
        jobId: row.job_id, status: row.status, createdAt: row.created_at, finishedAt: row.processed_at,
        username: row.username ?? null, message: row.error_message, detail: parseDetail(row.failure_detail),
        canCheck: row.status === 'failed' && Boolean(row.provider_task_id),
      })),
    });
  }

  if (request.method === 'POST' && route.length === 3 && route[2] === 'check') {
    await checkRateLimit(db, `admin-video-job-check:${admin.user_id}`, ADMIN_VIDEO_JOB_CHECK_RATE_LIMIT_MAX);
    const job = await db.prepare('SELECT * FROM video_generation_jobs WHERE job_id = ?').bind(route[1]).first();
    if (!job) throw new HttpError('Video-to-3D job not found', 404);
    if (job.status !== 'failed') throw new HttpError('Only a failed job can be checked', 409);
    const found = await checkVideoGenerationJobResult(env, db, job);
    await adminActionLogStatement(db, admin.user_id, 'video_job_result_checked', 'video_generation_job', job.job_id, { reason: found.reason }).run();
    return json({ jobId: job.job_id, detail: found });
  }

  return json({ error: 'Not found' }, 404);
}
