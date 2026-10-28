// N31 (owner, Control Room, 2026-09-11): "I must insist that we move this
// page to a proper server-based format. That will enable a structured API
// that we write which can reject calls that don't meet the required
// criteria (caller name and message text)." These tests exercise exactly
// that: every mutating endpoint rejects a call missing a caller name or
// message text, and setting waitingOn:'owner' is impossible without a
// reason landing as a real, linked reply in the same request.
import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupUnreferencedModels } from './lib/models.js';
import { api, glbFile, signupAdmin, signupBuilder } from './test-helpers.js';

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

  // #971: `from` used to skip the labelValue cap every other short field in
  // this handler (session, tag, url, prUrl, kind, waitingOn) already has.
  it('rejects an over-length caller name', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST', body: JSON.stringify({ from: 'x'.repeat(101), title: 'Has a title' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/from.*must be 100 characters or fewer/i);
  });

  it('creates a task with a caller name and message text, defaulting status to queued', async () => {
    const task = await createTask({ from: 'higglehaven2', title: 'Ship the migration' });
    expect(task.status).toBe('queued');
    expect(task.from).toBe('higglehaven2');
    expect(task.title).toBe('Ship the migration');
    expect(task.waitingOn).toBeNull();
  });

  // #915: labelValue alone never gave an invalid status a field-scoped
  // error -- the schema's own CHECK constraint already rejected it, but
  // only with an opaque "Request violates a database constraint" message,
  // unlike every other rejected field in this API. `kind` deliberately has
  // no such check (migration 0082_control_room.sql's own comment: kind/tag
  // are intentionally free-text, "a CHECK constraint would just become a
  // recurring migration tax") -- do not add one; only status is covered.
  it('rejects creating a task with an invalid status, with a field-scoped error', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'Bad status', status: 'Done' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/status/i);
  });

  it('accepts creating a task with each documented status value', async () => {
    for (const status of ['queued', 'in_progress', 'done']) {
      const task = await createTask({ from: 'higglehaven2', title: `Status ${status}`, status });
      expect(task.status).toBe(status);
    }
  });

  it('still accepts an arbitrary, non-enumerated kind (intentionally free-text)', async () => {
    const task = await createTask({ from: 'higglehaven2', title: 'Freeform kind', kind: 'a-brand-new-kind' });
    expect(task.kind).toBe('a-brand-new-kind');
  });

  it('rejects updating a task to an invalid status, with a field-scoped error', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', status: 'in-progress' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/status/i);
  });

  // #909: the update handler's "core of N31's fix" (below) only ever
  // covered the update path -- a brand-new task could still be created
  // already sitting at waitingOn:'owner' with no explanation anywhere,
  // reproducing the exact bug N31 exists to prevent.
  it('rejects creating a task with waitingOn owner and no reason', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'Needs owner already', waitingOn: 'owner' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/reason/i);
  });

  // #1070: waitingOn is deliberately free-text too (a "blocked on #123"
  // task id must pass through untouched, see the test just below this
  // block), so the 'owner' sentinel comparison couldn't be an enum check
  // either -- but it used to be case-sensitive, letting a casing variant
  // (e.g. 'Owner') bypass the reason requirement entirely.
  it('rejects creating a task with a casing variant of waitingOn owner and no reason', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'Needs owner already, cased oddly', waitingOn: 'Owner' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/reason/i);
  });

  it('normalizes a casing variant of waitingOn owner to the canonical lowercase value once a reason is given', async () => {
    const task = await createTask({
      from: 'higglehaven3', title: 'Needs a design call, cased oddly', waitingOn: 'OWNER', reason: 'Needs the owner\'s judgment on X.',
    });
    expect(task.waitingOn).toBe('owner');
  });

  it('accepts creating a task with waitingOn owner and a reason, posting it as a real linked reply', async () => {
    const task = await createTask({
      from: 'higglehaven3', title: 'Needs a design call', waitingOn: 'owner', reason: 'Needs the owner\'s judgment on X.',
    });
    expect(task.waitingOn).toBe('owner');

    const replies = await api(`/control-room/tasks/${task.id}/replies`, keySession());
    expect(replies.body.replies).toHaveLength(1);
    expect(replies.body.replies[0]).toMatchObject({ from: 'higglehaven3', text: 'Needs the owner\'s judgment on X.' });
  });

  // #2301: handleControlRoomTaskUpdate's settingWaitingOnOwner branch and
  // handleControlRoomReplyCreate both stamp lastReplyFrom/lastReplyAt on the
  // reply they insert (see the tests below this describe block) -- this
  // create path inserts the identical shape of linked reply but never
  // stamped these columns, leaving them null despite a real reply landing.
  it('stamps lastReplyFrom/lastReplyAt on the linked reply inserted by creating a task with waitingOn owner', async () => {
    const task = await createTask({
      from: 'higglehaven3', title: 'Needs a design call', waitingOn: 'owner', reason: 'Needs the owner\'s judgment on X.',
    });
    expect(task.lastReplyFrom).toBe('higglehaven3');
    expect(task.lastReplyAt).toBe(task.createdAt);
  });

  it('creates a task with waitingOn set to something other than owner, no reason required', async () => {
    const task = await createTask({ from: 'higglehaven2', title: 'Blocked on another task', waitingOn: 'issue-123' });
    expect(task.waitingOn).toBe('issue-123');
  });

  // #1449: #1070 normalized casing for the 'owner' sentinel only -- 'claude'
  // and 'subtasks' are also sentinels the board (admin-control-room.html's
  // waitingBadge()) compares with a strict ===, so a casing variant of
  // either used to render a nonsensical "Blocked on #Claude"-style pill
  // instead of the correct badge.
  it('normalizes a casing variant of waitingOn claude to the canonical lowercase value', async () => {
    const task = await createTask({ from: 'higglehaven2', title: 'Ready for Claude, cased oddly', waitingOn: 'Claude' });
    expect(task.waitingOn).toBe('claude');
  });

  it('normalizes a casing variant of waitingOn subtasks to the canonical lowercase value', async () => {
    const task = await createTask({ from: 'higglehaven2', title: 'Waiting on subtasks, cased oddly', waitingOn: 'SUBTASKS' });
    expect(task.waitingOn).toBe('subtasks');
  });

  it('creates a task with a prUrl', async () => {
    const task = await createTask({ prUrl: 'https://github.com/RunbotRobot/higglehaven/pull/902' });
    expect(task.pr).toBe('https://github.com/RunbotRobot/higglehaven/pull/902');
  });

  it('defaults pr to null when prUrl is omitted', async () => {
    const task = await createTask();
    expect(task.pr).toBeNull();
  });

  // #1460: url/prUrl/imageUrl used to go through plain labelValue (length
  // cap only) -- the admin board renders them as an <a href>/<img src> with
  // only HTML-entity escaping, so a non-http(s) scheme like "javascript:"
  // landed in the DOM untouched and executed on click.
  it('rejects a task url with a non-http(s) scheme', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'Has a title', url: 'javascript:alert(1)' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/url.*http/i);
  });

  it('rejects a task prUrl with a non-http(s) scheme', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'Has a title', prUrl: 'javascript:alert(1)' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/prUrl.*http/i);
  });

  it('rejects a task imageUrl with a non-http(s) scheme', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'Has a title', imageUrl: 'javascript:alert(1)' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/imageUrl.*http/i);
  });

  // imageUrl, unlike url/prUrl, routinely holds a same-origin /uploads/
  // reference (a real uploaded image), not a full URL -- must keep working.
  it('accepts a task imageUrl pointing at a same-origin /uploads/ path', async () => {
    const task = await createTask({ imageUrl: '/uploads/e2e-task-thumb.png' });
    expect(task.imageUrl).toBe('/uploads/e2e-task-thumb.png');
  });

  // #1655: a task's imageUrl can point into the exact same MODELS R2 bucket/
  // URL scheme catalog_templates.model_url/image_url and video_generation_
  // jobs.model_url already share (see #774/#1644, the same reference-check
  // gap fixed twice already in cleanupUnreferencedModels) -- without this,
  // the next cleanup sweep reads a real, live screenshot as "unreferenced"
  // and deletes it out from under the task.
  it("treats a task's imageUrl as still referenced, not an orphan to sweep", async () => {
    const form = new FormData();
    form.set('file', glbFile({ json: '{"controlRoomTaskScreenshot":true}' }));
    const upload = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
    expect(upload.status).toBe(201);
    const { modelUrl } = await upload.json();

    const task = await createTask({ imageUrl: modelUrl });
    expect(task.imageUrl).toBe(modelUrl);

    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: false, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).not.toContain(modelUrl);
    expect((await SELF.fetch(`https://higglehaven.test${modelUrl}`)).status).toBe(200);
  });

  // Owner feedback (control room notes 9461ee39/96d6d08c, 2026-09-28): a
  // message-shaped task (kind feedback/question, no GitHub issue/PR behind
  // it) had no visible id at all, since taskNumberLabel (admin-control-
  // room.html) only ever renders one from `number` or `noteNumber`, and
  // nothing populated `noteNumber` unless the caller happened to supply it.
  it('auto-assigns a sequential noteNumber to a message-shaped task with neither number nor noteNumber given', async () => {
    const first = await createTask({ title: 'First auto-numbered note' });
    const second = await createTask({ title: 'Second auto-numbered note' });
    expect(typeof first.noteNumber).toBe('number');
    expect(second.noteNumber).toBe(first.noteNumber + 1);
  });

  it('auto-assigns a noteNumber for kind question the same as feedback', async () => {
    const task = await createTask({ kind: 'question', title: 'A question needing an id' });
    expect(typeof task.noteNumber).toBe('number');
  });

  // #1070: kind is deliberately free-text (a GitHub-issue kind must pass
  // through untouched, see the "issue-backed" test just below), so this
  // couldn't be an enum check -- but the message-shaped comparison itself
  // used to be case-sensitive, silently skipping auto-numbering for any
  // casing variant of 'feedback'/'question'.
  it('auto-assigns a noteNumber for a casing variant of kind feedback', async () => {
    const task = await createTask({ kind: 'Feedback', title: 'Casing-variant kind' });
    expect(typeof task.noteNumber).toBe('number');
  });

  // #2205: the gate above (auto-numbering) already worked case-insensitively,
  // but kind itself was never normalized to the canonical lowercase value --
  // admin-control-room.html's needsAnswerBadge() does a strict === against
  // the stored kind, so a casing variant like 'Question' silently never
  // showed the "Needs your answer" badge even though it's a real question.
  it('normalizes a casing variant of kind feedback to the canonical lowercase value', async () => {
    const task = await createTask({ kind: 'Feedback', title: 'Casing-variant kind, feedback' });
    expect(task.kind).toBe('feedback');
  });

  it('normalizes a casing variant of kind question to the canonical lowercase value', async () => {
    const task = await createTask({ kind: 'Question', title: 'Casing-variant kind, question' });
    expect(task.kind).toBe('question');
  });

  it('does not auto-assign a noteNumber when one is explicitly given', async () => {
    const task = await createTask({ title: 'Explicit note number', noteNumber: 9001 });
    expect(task.noteNumber).toBe(9001);
  });

  it('does not auto-assign a noteNumber for a GitHub-issue-backed task', async () => {
    const task = await createTask({ kind: 'issue', number: 8001, title: 'A real GitHub issue' });
    expect(task.number).toBe(8001);
    expect(task.noteNumber).toBeNull();
    // #2205: a non-sentinel kind (anything other than feedback/question)
    // must pass through untouched, not get coerced by the canonicalization.
    expect(task.kind).toBe('issue');
  });

  it('rejects creating a second task with a duplicate explicit id', async () => {
    const task = await createTask({ id: 'issue-9001' });
    expect(task.id).toBe('issue-9001');
    const dupe = await api('/control-room/tasks', keySession({
      method: 'POST', body: JSON.stringify({ id: 'issue-9001', from: 'higglehaven3', title: 'Duplicate' }),
    }));
    expect(dupe.response.status).toBe(409);
  });

  // #1584: an explicit id with no character restriction was interpolated
  // unescaped into the admin board's HTML attributes -- rejecting anything
  // outside a plain alphanumeric/hyphen/underscore charset here closes that
  // off at the source rather than relying solely on the rendering side.
  it('rejects an explicit id containing HTML-breakout characters', async () => {
    const got = await api('/control-room/tasks', keySession({
      method: 'POST',
      body: JSON.stringify({ id: '"><img src=x onerror=alert(1)>', from: 'attacker', title: 'XSS attempt' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/id/);
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

  // #986: unlike the create/update handlers' own status field (validated by
  // controlRoomStatusValue since #915), this list endpoint's status query
  // filter went straight into the WHERE clause with no check -- a typo'd
  // value (wrong case, wrong separator) silently matched zero rows instead
  // of 400ing, same failure shape #915's own tests check for create/update.
  it('rejects an invalid status filter on the task list, with a field-scoped error', async () => {
    const wrongCase = await api('/control-room/tasks?status=Done', keySession());
    expect(wrongCase.response.status).toBe(400);
    expect(wrongCase.body.error).toMatch(/status/i);

    const wrongSeparator = await api('/control-room/tasks?status=in-progress', keySession());
    expect(wrongSeparator.response.status).toBe(400);
    expect(wrongSeparator.body.error).toMatch(/status/i);
  });

  // Owner, Control Room: the admin page's header kept reading "500 tasks
  // total" forever once the board actually passed 500 rows, because it was
  // displaying tasks.length off the same LIMIT-500 result set the page
  // renders from rather than a real, uncapped count. `total` is that real
  // count — independent of the LIMIT and of whatever `status` filter is
  // applied, so it moves with real inserts even once the list itself is
  // capped.
  it('returns a real total count, not just how many rows this call returned', async () => {
    const before = await api('/control-room/tasks', keySession());
    const beforeTotal = before.body.total;
    expect(beforeTotal).toBe(before.body.tasks.length);

    await createTask({ title: 'Counts toward the real total, one' });
    await createTask({ title: 'Counts toward the real total, two' });

    const after = await api('/control-room/tasks', keySession());
    expect(after.body.total).toBe(beforeTotal + 2);
    expect(after.body.total).toBe(after.body.tasks.length);
  });

  it('scopes total to the same status filter as the list itself', async () => {
    const done = await createTask({ title: 'Scoped total, done' });
    await api(`/control-room/tasks/${done.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', status: 'done' }),
    }));
    const queuedBefore = await api('/control-room/tasks?status=queued', keySession());
    const doneBefore = await api('/control-room/tasks?status=done', keySession());

    await createTask({ title: 'Scoped total, another queued one' });

    const queuedAfter = await api('/control-room/tasks?status=queued', keySession());
    const doneAfter = await api('/control-room/tasks?status=done', keySession());
    expect(queuedAfter.body.total).toBe(queuedBefore.body.total + 1);
    expect(doneAfter.body.total).toBe(doneBefore.body.total);
  });

  it('rejects updating a task with no caller name', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ status: 'done' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/caller/i);
  });

  // #971: `caller` used to skip the same labelValue cap.
  it('rejects an over-length caller name on update', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'x'.repeat(101), status: 'done' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/caller.*must be 100 characters or fewer/i);
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

  it('updates prUrl on an existing task', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH',
      body: JSON.stringify({ caller: 'higglehaven2', prUrl: 'https://github.com/RunbotRobot/higglehaven/pull/910' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.pr).toBe('https://github.com/RunbotRobot/higglehaven/pull/910');
  });

  it('rejects updating prUrl to a non-http(s) scheme', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH',
      body: JSON.stringify({ caller: 'higglehaven2', prUrl: 'javascript:alert(1)' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/prUrl.*http/i);
  });

  it('clears prUrl by setting it to null', async () => {
    const task = await createTask({ prUrl: 'https://github.com/RunbotRobot/higglehaven/pull/910' });
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', prUrl: null }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.pr).toBeNull();
  });

  // #1058: a note's own author used to go unrecorded, so the admin board's
  // threadEntries() fell back to task.session (which a session resets to ''
  // on stand-down) or task.from (posted_by -- whoever originally created the
  // task, e.g. "owner"), misattributing the note whenever the two didn't
  // match whoever actually wrote it. noteAuthor is set to the update's own
  // `caller` whenever `note` is written, independent of session/from.
  it('records the caller as noteAuthor when a note is set', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven3', note: 'Investigating.' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.note).toBe('Investigating.');
    expect(got.body.task.noteAuthor).toBe('higglehaven3');
  });

  it('keeps noteAuthor as whoever wrote the note even after the task stands down to an empty session', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven3', session: 'higglehaven3', note: 'Progress update.' }),
    }));
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven3', session: '' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.session).toBe('');
    expect(got.body.task.noteAuthor).toBe('higglehaven3');
  });

  it('clears noteAuthor by clearing the note', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven3', note: 'Progress update.' }),
    }));
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven3', note: null }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.note).toBeNull();
    expect(got.body.task.noteAuthor).toBeNull();
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

  // #1070: same gap as the create-path test above, on the update path's
  // own separate comparison.
  it('rejects setting waitingOn to a casing variant of owner with no reason, and normalizes it once a reason is given', async () => {
    const task = await createTask();
    const rejected = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'Owner' }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/reason/i);

    const accepted = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'OWNER', reason: 'Needs a design call.' }),
    }));
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.task.waitingOn).toBe('owner');
  });

  // #1449: same gap as the create-path tests above, on the update path's
  // own separate comparison -- these two sentinels never required a reason,
  // so there's no reject-then-accept shape to test, just the normalization.
  it('normalizes a casing variant of waitingOn claude to the canonical lowercase value on update', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'Claude' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.waitingOn).toBe('claude');
  });

  it('normalizes a casing variant of waitingOn subtasks to the canonical lowercase value on update', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'SUBTASKS' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.waitingOn).toBe('subtasks');
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

  // Sub-issue links for tracking tasks (e.g. #326 listing #583-#586) --
  // previously only ever written by a direct D1 query, since neither
  // create nor update accepted them at all.
  describe('sub-issue links', () => {
    it('creates a task with subIssues and subIssueSummaries', async () => {
      const task = await createTask({
        title: 'Tracking task',
        subIssues: [583, 584],
        subIssueSummaries: { 583: 'Voice signaling', 584: 'Avatar wardrobe' },
      });
      expect(task.subIssues).toEqual([583, 584]);
      expect(task.subIssueSummaries).toEqual({ 583: 'Voice signaling', 584: 'Avatar wardrobe' });
    });

    it('defaults subIssues and subIssueSummaries to null when omitted', async () => {
      const task = await createTask({ title: 'No sub-issues' });
      expect(task.subIssues).toBeNull();
      expect(task.subIssueSummaries).toBeNull();
    });

    it('rejects a non-array subIssues', async () => {
      const got = await api('/control-room/tasks', keySession({
        method: 'POST',
        body: JSON.stringify({ from: 'higglehaven2', title: 'Bad', subIssues: 583 }),
      }));
      expect(got.response.status).toBe(400);
      expect(got.body.error).toMatch(/subIssues/);
    });

    it('rejects a subIssues entry that is not a positive integer', async () => {
      const got = await api('/control-room/tasks', keySession({
        method: 'POST',
        body: JSON.stringify({ from: 'higglehaven2', title: 'Bad', subIssues: [583, -1] }),
      }));
      expect(got.response.status).toBe(400);
    });

    it('rejects more than 50 subIssues entries', async () => {
      const got = await api('/control-room/tasks', keySession({
        method: 'POST',
        body: JSON.stringify({ from: 'higglehaven2', title: 'Bad', subIssues: Array.from({ length: 51 }, (_, i) => i + 1) }),
      }));
      expect(got.response.status).toBe(400);
      expect(got.body.error).toMatch(/50/);
    });

    it('rejects a non-object subIssueSummaries', async () => {
      const got = await api('/control-room/tasks', keySession({
        method: 'POST',
        body: JSON.stringify({ from: 'higglehaven2', title: 'Bad', subIssueSummaries: ['not an object'] }),
      }));
      expect(got.response.status).toBe(400);
      expect(got.body.error).toMatch(/subIssueSummaries/);
    });

    it('rejects a subIssueSummaries key that is not a sub-issue number', async () => {
      const got = await api('/control-room/tasks', keySession({
        method: 'POST',
        body: JSON.stringify({ from: 'higglehaven2', title: 'Bad', subIssueSummaries: { notanumber: 'Oops' } }),
      }));
      expect(got.response.status).toBe(400);
      expect(got.body.error).toMatch(/subIssueSummaries/);
    });

    it('rejects more than 50 subIssueSummaries entries', async () => {
      const subIssueSummaries = Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => [String(i + 1), 'Summary']),
      );
      const got = await api('/control-room/tasks', keySession({
        method: 'POST',
        body: JSON.stringify({ from: 'higglehaven2', title: 'Bad', subIssueSummaries }),
      }));
      expect(got.response.status).toBe(400);
      expect(got.body.error).toMatch(/50/);
    });

    it('updates subIssues and subIssueSummaries on an existing task', async () => {
      const task = await createTask({ title: 'Tracking task, updated later' });
      const got = await api(`/control-room/tasks/${task.id}`, keySession({
        method: 'PATCH',
        body: JSON.stringify({
          caller: 'higglehaven2',
          subIssues: [585, 586],
          subIssueSummaries: { 585: 'Landlet renaming' },
        }),
      }));
      expect(got.response.status).toBe(200);
      expect(got.body.task.subIssues).toEqual([585, 586]);
      expect(got.body.task.subIssueSummaries).toEqual({ 585: 'Landlet renaming' });
    });

    it('clears subIssues and subIssueSummaries by setting them to null', async () => {
      const task = await createTask({ title: 'Tracking task, then cleared', subIssues: [583] });
      const got = await api(`/control-room/tasks/${task.id}`, keySession({
        method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', subIssues: null }),
      }));
      expect(got.response.status).toBe(200);
      expect(got.body.task.subIssues).toBeNull();
    });
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

  // #971: reply `from` used to skip the same labelValue cap.
  it('rejects an over-length caller name on a reply', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'x'.repeat(101), text: 'Hi' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/from.*must be 100 characters or fewer/i);
  });

  it('rejects a reply imageUrl with a non-http(s) scheme', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', text: 'Hi', imageUrl: 'javascript:alert(1)' }),
    }));
    expect(got.response.status).toBe(400);
    expect(got.body.error).toMatch(/imageUrl.*http/i);
  });

  it('accepts a reply imageUrl pointing at a same-origin /uploads/ path', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', text: 'Hi', imageUrl: '/uploads/e2e-reply-attachment.png' }),
    }));
    expect(got.response.status).toBe(201);
    expect(got.body.reply.imageUrl).toBe('/uploads/e2e-reply-attachment.png');
  });

  // #1655: same gap as the task-imageUrl regression test above, for
  // control_room_replies.image_url -- a second, independent writer into
  // the same bucket/scheme that cleanupUnreferencedModels also needs to
  // check.
  it("treats a reply's imageUrl as still referenced, not an orphan to sweep", async () => {
    const form = new FormData();
    form.set('file', glbFile({ json: '{"controlRoomReplyScreenshot":true}' }));
    const upload = await SELF.fetch('https://higglehaven.test/api/models', { method: 'POST', body: form });
    expect(upload.status).toBe(201);
    const { modelUrl } = await upload.json();

    const task = await createTask();
    const reply = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', text: 'Hi', imageUrl: modelUrl }),
    }));
    expect(reply.response.status).toBe(201);

    const cleanup = await cleanupUnreferencedModels(env, { maxDeletes: 100, dryRun: false, minAgeMs: 0 });
    expect(cleanup.targetModelUrls).not.toContain(modelUrl);
    expect((await SELF.fetch(`https://higglehaven.test${modelUrl}`)).status).toBe(200);
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

  // #997: a reply used to only bump updatedAt, leaving a task the owner
  // already reviewed (viewed: true) showing no "New" indicator even though
  // it just got fresh activity -- the same "sits hidden" failure mode
  // AGENTS.md's own Control Room section calls out.
  it('clears the parent task viewed flag when a reply is posted', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'owner', viewed: true }),
    }));
    const before = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(before.body.task.viewed).toBe(true);

    const posted = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'higglehaven9', text: 'Reply after being viewed.' }),
    }));
    expect(posted.response.status).toBe(201);

    const after = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(after.body.task.viewed).toBe(false);
  });

  // #1550: the same "sits hidden" failure mode #997 fixed above, reachable
  // through this endpoint's own separate reply-insertion path (settingWaitingOnOwner
  // inserting the reason as a real linked reply) instead of the dedicated
  // POST .../replies one.
  it('clears the parent task viewed flag when waitingOn is set to owner with a reason', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'owner', viewed: true }),
    }));
    const before = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(before.body.task.viewed).toBe(true);

    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH',
      body: JSON.stringify({ caller: 'higglehaven10', waitingOn: 'owner', reason: 'Needs a design call.' }),
    }));
    expect(got.response.status).toBe(200);
    expect(got.body.task.viewed).toBe(false);
  });

  // #2254: AGENTS.md documents this auto-clear as already shipped, but it
  // was never actually built against this real, N31-era API -- only an
  // owner reply to a task genuinely waitingOn them should clear it.
  it('auto-clears waitingOn to claude when the owner replies to a task waiting on them', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'owner', reason: 'Needs a design call.' }),
    }));
    const replied = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'owner', text: 'Go with option 2.' }),
    }));
    expect(replied.response.status).toBe(201);

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.waitingOn).toBe('claude');
  });

  it('auto-clears waitingOn regardless of the owner reply from-name casing', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'owner', reason: 'Needs a design call.' }),
    }));
    await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'Owner', text: 'Go with option 2.' }),
    }));

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.waitingOn).toBe('claude');
  });

  it('does not touch waitingOn when a non-owner reply arrives', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'owner', reason: 'Needs a design call.' }),
    }));
    await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'higglehaven5', text: 'Following up while we wait.' }),
    }));

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.waitingOn).toBe('owner');
  });

  it('does not clear waitingOn when the owner replies but the task is not waiting on them', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven2', waitingOn: 'claude' }),
    }));
    await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'owner', text: 'Just a note.' }),
    }));

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.waitingOn).toBe('claude');
  });

  it('stamps lastReplyFrom/lastReplyAt on a reply-create', async () => {
    const task = await createTask();
    expect(task.lastReplyFrom).toBeNull();

    const posted = await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'higglehaven7', text: 'On it.' }),
    }));
    expect(posted.response.status).toBe(201);

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.lastReplyFrom).toBe('higglehaven7');
    expect(got.body.task.lastReplyAt).toBe(posted.body.reply.createdAt);
  });

  it('stamps lastReplyFrom/lastReplyAt on the linked reply inserted by waitingOn:owner with a reason', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'higglehaven8', waitingOn: 'owner', reason: 'Needs a design call.' }),
    }));
    expect(got.body.task.lastReplyFrom).toBe('higglehaven8');
    expect(got.body.task.lastReplyAt).toBe(got.body.task.updatedAt);
  });

  // #2830: lastReplyFrom feeds waitingBadge()'s own strict === against the
  // literal lowercase string 'owner' (admin-control-room.html) -- a caller
  // who writes a case-variant like "Owner"/"OWNER" must still normalize to
  // that canonical form, same #1070/#1449/#2205 precedent already covering
  // waitingOn/kind, or the "(unexplained)" safety-net badge silently never
  // renders for a card whose owner-authored reply used different casing.
  it('normalizes a case-variant owner reply to the canonical lastReplyFrom on reply-create', async () => {
    const task = await createTask();
    await api(`/control-room/tasks/${task.id}/replies`, keySession({
      method: 'POST', body: JSON.stringify({ from: 'Owner', text: 'Just a note.' }),
    }));

    const got = await api(`/control-room/tasks/${task.id}`, keySession());
    expect(got.body.task.lastReplyFrom).toBe('owner');
    // The reply's own `from` attribution is unaffected -- only the task's
    // own lastReplyFrom sentinel column is normalized.
    const replies = await api(`/control-room/tasks/${task.id}/replies`, keySession());
    expect(replies.body.replies[0].from).toBe('Owner');
  });

  it('normalizes a case-variant caller to the canonical lastReplyFrom when setting waitingOn:owner via update', async () => {
    const task = await createTask();
    const got = await api(`/control-room/tasks/${task.id}`, keySession({
      method: 'PATCH', body: JSON.stringify({ caller: 'OWNER', waitingOn: 'owner', reason: 'Needs a design call.' }),
    }));
    expect(got.body.task.lastReplyFrom).toBe('owner');
  });

  it('normalizes a case-variant from to the canonical lastReplyFrom when creating a task with waitingOn:owner', async () => {
    const task = await createTask({
      from: 'Owner', title: 'Needs a design call', waitingOn: 'owner', reason: 'Needs the owner\'s judgment on X.',
    });
    expect(task.lastReplyFrom).toBe('owner');
  });
});

// N31 option 3 (owner: "I would like to do option 3. Isn't there a way to
// do it for free?") — the board served same-origin from this same Worker
// (GET /admin/control-room), gated by the owner's ordinary admin session
// cookie instead of a browser-visible CONTROL_ROOM_API_KEY.
describe('Control Room admin page (/admin/control-room, #N31 option 3)', () => {
  it('requires sign-in for a caller with no session at all', async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin/control-room');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('rejects a signed-in non-admin session', async () => {
    const builder = await signupBuilder('control-room-non-admin');
    const response = await SELF.fetch('https://higglehaven.test/admin/control-room', builder.session());
    expect(response.status).toBe(403);
  });

  // Only the requireAdmin gate itself is exercised here, not the actual
  // served page content — this pool's ASSETS binding points at dist/,
  // which this test suite never builds (unlike e2e/run-all.mjs, which
  // does), so public/admin-control-room.html may not exist as a built
  // asset yet in this environment. An admin session reaching past the
  // gate is proven by getting anything other than the 401/403 an
  // unauthorized caller gets above — whether that lands on a real 200 or
  // (locally, pre-build) a 404 from the missing asset depends on build
  // state this test shouldn't assume either way. The real page's content
  // and behavior are covered end-to-end by
  // e2e/control-room-admin-page.test.mjs, which runs against a real build.
  it("lets the owner's own admin session past the access gate", async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin/control-room', adminSession());
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it('404s a non-GET request to the admin page route', async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin/control-room', { ...adminSession(), method: 'POST' });
    expect(response.status).toBe(404);
  });

  // #2173: this handler's own try/catch around requireAdmin only handles
  // HttpError (rendering the sign-in page) and re-throws anything else --
  // before the fix, routeRequest called this handler with no wrapping
  // .catch at all, unlike every /api/ and /uploads/ route, so a non-
  // HttpError escaping requireAdmin (a raw D1/runtime failure from its own
  // account_suspensions lookup) propagated out of the whole request
  // instead of landing on this app's own consistent JSON error shape.
  // Simulates exactly that by making the account_suspensions query itself
  // throw a plain Error, same proxy idiom video-generation.test.js/
  // auctions.test.js already use for a "simulated transient D1 failure".
  it("converts a non-HttpError thrown past requireAdmin's own catch into a clean 500, not an unhandled exception", async () => {
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (!sql.includes('account_suspensions')) return stmt;
      return {
        bind: (...args) => {
          const bound = stmt.bind(...args);
          return new Proxy(bound, {
            get(target, prop) {
              if (prop === 'first') return async () => { throw new Error('simulated transient D1 failure'); };
              const value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    };
    let response;
    try {
      response = await SELF.fetch('https://higglehaven.test/admin/control-room', adminSession());
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect((await response.json()).error).toBe('Internal server error');
  });
});

// #1818 (sub-issue of #1817): same gate/serve shape as the Control Room and
// Action Log admin pages above, just a different static file behind it.
describe('Admin Dashboard page (/admin/dashboard, #1818)', () => {
  it('requires sign-in for a caller with no session at all', async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin/dashboard');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('rejects a signed-in non-admin session', async () => {
    const builder = await signupBuilder('admin-dashboard-non-admin');
    const response = await SELF.fetch('https://higglehaven.test/admin/dashboard', builder.session());
    expect(response.status).toBe(403);
  });

  // Same reasoning as the Control Room page's own equivalent test above —
  // this pool's ASSETS binding points at dist/, which this suite never
  // builds, so only the requireAdmin gate itself is exercised here (a real
  // 200 vs. a pre-build 404 for the missing static asset both count as
  // "past the gate"). The real page's content is covered end-to-end by
  // e2e/admin-dashboard-page.test.mjs, which runs against a real build.
  it("lets the owner's own admin session past the access gate", async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin/dashboard', adminSession());
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it('404s a non-GET request to the admin page route', async () => {
    const response = await SELF.fetch('https://higglehaven.test/admin/dashboard', { ...adminSession(), method: 'POST' });
    expect(response.status).toBe(404);
  });

  // #2173: same gap and same fix as the Control Room admin page's own
  // equivalent test above -- this handler independently needed the same
  // wrapping .catch in routeRequest.
  it("converts a non-HttpError thrown past requireAdmin's own catch into a clean 500, not an unhandled exception", async () => {
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (!sql.includes('account_suspensions')) return stmt;
      return {
        bind: (...args) => {
          const bound = stmt.bind(...args);
          return new Proxy(bound, {
            get(target, prop) {
              if (prop === 'first') return async () => { throw new Error('simulated transient D1 failure'); };
              const value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    };
    let response;
    try {
      response = await SELF.fetch('https://higglehaven.test/admin/dashboard', adminSession());
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect((await response.json()).error).toBe('Internal server error');
  });
});
