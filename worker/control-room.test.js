// N31 (owner, Control Room, 2026-09-11): "I must insist that we move this
// page to a proper server-based format. That will enable a structured API
// that we write which can reject calls that don't meet the required
// criteria (caller name and message text)." These tests exercise exactly
// that: every mutating endpoint rejects a call missing a caller name or
// message text, and setting waitingOn:'owner' is impossible without a
// reason landing as a real, linked reply in the same request.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupAdmin } from './test-helpers.js';

let adminSession;
const API_KEY = 'test-control-room-key';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('control-room-admin');
  adminSession = admin.session;
  env.CONTROL_ROOM_API_KEY = API_KEY;
});

function keySession(options = {}) {
  return { ...options, headers: { ...options.headers, 'x-control-room-key': API_KEY } };
}

async function createTask(overrides = {}) {
  const { response, body } = await api('/control-room/tasks', keySession({
    method: 'POST',
    body: JSON.stringify({ from: 'higglehaven2', title: 'A test task', ...overrides }),
  }));
  expect(response.status).toBe(201);
  return body.task;
}

describe('Control Room access (#N31)', () => {
  it('rejects a caller with neither an admin session nor the API key', async () => {
    const got = await api('/control-room/tasks');
    expect(got.response.status).toBe(401);
  });

  it('rejects a wrong API key the same as no key at all', async () => {
    const got = await api('/control-room/tasks', { headers: { 'x-control-room-key': 'wrong-key' } });
    expect(got.response.status).toBe(401);
  });

  it("accepts the owner's own admin session with no key at all", async () => {
    const got = await api('/control-room/tasks', adminSession());
    expect(got.response.status).toBe(200);
  });

  it('accepts the shared API key with no admin session at all', async () => {
    const got = await api('/control-room/tasks', keySession());
    expect(got.response.status).toBe(200);
  });
});

describe('Control Room tasks (#N31)', () => {
  it('rejects creating a task with no caller name', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST', body: JSON.stringify({ title: 'No caller' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/from/i);
  });

  it('rejects creating a task with no message text', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST', body: JSON.stringify({ from: 'higglehaven2' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/title/i);
  });

  it('rejects blank strings the same as missing fields entirely', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST', body: JSON.stringify({ from: '   ', title: 'Has a title' }),
    }));
    expect(got.response.status).toBe(400);
  });

  it('creates a task with a caller name and message text, defaulting status to queued', async () => {
    const task = await createTask({ from: 'higglehaven2', title: 'Ship the migration' });
    expect(task.status).toBe('queued');
    expect(task.from).toBe('higglehaven2');
    expect(task.title).toBe('Ship the migration');
    expect(task.waitingOn).toBeNull();
  });

  it('rejects creating a second task with a duplicate explicit id', async () => {
    const task = await createTask({ id: 'issue-9001' });
    expect(task.id).toBe('issue-9001');
    const dupe = await api('/control-room/tasks', keySession({
      method: 'POST', body: JSON.stringify({ id: 'issue-9001', from: 'higglehaven3', title: 'Duplicate' }),
    }));
    expect(dupe.response.status).toBe(409);
  });

  it('lists and fetches a task by id', async () => {
    const task = await createTask();
    const list = await api('/control-room/tasks', keySession());
    expect(list.response.status).toBe(200);
    expect(list.body.tasks.some((t) => t.id === task.id)).toBe(true);

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.response.status).toBe(200);
    expect(got.body.task.id).toBe(task.id);
  });

  it('404s fetching a task that does not exist', async () => {
    const got = await api('/control-room/tasks/does-not-exist', keySession());
    expect(got.response.status).toBe(404);
  });

  it('filters the task list by status', async () => {
    const done = await createTask({ title: 'Filter by status' });
    await api(`/control-room/tasks/${done.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', status: 'done' }),
    }));
    const queuedList = await api('/control-room/tasks?status=queued', keySession());
    expect(queuedList.body.tasks.some((t) => t.id === done.id)).toBe(false);
    const doneList = await api('/control-room/tasks?status=done', keySession());
    expect(doneList.body.tasks.some((t) => t.id === done.id)).toBe(true);
  });

  it('rejects updating a task with no caller name', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ status: 'done' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/caller/i);
  });

  it('404s updating a task that does not exist', async () => {
    const got = await api('/control-room/tasks/does-not-exist', keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', status: 'done' }),
    }));
    expect(got.response.status).toBe(404);
  });

  it('updates ordinary fields with just a caller name, no reason required', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', status: 'in_progress', session: 'higglehaven2' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.status).toBe('in_progress');
    expect(got.body.task.session).toBe('higglehaven2');
  });

  // The actual core of N31's fix: this exact transition is what kept
  // reverting with zero explanation (#610/#616/#653/#659). It must be
  // structurally impossible here, not just discouraged.
  it('rejects setting waitingOn to owner with no reason', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'owner' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/reason/i);

    const stillUnchanged = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(stillUnchanged.body.task.waitingOn).toBeNull();
  });

  it('accepts setting waitingOn to owner with a reason, and posts it as a real linked reply', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH',
      body: JSON.stringify({ caller: 'higglehaven4', waitingOn: 'owner', reason: 'Needs a design call on X.' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.waitingOn).toBe('owner');

    const replies = await api(`/control-room/tasks/${task.id}/replies`, keySession());
    expect(replies.body.replies).toHaveLength(1);
    expect(replies.body.replies[0]).toMatchObject({ from: 'higglehaven4', text: 'Needs a design call on X.' });
  });

  it('does not require a reason when waitingOn is already owner and stays owner', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven4', waitingOn: 'owner', reason: 'First reason.' }),
    }));
    // A second, unrelated field update while still waitingOn:'owner' isn't
    // the transition N31 is guarding against (that already has its
    // explanation on record) -- only the transition INTO 'owner' is gated.
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven4', waitingOn: 'owner', viewed: true }),
    }));
    expect(got.response.status).toBe(200);
    const replies = await api(`/control-room/tasks/${task.id}/replies`, keySession());
    expect(replies.body.replies).toHaveLength(1);
  });

  it('clearing waitingOn away from owner needs no reason', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven4', waitingOn: 'owner', reason: 'Blocked.' }),
    }));
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'owner', waitingOn: 'claude' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.waitingOn).toBe('claude');
  });
});

describe('Control Room replies (#N31)', () => {
  it('rejects a reply with no caller name', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ text: 'No caller here.' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/from/i);
  });

  it('rejects a reply with no message text', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'higglehaven2' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/text/i);
  });

  it('404s replying to a task that does not exist', async () => {
    const got = await api('/control-room/tasks/does-not-exist/replies', keySession({
      method: 'POST', body: JSON.stringify({ from: 'higglehaven2', text: 'Hi' }),
    }));
    expect(got.response.status).toBe(404);
  });

  it('creates a reply and bumps the parent task updatedAt', async () => {
    const task = await createTask();
    const before = task.updatedAt;
    const posted = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'owner', text: 'Sounds good.' }),
    }));
    expect(posted.response.status).toBe(201);

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.updatedAt >= before).toBe(true);

    const replies = await api(`/control-room/tasks/${task.id}/replies`, keySession());
    expect(replies.body.replies).toHaveLength(1);
    expect(replies.body.replies[0]).toMatchObject({ from: 'owner', text: 'Sounds good.' });
  });
});
