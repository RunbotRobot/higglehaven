import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, signupBuilder, signupAdmin } from './test-helpers.js';

// #1756 (*No silent loss*): removing a landlet level sweeps its instances into
// a saved layout, but a community sign's posts and a community calendar's
// events cascade-delete with the instance. They are now snapshotted with the
// layout and put back when it is pasted.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  adminSession = (await signupAdmin('saved-layout-content-admin')).session;
});

const LEVEL_HEIGHT_M = 10;

async function builderWithLandlet(label, landletId) {
  const builder = await signupBuilder(label);
  await api('/landlets', adminSession({
    method: 'POST',
    body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2: 1000, status: 'greenbelt' }),
  }));
  await api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  await env.DB.prepare('INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)')
    .bind(`headroom-${crypto.randomUUID()}`, builder.builderId, 100000000).run();
  await api('/builders');
  return builder;
}

async function sweptSignAndCalendar(label, landletId) {
  const owner = await builderWithLandlet(label, landletId);
  await api(`/landlets/${landletId}/levels`, owner.session({ method: 'POST', body: JSON.stringify({ direction: 'up' }) }));
  const placed = await api('/instances', owner.session({
    method: 'POST',
    body: JSON.stringify({
      instanceId: `${landletId}-board`, landletId, templateId: 'placeholder-tree',
      x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5, isCommunitySign: true, isCommunityCalendar: true,
    }),
  }));
  expect(placed.response.status).toBe(201);
  const instanceId = `${landletId}-board`;
  for (const [i, text] of ['first post', 'second post'].entries()) {
    await env.DB.prepare('INSERT INTO sign_posts (post_id, instance_id, author_label, text, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(`post-${landletId}-${i}`, instanceId, `Poster ${i}`, text, `2026-11-0${i + 1}T10:00:00.000Z`).run();
  }
  await env.DB.prepare('INSERT INTO calendar_events (event_id, instance_id, author_label, text, scheduled_at, triggered_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`event-${landletId}`, instanceId, 'Host', 'market day', '2027-01-01T09:00:00.000Z', null).run();
  const removed = await api(`/landlets/${landletId}/levels/1`, owner.session({ method: 'DELETE' }));
  const { results } = await env.DB.prepare('SELECT saved_layout_id FROM saved_level_layouts WHERE builder_id = ?')
    .bind(owner.builderId).all();
  return { owner, removed, instanceId, savedLayoutId: results[0].saved_layout_id };
}

describe('Saved layouts keep sign posts and calendar events (#1756)', () => {
  it('snapshots the content on level removal, reports what was kept, and a paste restores it', async () => {
    const { owner, removed, instanceId, savedLayoutId } = await sweptSignAndCalendar('layout-content-owner', 'layout-content-landlet');
    expect(removed.response.status).toBe(200);
    expect(removed.body).toMatchObject({ savedSignPostCount: 2, savedCalendarEventCount: 1 });

    // The live rows went with the instance, as before.
    const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_posts WHERE instance_id = ?').bind(instanceId).first();
    expect(live.n).toBe(0);

    const layout = await api(`/saved-layouts/${savedLayoutId}`, owner.session());
    const saved = layout.body.savedLayout.instances[0];
    expect(saved.restoreContentFrom).toEqual({ savedLayoutId, sourceInstanceId: instanceId });

    // Paste exactly as the client does: spread the saved instance (ids dropped), land it on ground level.
    const { instanceId: _a, id: _b, ...payload } = saved;
    const pasted = await api('/instances/batch', owner.session({
      method: 'POST',
      body: JSON.stringify({ instances: [{ ...payload, z: 0, landletId: 'layout-content-landlet' }] }),
    }));
    expect(pasted.response.status).toBe(201);
    const newId = pasted.body.instances[0].instanceId;
    expect(newId).not.toBe(instanceId);

    const posts = await env.DB.prepare('SELECT author_label, text, created_at FROM sign_posts WHERE instance_id = ? ORDER BY created_at').bind(newId).all();
    expect(posts.results.map((p) => p.text)).toEqual(['first post', 'second post']);
    expect(posts.results[0]).toMatchObject({ author_label: 'Poster 0', created_at: '2026-11-01T10:00:00.000Z' });
    const events = await env.DB.prepare('SELECT text, scheduled_at, triggered_at FROM calendar_events WHERE instance_id = ?').bind(newId).all();
    expect(events.results).toEqual([{ text: 'market day', scheduled_at: '2027-01-01T09:00:00.000Z', triggered_at: null }]);

    // The saved layout is reusable: a second paste restores into the second instance too.
    const again = await api('/instances/batch', owner.session({
      method: 'POST',
      body: JSON.stringify({ instances: [{ ...payload, z: 0, x: 3, landletId: 'layout-content-landlet' }] }),
    }));
    const secondId = again.body.instances[0].instanceId;
    const secondPosts = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_posts WHERE instance_id = ?').bind(secondId).first();
    expect(secondPosts.n).toBe(2);
  });

  it("never restores another builder's saved content, nor onto an instance that is not a sign", async () => {
    const { owner, instanceId, savedLayoutId } = await sweptSignAndCalendar('layout-content-victim', 'layout-content-victim-landlet');
    const stranger = await builderWithLandlet('layout-content-stranger', 'layout-content-stranger-landlet');
    const from = { savedLayoutId, sourceInstanceId: instanceId };

    const stolen = await api('/instances/batch', stranger.session({
      method: 'POST',
      body: JSON.stringify({ instances: [{
        landletId: 'layout-content-stranger-landlet', templateId: 'placeholder-tree', x: 1, y: 1, z: 0,
        isCommunitySign: true, isCommunityCalendar: true, restoreContentFrom: from,
      }] }),
    }));
    expect(stolen.response.status).toBe(201);
    const strangerId = stolen.body.instances[0].instanceId;
    const taken = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM sign_posts WHERE instance_id = ?) + (SELECT COUNT(*) FROM calendar_events WHERE instance_id = ?) AS n')
      .bind(strangerId, strangerId).first();
    expect(taken.n).toBe(0);

    const plain = await api('/instances/batch', owner.session({
      method: 'POST',
      body: JSON.stringify({ instances: [{
        landletId: 'layout-content-victim-landlet', templateId: 'placeholder-tree', x: 5, y: 5, z: 0, restoreContentFrom: from,
      }] }),
    }));
    expect(plain.response.status).toBe(201);
    const plainId = plain.body.instances[0].instanceId;
    const none = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_posts WHERE instance_id = ?').bind(plainId).first();
    expect(none.n).toBe(0);
  });

  it('removing a level with no sign or calendar content reports zero kept', async () => {
    const owner = await builderWithLandlet('layout-content-plain', 'layout-content-plain-landlet');
    await api('/landlets/layout-content-plain-landlet/levels', owner.session({ method: 'POST', body: JSON.stringify({ direction: 'up' }) }));
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({ instanceId: 'plain-upper', landletId: 'layout-content-plain-landlet', templateId: 'placeholder-tree', x: 1, y: 1, z: LEVEL_HEIGHT_M * 1.5 }),
    }));
    const removed = await api('/landlets/layout-content-plain-landlet/levels/1', owner.session({ method: 'DELETE' }));
    expect(removed.body).toMatchObject({ deleted: true, savedSignPostCount: 0, savedCalendarEventCount: 0 });
  });
});
