// #3446 (part of #3444): the public sentence about what a fleet session is
// working on, and the three-field read the assistants' presence code uses.
// The card's title and note must never reach it.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api } from './test-helpers.js';
import { readFleetAgentWork, publicLineValue, PUBLIC_LINE_MAX_LENGTH } from './lib/control-room.js';

const API_KEY = 'test-control-room-key-public-line';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  env.CONTROL_ROOM_API_KEY = API_KEY;
});

function keyed(options = {}) {
  return { ...options, headers: { ...options.headers, 'x-control-room-key': API_KEY } };
}

async function createTask(overrides = {}) {
  const { response, body } = await api('/control-room/tasks', keyed({
    method: 'POST',
    body: JSON.stringify({ from: 'higglehaven2', title: 'Private internal title #3446', ...overrides }),
  }));
  expect(response.status).toBe(201);
  return body.task;
}

async function patchTask(id, fields) {
  return api(`/control-room/tasks/${id}`, keyed({
    method: 'PATCH',
    body: JSON.stringify({ caller: 'higglehaven2', ...fields }),
  }));
}

describe('publicLine validation (#3446)', () => {
  it('accepts one short sentence in a shopper\'s terms', () => {
    expect(publicLineValue('smoothing the edge of the sky')).toBe('smoothing the edge of the sky');
    expect(publicLineValue('Tidying up behind the scenes.')).toBe('Tidying up behind the scenes.');
    expect(publicLineValue('stocking the shelves — almost done!')).toBe('stocking the shelves — almost done!');
  });

  it.each([
    ['an issue number', 'fixing #3446 for everyone'],
    ['a spelled-out issue number', 'working on issue 3446 today'],
    ['a pull request number', 'merging PR 3433 now'],
    ['a file path', 'editing src/shop/mode.js'],
    ['a bare file name', 'editing scene.js again'],
    ['a route', 'calling /api/presence a lot'],
    ['a backtick', 'fixing `the thing`'],
    ['a URL', 'looking at https://example.com for ideas'],
    ['a bare domain', 'checking higglehaven.com for gaps'],
    ['two sentences', 'Fixing the sky. It is jagged.'],
    ['a line break', 'fixing the sky\nand the ground'],
    ['an empty string', ''],
    ['only spaces', '   '],
  ])('rejects %s', (_label, text) => {
    expect(() => publicLineValue(text)).toThrow();
  });

  it('rejects a line over the length cap', () => {
    expect(() => publicLineValue('a'.repeat(PUBLIC_LINE_MAX_LENGTH + 1))).toThrow(/characters or fewer/);
    expect(publicLineValue('a'.repeat(PUBLIC_LINE_MAX_LENGTH))).toHaveLength(PUBLIC_LINE_MAX_LENGTH);
  });
});

describe('publicLine on the Control Room API (#3446)', () => {
  it('is stored on create and returned, null when not given', async () => {
    const withLine = await createTask({ id: 'issue-90001', status: 'in_progress', session: 'higglehaven2', publicLine: 'smoothing the edge of the sky' });
    expect(withLine.publicLine).toBe('smoothing the edge of the sky');
    const without = await createTask({ id: 'issue-90002' });
    expect(without.publicLine).toBeNull();
  });

  it('is rejected with a 400 on create and update when it has the wrong shape, and nothing is written', async () => {
    const create = await api('/control-room/tasks', keyed({
      method: 'POST',
      body: JSON.stringify({ from: 'higglehaven2', title: 'x', id: 'issue-90003', publicLine: 'fixing #3446' }),
    }));
    expect(create.response.status).toBe(400);
    const got = await api('/control-room/tasks/issue-90003', keyed());
    expect(got.response.status).toBe(404);

    await createTask({ id: 'issue-90004', status: 'in_progress', session: 'higglehaven2' });
    const update = await patchTask('issue-90004', { publicLine: 'editing src/shop/mode.js' });
    expect(update.response.status).toBe(400);
    const after = await api('/control-room/tasks/issue-90004', keyed());
    expect(after.body.task.publicLine).toBeNull();
  });

  it('is set and replaced by an update, and an empty value clears it', async () => {
    await createTask({ id: 'issue-90005', status: 'in_progress', session: 'higglehaven2' });
    const set = await patchTask('issue-90005', { publicLine: 'stocking the shelves' });
    expect(set.body.task.publicLine).toBe('stocking the shelves');
    const replaced = await patchTask('issue-90005', { publicLine: 'sweeping the paths' });
    expect(replaced.body.task.publicLine).toBe('sweeping the paths');
    const cleared = await patchTask('issue-90005', { publicLine: '' });
    expect(cleared.body.task.publicLine).toBeNull();
  });

  it('is left alone by an update that does not mention it', async () => {
    await createTask({ id: 'issue-90006', status: 'in_progress', session: 'higglehaven2', publicLine: 'watering the lawn' });
    const touched = await patchTask('issue-90006', { note: 'a private progress note' });
    expect(touched.body.task.publicLine).toBe('watering the lawn');
  });

  it('clears when the card goes done, even if the same request sets one', async () => {
    await createTask({ id: 'issue-90007', status: 'in_progress', session: 'higglehaven2', publicLine: 'watering the lawn' });
    const done = await patchTask('issue-90007', { status: 'done', publicLine: 'still watering' });
    expect(done.body.task.publicLine).toBeNull();
  });

  it('clears when the session stands down', async () => {
    await createTask({ id: 'issue-90008', status: 'in_progress', session: 'higglehaven2', publicLine: 'watering the lawn' });
    const standDown = await patchTask('issue-90008', { session: '', status: 'queued' });
    expect(standDown.body.task.publicLine).toBeNull();
  });

  it('is not stored on a card created already done', async () => {
    const task = await createTask({ id: 'issue-90009', status: 'done', publicLine: 'watering the lawn' });
    expect(task.publicLine).toBeNull();
  });
});

describe('fleet agent work read (#3446)', () => {
  it('returns only the session name, busy flag and public sentence, never a title or note', async () => {
    await env.DB.prepare("DELETE FROM control_room_tasks WHERE session LIKE 'higglehaven%'").run();
    await createTask({ id: 'issue-91001', title: 'SECRET internal title about auth #1234', status: 'in_progress', session: 'higglehaven7', publicLine: 'smoothing the edge of the sky' });
    await patchTask('issue-91001', { note: 'SECRET note with src/worker/auth.js details' });
    await createTask({ id: 'issue-91002', title: 'Another private title', status: 'in_progress', session: 'higglehaven3' });
    await createTask({ id: 'issue-91003', title: 'Done long ago', status: 'done', session: 'higglehaven11' });
    await createTask({ id: 'issue-91004', title: 'Not a fleet name', status: 'in_progress', session: 'owner', publicLine: 'should not appear' });

    const agents = await readFleetAgentWork(env.DB);
    expect(agents).toEqual([
      { session: 'higglehaven3', busy: true, publicLine: null },
      { session: 'higglehaven7', busy: true, publicLine: 'smoothing the edge of the sky' },
      { session: 'higglehaven11', busy: false, publicLine: null },
    ]);
    expect(JSON.stringify(agents)).not.toMatch(/SECRET|private|auth|#1234/);
  });

  it('uses the most recently updated in-progress card\'s sentence when a session has several', async () => {
    await env.DB.prepare("DELETE FROM control_room_tasks WHERE session LIKE 'higglehaven%'").run();
    await createTask({ id: 'issue-92001', status: 'in_progress', session: 'higglehaven5', publicLine: 'the older job' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createTask({ id: 'issue-92002', status: 'in_progress', session: 'higglehaven5', publicLine: 'the newer job' });
    const agents = await readFleetAgentWork(env.DB);
    expect(agents).toEqual([{ session: 'higglehaven5', busy: true, publicLine: 'the newer job' }]);
  });

  it('is served by an access-gated route', async () => {
    const anonymous = await api('/control-room/agents');
    expect(anonymous.response.status).toBe(401);
    const keyedRead = await api('/control-room/agents', keyed());
    expect(keyedRead.response.status).toBe(200);
    expect(Array.isArray(keyedRead.body.agents)).toBe(true);
  });
});
