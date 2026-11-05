import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js'; // eslint-disable-line no-unused-vars
import {
  api, signupBuilder, signupAdmin, createGreenbeltLandletAs,
} from './test-helpers.js';

// #3142 (one alias per person): a person has one name, their username. Sign
// posts and calendar events snapshot it as author_label when posted, but the
// public lists show the author's CURRENT username where their account still
// exists, and fall back to the posting-time snapshot where it doesn't (a name
// is never lost). GDPR export rows are plain SELECT * and keep the stored
// name; that path is not covered here.
let owner;
let poster;
let landletId;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('alias-admin');
  landletId = 'alias-current-username-landlet';
  await createGreenbeltLandletAs(admin.session, landletId);
  owner = await signupBuilder('alias-owner');
  poster = await signupBuilder('alias-poster');
  const claimed = await api(`/landlets/${landletId}/claim`, owner.session({ method: 'POST' }));
  expect(claimed.response.status).toBe(200);
});

async function placeSign(instanceId, flag) {
  const created = await api('/instances', owner.session({
    method: 'POST',
    body: JSON.stringify({
      instanceId, landletId, templateId: 'placeholder-tree', x: 2, y: 2, [flag]: true,
    }),
  }));
  expect(created.response.status).toBe(201);
}

describe('current username on public author labels', () => {
  it('shows a sign post author\'s current username after a rename, and keeps the snapshot when the account row is gone', async () => {
    await placeSign('alias-sign-instance', 'isCommunitySign');
    const posted = await api('/instances/alias-sign-instance/posts', poster.session({
      method: 'POST', body: JSON.stringify({ text: 'hello from before the rename' }),
    }));
    expect(posted.response.status).toBe(201);
    expect(posted.body.post.authorLabel).toBe('alias-poster');

    const renamed = await api(`/builders/${poster.builderId}`, poster.session({
      method: 'PATCH', body: JSON.stringify({ label: 'alias-poster-renamed' }),
    }));
    expect(renamed.response.status).toBe(200);

    const list = await api('/instances/alias-sign-instance/posts');
    expect(list.body.posts).toHaveLength(1);
    expect(list.body.posts[0].authorLabel).toBe('alias-poster-renamed');

    // The stored snapshot is untouched (history), only the list's view moves.
    const stored = await env.DB.prepare('SELECT author_label FROM sign_posts WHERE instance_id = ?')
      .bind('alias-sign-instance').first();
    expect(stored.author_label).toBe('alias-poster');

    // An author with no account on record (a legacy row, or a deleted account) keeps the posting-time name.
    await env.DB.prepare('UPDATE sign_posts SET user_id = NULL WHERE instance_id = ?')
      .bind('alias-sign-instance').run();
    const orphaned = await api('/instances/alias-sign-instance/posts');
    expect(orphaned.body.posts[0].authorLabel).toBe('alias-poster');
  });

  it('shows a calendar event author\'s current username after a rename, falling back to the snapshot', async () => {
    await placeSign('alias-calendar-instance', 'isCommunityCalendar');
    const posted = await api('/instances/alias-calendar-instance/events', owner.session({
      method: 'POST', body: JSON.stringify({ text: 'Market day' }),
    }));
    expect(posted.response.status).toBe(201);
    expect(posted.body.event.authorLabel).toBe('alias-owner');

    const renamed = await api(`/builders/${owner.builderId}`, owner.session({
      method: 'PATCH', body: JSON.stringify({ label: 'alias-owner-renamed' }),
    }));
    expect(renamed.response.status).toBe(200);

    const list = await api('/instances/alias-calendar-instance/events');
    expect(list.body.events).toHaveLength(1);
    expect(list.body.events[0].authorLabel).toBe('alias-owner-renamed');

    await env.DB.prepare('UPDATE calendar_events SET user_id = NULL WHERE instance_id = ?')
      .bind('alias-calendar-instance').run();
    const orphaned = await api('/instances/alias-calendar-instance/events');
    expect(orphaned.body.events[0].authorLabel).toBe('alias-owner');
  });
});
