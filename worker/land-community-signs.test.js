import {
  applyD1Migrations, env, SELF,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import { DEFAULT_EARTH_RADIUS_M, footprintScaleAtHeight } from './earthCurvature.js';
import {
  api, extractSessionCookie, withSession, signup, signupBuilder, signupSeller, glbFile, signupAdmin,
  createGreenbeltLandletAs,
} from './test-helpers.js';

// Shared across every test that needs to act as an admin (world/land-
// candidate tooling — see requireAdmin in worker/index.js) — one admin
// account for the whole file rather than a fresh one per test, since
// admin status carries no per-test state of its own to isolate.
let adminSession;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const admin = await signupAdmin('shared-admin');
  adminSession = admin.session;
});

function createGreenbeltLandlet(landletId) {
  return createGreenbeltLandletAs(adminSession, landletId);
}


describe('Community signs', () => {
  // A single claimed landlet, shared by every test below, to host the
  // instances they place — placing/toggling/deleting an instance now
  // requires session-authenticated ownership of the landlet it sits on
  // (see requireOwnedLandlet's own comment), so every mutation here goes
  // through this landlet's owning builder's session.
  //
  // #1830: posting (and now editing) a sign post requires a session too --
  // signsShopper is a deliberately SEPARATE account from signsBuilder (the
  // landlet's own owner) for exactly that reason: using the same account
  // for both would silently exercise the post's own author-delete path
  // wherever a test means to exercise the landlet owner's moderation path
  // instead (or vice versa), since #1830 made those two different people
  // in the common case.
  let signsLandlet;
  let signsBuilder;
  let signsShopper;

  beforeAll(async () => {
    signsBuilder = await signupBuilder('community-signs-builder');
    signsShopper = await signupBuilder('community-signs-shopper');
    await createGreenbeltLandlet('community-signs-landlet');
    const claimed = await api('/landlets/community-signs-landlet/claim', signsBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);
    signsLandlet = 'community-signs-landlet';
  });

  it('toggles isCommunitySign on a placed instance and round-trips it', async () => {
    const created = await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-toggle-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
      }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.instance.isCommunitySign).toBe(false);

    const toggled = await api('/instances/sign-toggle-instance', signsBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: true }),
    }));
    expect(toggled.response.status).toBe(200);
    expect(toggled.body.instance.isCommunitySign).toBe(true);

    const fetched = await api('/instances/sign-toggle-instance');
    expect(fetched.body.instance.isCommunitySign).toBe(true);
  });

  // #1022: un-flagging used to only ever write placed_instances' own
  // is_community_sign column -- the sign's sign_posts rows were never
  // touched, so they sat around unreferenced by any live flag check and
  // silently reappeared (both via GET and rendered client-side) the moment
  // the same instance was re-flagged as a sign later.
  it('clears old sign posts when unflagged, so a later reflag does not resurrect them', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-unflag-reflag-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 3,
        y: 3,
        isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-unflag-reflag-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'First post' }),
    }));
    expect(posted.response.status).toBe(201);

    const unflagged = await api('/instances/sign-unflag-reflag-instance', signsBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: false }),
    }));
    expect(unflagged.response.status).toBe(200);
    expect(unflagged.body.instance.isCommunitySign).toBe(false);

    const reflagged = await api('/instances/sign-unflag-reflag-instance', signsBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ isCommunitySign: true }),
    }));
    expect(reflagged.response.status).toBe(200);
    expect(reflagged.body.instance.isCommunitySign).toBe(true);

    const list = await api('/instances/sign-unflag-reflag-instance/posts');
    expect(list.body.posts).toHaveLength(0);
  });

  // #1675: same #1022 cleanup as the single-instance test just above, but
  // for PUT /instances/batch -- src/api.js's upsertInstancesRemote uses
  // this endpoint for a multi-item group move or an undo/redo snapshot
  // restore, and that sibling path never got the sign_posts/calendar_events
  // cleanup the single-instance PATCH handler has had since #1022.
  it('clears old sign posts when unflagged via a batch update, so a later reflag does not resurrect them', async () => {
    await api('/instances/batch', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{
          instanceId: 'sign-batch-unflag-reflag-instance',
          landletId: signsLandlet,
          templateId: 'placeholder-tree',
          x: 4,
          y: 4,
          isCommunitySign: true,
        }],
      }),
    }));
    const posted = await api('/instances/sign-batch-unflag-reflag-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'Batch-path post' }),
    }));
    expect(posted.response.status).toBe(201);

    const unflagged = await api('/instances/batch', signsBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'sign-batch-unflag-reflag-instance',
          landletId: signsLandlet,
          templateId: 'placeholder-tree',
          x: 4,
          y: 4,
          isCommunitySign: false,
        }],
      }),
    }));
    expect(unflagged.response.status).toBe(200);
    expect(unflagged.body.instances[0].isCommunitySign).toBe(false);

    const reflagged = await api('/instances/batch', signsBuilder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'sign-batch-unflag-reflag-instance',
          landletId: signsLandlet,
          templateId: 'placeholder-tree',
          x: 4,
          y: 4,
          isCommunitySign: true,
        }],
      }),
    }));
    expect(reflagged.response.status).toBe(200);
    expect(reflagged.body.instances[0].isCommunitySign).toBe(true);

    const list = await api('/instances/sign-batch-unflag-reflag-instance/posts');
    expect(list.body.posts).toHaveLength(0);
  });

  // #1695: same #1022/#1675 cleanup, the third sibling sharing this same
  // upsert's own is_community_sign flip -- PUT /landlets/:id/draft (Build
  // mode's whole-draft save, resending every instance on the landlet) never
  // got it either. A dedicated builder+landlet, not signsBuilder/signsLandlet
  // above, for two reasons: a builder can only ever own one claimed landlet
  // at a time (claimLandlet would 409 "already owns a claimed landlet" for
  // signsBuilder, who already owns signsLandlet), and this endpoint
  // atomically *replaces* a landlet's entire draft, so resending just one
  // instance against the shared landlet would wipe out every other test's
  // own instances placed on it.
  it('clears old sign posts when unflagged via a landlet draft save, so a later reflag does not resurrect them', async () => {
    const draftBuilder = await signupBuilder('sign-draft-unflag-reflag-builder');
    const draftLandlet = 'sign-draft-unflag-reflag-landlet';
    await createGreenbeltLandlet(draftLandlet);
    const claimed = await api(`/landlets/${draftLandlet}/claim`, draftBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const draftInstance = {
      instanceId: 'sign-draft-unflag-reflag-instance',
      landletId: draftLandlet,
      templateId: 'placeholder-tree',
      x: 5,
      y: 5,
      isCommunitySign: true,
    };
    const createdDraft = await api(`/landlets/${draftLandlet}/draft`, draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [draftInstance] }),
    }));
    expect(createdDraft.response.status).toBe(200);
    const posted = await api('/instances/sign-draft-unflag-reflag-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'Draft-path post' }),
    }));
    expect(posted.response.status).toBe(201);

    const unflagged = await api(`/landlets/${draftLandlet}/draft`, draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [{ ...draftInstance, isCommunitySign: false }] }),
    }));
    expect(unflagged.response.status).toBe(200);
    expect(unflagged.body.instances[0].isCommunitySign).toBe(false);

    const reflagged = await api(`/landlets/${draftLandlet}/draft`, draftBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances: [{ ...draftInstance, isCommunitySign: true }] }),
    }));
    expect(reflagged.response.status).toBe(200);
    expect(reflagged.body.instances[0].isCommunitySign).toBe(true);

    const list = await api('/instances/sign-draft-unflag-reflag-instance/posts');
    expect(list.body.posts).toHaveLength(0);
  });

  // #1726: a dropped-response retry of this endpoint's own auto-version
  // side effect used to mint a second, fully duplicate version snapshot
  // one number higher than the first -- the same gap #1721 covers for the
  // sibling POST /landlets/:id/versions endpoint, but for this one's own
  // version_id (minted fresh via crypto.randomUUID() every call).
  it('does not create a duplicate version when the same draft save is retried with the same idempotency key', async () => {
    const draftBuilder = await signupBuilder('draft-version-idempotency-builder');
    const draftLandlet = 'draft-version-idempotency-landlet';
    await createGreenbeltLandlet(draftLandlet);
    const claimed = await api(`/landlets/${draftLandlet}/claim`, draftBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const body = JSON.stringify({
      instances: [{
        instanceId: 'draft-version-idempotency-instance',
        landletId: draftLandlet,
        templateId: 'placeholder-tree',
        x: 5,
        y: 5,
      }],
      idempotencyKey: 'retry-attempt-1',
    });
    const first = await api(`/landlets/${draftLandlet}/draft`, draftBuilder.session({ method: 'PUT', body }));
    expect(first.response.status).toBe(200);
    const retry = await api(`/landlets/${draftLandlet}/draft`, draftBuilder.session({ method: 'PUT', body }));
    expect(retry.response.status).toBe(200);
    // Same version both times -- a genuinely new save (no key, or a
    // different one) still gets its own version, this only collapses a
    // byte-for-byte retry.
    expect(retry.body.version.versionId).toBe(first.body.version.versionId);
    expect(retry.body.version.versionNumber).toBe(first.body.version.versionNumber);

    const versions = await api(`/landlets/${draftLandlet}/versions`, draftBuilder.session({}));
    expect(versions.body.versions).toHaveLength(1);
  });

  // #2184: same "a client-supplied idempotency key reused for genuinely
  // different content must not fabricate a stale success" fix already
  // applied to the sibling POST /landlets/:id/versions endpoint (#1874) --
  // this endpoint's own auto-version side effect never got it, so a retry
  // with the same idempotencyKey but a genuinely different versionName
  // used to silently no-op on the version INSERT, leaving the stale first
  // version's name/metadata both returned and permanently stored.
  it('creates a genuinely new version, not a silent dupe of the stale one, when the same idempotencyKey is reused for different content', async () => {
    const mismatchBuilder = await signupBuilder('draft-version-mismatch-builder');
    const mismatchLandlet = 'draft-version-mismatch-landlet';
    await createGreenbeltLandlet(mismatchLandlet);
    const claimed = await api(`/landlets/${mismatchLandlet}/claim`, mismatchBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const instances = [{
      instanceId: 'draft-version-mismatch-instance',
      landletId: mismatchLandlet,
      templateId: 'placeholder-tree',
      x: 5,
      y: 5,
    }];
    const first = await api(`/landlets/${mismatchLandlet}/draft`, mismatchBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances, versionName: 'First save', idempotencyKey: 'mismatch-attempt-1' }),
    }));
    expect(first.response.status).toBe(200);

    // Same cached key, but a genuinely different versionName -- the stale
    // key must not cause this to be silently swallowed as the first save.
    const second = await api(`/landlets/${mismatchLandlet}/draft`, mismatchBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances, versionName: 'Actually, a different save', idempotencyKey: 'mismatch-attempt-1' }),
    }));
    expect(second.response.status).toBe(200);
    expect(second.body.version.versionId).not.toBe(first.body.version.versionId);
    expect(second.body.version.name).toBe('Actually, a different save');

    const versions = await api(`/landlets/${mismatchLandlet}/versions`, mismatchBuilder.session({}));
    expect(versions.body.versions).toHaveLength(2);
  });

  // #2216: this endpoint's own cap is 250 instances per save, but the
  // getInstancesById call it makes to look up each instance's prior state
  // used to bind the full id list in one unchunked IN (...) query. D1 caps
  // a single statement at 100 bound parameters, so any save past ~100
  // instances -- an ordinary "save my whole build" request on this
  // endpoint, not an edge case -- threw a raw D1 "too many SQL variables"
  // error instead of succeeding. 150 is comfortably past that threshold
  // but still within the endpoint's own 250 cap.
  it('accepts a draft save with more instances than D1 allows bound parameters for in one query', async () => {
    const bulkBuilder = await signupBuilder('draft-bulk-instances-builder');
    const bulkLandlet = 'draft-bulk-instances-landlet';
    await createGreenbeltLandlet(bulkLandlet);
    const claimed = await api(`/landlets/${bulkLandlet}/claim`, bulkBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const instances = Array.from({ length: 150 }, (_, i) => ({
      instanceId: `draft-bulk-instance-${i}`,
      landletId: bulkLandlet,
      templateId: 'placeholder-tree',
      x: (i % 13) - 6,
      y: Math.floor(i / 13) - 6,
    }));
    const saved = await api(`/landlets/${bulkLandlet}/draft`, bulkBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances }),
    }));
    expect(saved.response.status).toBe(200);
    expect(saved.body.instances).toHaveLength(150);

    // A second save resending the same 150 instances exercises
    // getInstancesById's chunked lookup finding every one of them as
    // "already existing" (not just the empty-Map first-save path above),
    // same shape as the real "edit an already-large build" case.
    const resaved = await api(`/landlets/${bulkLandlet}/draft`, bulkBuilder.session({
      method: 'PUT',
      body: JSON.stringify({ instances }),
    }));
    expect(resaved.response.status).toBe(200);
    expect(resaved.body.instances).toHaveLength(150);
  });

  // #971: validateInstance's own `label` field used plain `input.label ||
  // null` -- no length cap and no type check at all, unlike every other
  // optional label-shaped field in this file (optionalLabelValue).
  it('rejects an over-length instance label', async () => {
    const rejected = await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'label-cap-instance', landletId: signsLandlet, templateId: 'placeholder-tree',
        x: 2, y: 2, label: 'x'.repeat(101),
      }),
    }));
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/label must be 100 characters or fewer/);
  });

  // Same gap, the other failure mode: a non-string label used to sail
  // through unchanged and reach a D1 .bind() call with a type D1 rejects,
  // producing an uncaught 500 instead of the clean 400 every other
  // malformed field on this endpoint gets.
  it('rejects a non-string instance label on PATCH', async () => {
    const created = await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'label-type-instance', landletId: signsLandlet, templateId: 'placeholder-tree', x: 3, y: 3,
      }),
    }));
    expect(created.response.status).toBe(201);

    const patched = await api('/instances/label-type-instance', signsBuilder.session({
      method: 'PATCH',
      body: JSON.stringify({ label: { not: 'a string' } }),
    }));
    expect(patched.response.status).toBe(400);
    expect(patched.body.error).toMatch(/label is required/);
  });

  it('rejects a post on an instance not marked as a community sign', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'not-a-sign-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 2,
        y: 2,
      }),
    }));

    // #1830: no session here either -- the instance/flag check still runs
    // (and still 400s) before the now-required auth check, same ordering
    // as handleCalendarEvents' own structurally identical POST branch.
    const rejected = await api('/instances/not-a-sign-instance/posts', {
      method: 'POST',
      body: JSON.stringify({ text: 'Hello!' }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community sign/);
  });

  // #1327: the is_community_sign check above is a point-in-time read --
  // without folding it into the INSERT itself, a PATCH unflagging this
  // instance (whose own #1022 cleanup clears sign_posts specifically so a
  // post can't resurface on reflagging) landing in the gap before the
  // INSERT would still let this post land anyway. Injected at the INSERT
  // itself (the only db.prepare call between the flag check and the write
  // in this handler -- readJson has no DB call of its own to key off).
  it('rejects a post if the instance was unflagged between the initial check and the insert', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-post-flag-race-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 6,
        y: 6,
        isCommunitySign: true,
      }),
    }));

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO sign_posts')) {
        armed = false;
        originalPrepare('UPDATE placed_instances SET is_community_sign = 0 WHERE instance_id = ?')
          .bind('sign-post-flag-race-instance').run();
      }
      return originalPrepare(sql);
    };
    let rejected;
    try {
      rejected = await api('/instances/sign-post-flag-race-instance/posts', signsShopper.session({
        method: 'POST',
        body: JSON.stringify({ text: 'Too late' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/not marked as a community sign/);

    const stored = await env.DB.prepare('SELECT COUNT(*) AS count FROM sign_posts WHERE instance_id = ?')
      .bind('sign-post-flag-race-instance').first();
    expect(stored.count).toBe(0);
  });

  it('creates, lists, and moderates posts on a community sign', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-with-posts',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 3,
        y: 3,
        isCommunitySign: true,
      }),
    }));

    const emptyList = await api('/instances/sign-with-posts/posts');
    expect(emptyList.response.status).toBe(200);
    expect(emptyList.body.posts).toEqual([]);

    // #1830: posting now requires a real, verified session.
    const unauthenticatedPost = await api('/instances/sign-with-posts/posts', {
      method: 'POST',
      body: JSON.stringify({ text: 'Hello!' }),
    });
    expect(unauthenticatedPost.response.status).toBe(401);

    const missingText = await api('/instances/sign-with-posts/posts', signsShopper.session({
      method: 'POST',
      body: JSON.stringify({}),
    }));
    expect(missingText.response.status).toBe(400);

    const tooLong = await api('/instances/sign-with-posts/posts', signsShopper.session({
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(281) }),
    }));
    expect(tooLong.response.status).toBe(400);

    // #1830: authorLabel is no longer client-supplied at all -- always the
    // posting user's own username, derived server-side.
    const posted = await api('/instances/sign-with-posts/posts', signsShopper.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Great little shop!' }),
    }));
    expect(posted.response.status).toBe(201);
    expect(posted.body.post).toMatchObject({
      instanceId: 'sign-with-posts',
      authorLabel: signsShopper.builder.label,
      text: 'Great little shop!',
    });
    expect(posted.body.post.postId).toMatch(/^post-/);

    const listed = await api('/instances/sign-with-posts/posts');
    expect(listed.body.posts).toHaveLength(1);
    expect(listed.body.posts[0].postId).toBe(posted.body.post.postId);

    // Moderation (DELETE) is gated to the sign's hosting landlet's owner.
    const unauthenticatedDelete = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, { method: 'DELETE' });
    expect(unauthenticatedDelete.response.status).toBe(401);

    const deleted = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, signsBuilder.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listedAfterDelete = await api('/instances/sign-with-posts/posts');
    expect(listedAfterDelete.body.posts).toEqual([]);

    const deleteMissing = await api(`/instances/sign-with-posts/posts/${posted.body.post.postId}`, signsBuilder.session({ method: 'DELETE' }));
    expect(deleteMissing.response.status).toBe(404);
  });

  // #1830: a post's own author can now remove it directly -- a shopper who
  // doesn't own (or even build on) the sign's hosting landlet at all.
  it('lets a post\'s own author delete it directly, without owning the hosting landlet', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-author-delete-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 2, y: 6, isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-author-delete-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'My own note' }),
    }));
    expect(posted.response.status).toBe(201);

    const deleted = await api(`/instances/sign-author-delete-instance/posts/${posted.body.post.postId}`, signsShopper.session({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listed = await api('/instances/sign-author-delete-instance/posts');
    expect(listed.body.posts).toEqual([]);
  });

  // #781: an admin can remove any sign post outright, regardless of who
  // posted it or who owns the hosting landlet -- same reasoning and shape
  // as #1712's product-review admin override.
  it('lets an admin delete any sign post outright, even when neither the author nor the hosting landlet owner is involved', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-admin-override-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 5, y: 7, isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-admin-override-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'Abusive/policy-violating text goes here.' }),
    }));
    expect(posted.response.status).toBe(201);
    const postId = posted.body.post.postId;

    const deleted = await api(`/instances/sign-admin-override-instance/posts/${postId}`, adminSession({ method: 'DELETE' }));
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    const listed = await api('/instances/sign-admin-override-instance/posts');
    expect(listed.body.posts).toEqual([]);

    const adminUserId = (await api('/auth/me', adminSession())).body.user.userId;
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('delete_sign_post_override', postId).first();
    expect(logRow).not.toBeNull();
    expect(logRow.admin_user_id).toBe(adminUserId);
    expect(logRow.target_type).toBe('sign_post');
  });

  // #1830: the new PATCH branch -- author-only, no moderation equivalent.
  it('lets a post\'s own author edit it, and rejects anyone else', async () => {
    const otherAccount = await signupBuilder('sign-edit-other-account');
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-author-edit-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 3, y: 6, isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-author-edit-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'Original text' }),
    }));
    expect(posted.response.status).toBe(201);
    const postId = posted.body.post.postId;

    const unauthenticatedEdit = await api(`/instances/sign-author-edit-instance/posts/${postId}`, {
      method: 'PATCH', body: JSON.stringify({ text: 'Sneaky edit' }),
    });
    expect(unauthenticatedEdit.response.status).toBe(401);

    // Neither the sign's hosting landlet's own owner (signsBuilder) nor an
    // unrelated third account (otherAccount) is the post's author -- PATCH
    // has no moderation equivalent the way DELETE does, so both are
    // rejected the same way.
    const ownerEdit = await api(`/instances/sign-author-edit-instance/posts/${postId}`, signsBuilder.session({
      method: 'PATCH', body: JSON.stringify({ text: 'Moderator edit' }),
    }));
    expect(ownerEdit.response.status).toBe(403);

    const otherEdit = await api(`/instances/sign-author-edit-instance/posts/${postId}`, otherAccount.session({
      method: 'PATCH', body: JSON.stringify({ text: 'Stranger edit' }),
    }));
    expect(otherEdit.response.status).toBe(403);

    const tooLongEdit = await api(`/instances/sign-author-edit-instance/posts/${postId}`, signsShopper.session({
      method: 'PATCH', body: JSON.stringify({ text: 'x'.repeat(281) }),
    }));
    expect(tooLongEdit.response.status).toBe(400);

    const edited = await api(`/instances/sign-author-edit-instance/posts/${postId}`, signsShopper.session({
      method: 'PATCH', body: JSON.stringify({ text: 'Edited text' }),
    }));
    expect(edited.response.status).toBe(200);
    expect(edited.body.post).toMatchObject({ postId, text: 'Edited text', authorLabel: signsShopper.builder.label });

    const listed = await api('/instances/sign-author-edit-instance/posts');
    expect(listed.body.posts[0].text).toBe('Edited text');

    const editMissing = await api(`/instances/sign-author-edit-instance/posts/${crypto.randomUUID()}`, signsShopper.session({
      method: 'PATCH', body: JSON.stringify({ text: 'Edited text' }),
    }));
    expect(editMissing.response.status).toBe(404);
  });

  // #2354: never crashes with a raw 500 when the author's own PATCH loses
  // a race to a concurrent admin-override DELETE (#781) on the same post --
  // same shape as the friendship accept-vs-decline race elsewhere in this
  // suite, fired together rather than awaited one at a time.
  it('never crashes with a raw 500 when a PATCH loses a race to a concurrent admin delete', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-patch-delete-race-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 4, y: 6, isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-patch-delete-race-instance/posts', signsShopper.session({
      method: 'POST', body: JSON.stringify({ text: 'Original text' }),
    }));
    const postId = posted.body.post.postId;

    const [patchResult] = await Promise.all([
      api(`/instances/sign-patch-delete-race-instance/posts/${postId}`, signsShopper.session({
        method: 'PATCH', body: JSON.stringify({ text: 'Raced edit' }),
      })),
      api(`/instances/sign-patch-delete-race-instance/posts/${postId}`, adminSession({ method: 'DELETE' })),
    ]);

    // The real bug was an uncaught TypeError surfacing as a raw 500 from
    // inside this exact call when the admin delete won the race.
    expect([200, 404, 409]).toContain(patchResult.response.status);
  });

  // #2429: same re-SELECT race #2354 fixed above for this handler's own
  // PATCH, never applied to this POST/create branch -- a concurrent admin
  // delete landing between the guarded INSERT committing and this
  // handler's own re-SELECT running used to crash with a raw 500 instead
  // of a clean 404. Wraps the INSERT statement's own run() (rather than
  // racing prepare() itself) so the DELETE only ever fires once the
  // INSERT has genuinely already landed.
  it('never crashes with a raw 500 when its own POST re-fetch loses a race to a concurrent delete', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-post-refetch-delete-race-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 4, y: 7, isCommunitySign: true,
      }),
    }));

    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('INSERT INTO sign_posts')) {
        const originalBind = stmt.bind.bind(stmt);
        stmt.bind = (...args) => {
          const bound = originalBind(...args);
          const originalRun = bound.run.bind(bound);
          bound.run = async () => {
            const result = await originalRun();
            await originalPrepare('DELETE FROM sign_posts WHERE instance_id = ?')
              .bind('sign-post-refetch-delete-race-instance').run();
            return result;
          };
          return bound;
        };
      }
      return stmt;
    };
    let posted;
    try {
      posted = await api('/instances/sign-post-refetch-delete-race-instance/posts', signsShopper.session({
        method: 'POST', body: JSON.stringify({ text: 'Raced out from under me.' }),
      }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    // The real bug was an uncaught TypeError (raw 500) when the re-SELECT
    // after an already-successful INSERT found the row already gone.
    expect(posted.response.status).toBe(404);
  });

  // #944-shaped gap, found the same way for the new PATCH branch -- no
  // rate limit at all would let an authenticated author rewrite their own
  // post in an unthrottled loop.
  it('rate-limits repeated edits from the same account', async () => {
    const editRateLimitPoster = await signupBuilder('sign-edit-rate-limit-poster');
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-edit-rate-limit-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 4, y: 6, isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-edit-rate-limit-instance/posts', editRateLimitPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'Original text' }),
    }));
    const postId = posted.body.post.postId;

    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/instances/sign-edit-rate-limit-instance/posts/${postId}`, editRateLimitPoster.session({
        method: 'PATCH', body: JSON.stringify({ text: `Edit ${i}` }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api(`/instances/sign-edit-rate-limit-instance/posts/${postId}`, editRateLimitPoster.session({
      method: 'PATCH', body: JSON.stringify({ text: 'One too many' }),
    }));
    expect(limited.response.status).toBe(429);
  });

  it('cascades post deletion when the sign instance itself is deleted', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-to-delete',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 4,
        y: 4,
        isCommunitySign: true,
      }),
    }));
    await api('/instances/sign-to-delete/posts', signsShopper.session({
      method: 'POST',
      body: JSON.stringify({ text: 'Nice place' }),
    }));
    await api('/instances/sign-to-delete', signsBuilder.session({ method: 'DELETE' }));

    const afterDelete = await api('/instances/sign-to-delete/posts');
    expect(afterDelete.response.status).toBe(404);
  });

  // Found via backlog audit (#337): unlike every other public, repeatable
  // mutation in this file, posting to a community sign requires no
  // session and had no rate limit at all.
  // #1830: posting now requires a session, so the bucket key moved from
  // clientIp to the poster's own user_id -- a dedicated account, not
  // signsShopper, so this test's own bucket can't collide with the much
  // smaller number of posts every other sign-post test above makes.
  it('rate-limits repeated posts from the same account', async () => {
    const rateLimitPoster = await signupBuilder('sign-post-rate-limit-poster');
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-rate-limit-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 5,
        y: 5,
        isCommunitySign: true,
      }),
    }));

    for (let i = 0; i < 20; i++) {
      const attempt = await api('/instances/sign-rate-limit-instance/posts', rateLimitPoster.session({
        method: 'POST', body: JSON.stringify({ text: `Post ${i}` }),
      }));
      expect(attempt.response.status).not.toBe(429);
    }
    const limited = await api('/instances/sign-rate-limit-instance/posts', rateLimitPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'One too many' }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // #960: same #415/#929 "auction transfer in the await gap" race already
  // closed for placed_instances' own DELETE -- a stale sign-post-moderation
  // DELETE from a builder who just lost the landlet in auction must not
  // still succeed. Same injection point (checkRateLimit's own INSERT) as
  // the #958/#959 landlet-level tests, since that's the earliest awaited
  // step after requireOwnedLandlet in this handler too.
  it('does not delete a sign post on a landlet that was transferred to a new owner mid-request', async () => {
    const owner = await signupBuilder('sign-delete-ownership-race-owner');
    const newOwner = await signupBuilder('sign-delete-ownership-race-new-owner');
    // #1830: a poster distinct from both owner/newOwner -- this test means
    // to exercise the DELETE branch's moderation path specifically (the
    // landlet owner removing someone else's post), which only fires when
    // the deleter isn't also the post's own author.
    const poster = await signupBuilder('sign-delete-ownership-race-poster');
    await createGreenbeltLandlet('sign-delete-ownership-race-landlet');
    await api('/landlets/sign-delete-ownership-race-landlet/claim', owner.session({ method: 'POST' }));
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-delete-ownership-race-instance',
        landletId: 'sign-delete-ownership-race-landlet',
        templateId: 'placeholder-tree',
        x: 1, y: 1, isCommunitySign: true,
      }),
    }));
    const posted = await api('/instances/sign-delete-ownership-race-instance/posts', poster.session({
      method: 'POST', body: JSON.stringify({ text: 'Hello!' }),
    }));
    const postId = posted.body.post.postId;

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let armed = true;
    env.DB.prepare = (sql) => {
      if (armed && sql.includes('INSERT INTO rate_limit_events')) {
        armed = false;
        originalPrepare('UPDATE landlets SET owner_builder_id = ? WHERE landlet_id = ?')
          .bind(newOwner.builderId, 'sign-delete-ownership-race-landlet').run();
      }
      return originalPrepare(sql);
    };
    let deleted;
    try {
      deleted = await api(`/instances/sign-delete-ownership-race-instance/posts/${postId}`, owner.session({ method: 'DELETE' }));
    } finally {
      env.DB.prepare = originalPrepare;
    }
    expect(deleted.response.status).toBe(409);

    const stillThere = await env.DB.prepare('SELECT 1 FROM sign_posts WHERE post_id = ?').bind(postId).first();
    expect(stillThere).not.toBeNull();
  });

  // #944: unlike its own POST sibling above, the DELETE branch had no rate
  // limit at all -- an authenticated landlet owner could delete posts in an
  // unthrottled loop. Seeds 21 posts directly via the DB (rather than via
  // POST, which is itself rate-limited to 20) so this test can actually
  // exercise 21 deletes without also hitting the create-side limit. A
  // dedicated builder+landlet, not signsBuilder/signsLandlet, so this
  // test's own bucket doesn't collide with the other sign-post DELETE calls
  // already made by signsBuilder above.
  it('rate-limits repeated post deletions from the same builder', async () => {
    const rateLimitBuilder = await signupBuilder('sign-delete-rate-limit-builder');
    await createGreenbeltLandlet('sign-delete-rate-limit-landlet');
    await api('/landlets/sign-delete-rate-limit-landlet/claim', rateLimitBuilder.session({ method: 'POST' }));
    await api('/instances', rateLimitBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-delete-rate-limit-instance',
        landletId: 'sign-delete-rate-limit-landlet',
        templateId: 'placeholder-tree',
        x: 6,
        y: 6,
        isCommunitySign: true,
      }),
    }));
    const postIds = Array.from({ length: 21 }, (_, i) => `sign-delete-rate-limit-post-${i}`);
    await env.DB.batch(postIds.map((postId) => env.DB.prepare(
      `INSERT INTO sign_posts (post_id, instance_id, author_label, text) VALUES (?, ?, ?, ?)`,
    ).bind(postId, 'sign-delete-rate-limit-instance', 'A Shopper', 'Nice place')));

    for (let i = 0; i < 20; i++) {
      const attempt = await api(`/instances/sign-delete-rate-limit-instance/posts/${postIds[i]}`, rateLimitBuilder.session({ method: 'DELETE' }));
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api(`/instances/sign-delete-rate-limit-instance/posts/${postIds[20]}`, rateLimitBuilder.session({ method: 'DELETE' }));
    expect(limited.response.status).toBe(429);
  });

  // #1718: a retried POST (a dropped response, not a double-click) used to
  // create a second, fully duplicate sign_posts row for the same logical
  // post — same "lost response looks like it never reached the server"
  // idempotency-key protection as the calendar flow's own #1716 fix and the
  // purchase flow's original #473 fix.
  it('does not create a duplicate post when the same idempotencyKey is retried', async () => {
    const idempotencyPoster = await signupBuilder('sign-post-idempotency-poster');
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-post-idempotency-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 8,
        y: 8,
        isCommunitySign: true,
      }),
    }));

    const first = await api('/instances/sign-post-idempotency-instance/posts', idempotencyPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'Great sale today!', idempotencyKey: 'sign-retry-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    const retried = await api('/instances/sign-post-idempotency-instance/posts', idempotencyPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'Great sale today!', idempotencyKey: 'sign-retry-test-key' }),
    }));
    expect(retried.response.status).toBe(200);
    expect(retried.body.post.postId).toBe(first.body.post.postId);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_posts WHERE instance_id = ?')
      .bind('sign-post-idempotency-instance').first();
    expect(count.n).toBe(1);

    // A different idempotencyKey (or none at all) is a genuinely separate
    // post, still created normally — this isn't a dedup-everything guard,
    // only same-key retries.
    const separate = await api('/instances/sign-post-idempotency-instance/posts', idempotencyPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'A second, different post' }),
    }));
    expect(separate.response.status).toBe(201);
    expect(separate.body.post.postId).not.toBe(first.body.post.postId);
    const countAfterSeparate = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_posts WHERE instance_id = ?')
      .bind('sign-post-idempotency-instance').first();
    expect(countAfterSeparate.n).toBe(2);
  });

  // #1778: signPostIdempotencyKey caches one key per instanceId for a TTL,
  // not per attempt -- reusing a stale key for a genuinely different second
  // note (instead of a true retry of the same one) used to silently return
  // the FIRST post's content as if it were the new one, dropping the second
  // note entirely with no error.
  it('creates a genuinely new post, not a silent dupe of the stale one, when the same idempotencyKey is reused for different content', async () => {
    const mismatchPoster = await signupBuilder('sign-post-idempotency-mismatch-poster');
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-post-idempotency-mismatch-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 9,
        y: 9,
        isCommunitySign: true,
      }),
    }));

    const first = await api('/instances/sign-post-idempotency-mismatch-instance/posts', mismatchPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'Great sale today!', idempotencyKey: 'mismatch-test-key' }),
    }));
    expect(first.response.status).toBe(201);

    // Same cached key, but genuinely different text -- the stale key must
    // not cause this to be silently swallowed as the first post.
    const second = await api('/instances/sign-post-idempotency-mismatch-instance/posts', mismatchPoster.session({
      method: 'POST', body: JSON.stringify({ text: 'Actually, sale ends tonight!', idempotencyKey: 'mismatch-test-key' }),
    }));
    expect(second.response.status).toBe(201);
    expect(second.body.post.postId).not.toBe(first.body.post.postId);
    expect(second.body.post.text).toBe('Actually, sale ends tonight!');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM sign_posts WHERE instance_id = ?')
      .bind('sign-post-idempotency-mismatch-instance').first();
    expect(count.n).toBe(2);
  });

  // #827: unlike almost every other authenticated write in this file,
  // placed_instances creates/updates/deletes (single and batch alike) had no
  // checkRateLimit call at all. INSTANCE_WRITE_RATE_LIMIT_MAX is deliberately
  // much higher than this file's other rate-limit constants (dozens of
  // legitimate syncUpdate commits can happen in one active building session),
  // so pre-seeding rate_limit_events directly rather than looping hundreds of
  // real requests keeps this test fast — same approach as the
  // prune-sweep-stale-bucket test's own direct table access.
  it('rate-limits repeated instance writes from the same builder', async () => {
    const writeBuilder = await signupBuilder('instance-write-rate-limit-builder');
    await createGreenbeltLandlet('instance-write-rate-limit-landlet');
    const claimed = await api('/landlets/instance-write-rate-limit-landlet/claim', writeBuilder.session({ method: 'POST' }));
    expect(claimed.response.status).toBe(200);

    const bucketKey = `instance-write:${writeBuilder.builderId}`;
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 499 }, () => env.DB.prepare(
      'INSERT INTO rate_limit_events (bucket_key, created_at) VALUES (?, ?)',
    ).bind(bucketKey, now)));

    const atLimit = await api('/instances', writeBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'instance-write-rate-limit-instance',
        landletId: 'instance-write-rate-limit-landlet',
        templateId: 'placeholder-tree',
        x: 1,
        y: 1,
      }),
    }));
    expect(atLimit.response.status).toBe(201);

    const limited = await api('/instances', writeBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'instance-write-rate-limit-instance-2',
        landletId: 'instance-write-rate-limit-landlet',
        templateId: 'placeholder-tree',
        x: 2,
        y: 1,
      }),
    }));
    expect(limited.response.status).toBe(429);
  });

  // Found via backlog audit (#356): the list above was `ORDER BY created_at`
  // with no `DESC` — ascending, so once a sign passed 200 posts, `LIMIT 200`
  // always kept the *oldest* 200, permanently hiding every post made after
  // that point (the newest ones always fell outside the window). Explicit
  // created_at values, rather than relying on insertion order/timing, make
  // "which 200 survive" deterministic to assert on.
  it('reports the true post count and keeps the newest 200 (in ascending order) past the list\'s own cap', async () => {
    await api('/instances', signsBuilder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'sign-past-cap-instance',
        landletId: signsLandlet,
        templateId: 'placeholder-tree',
        x: 6,
        y: 6,
        isCommunitySign: true,
      }),
    }));
    const statements = Array.from({ length: 205 }, (_, i) =>
      env.DB.prepare(`
        INSERT INTO sign_posts (post_id, instance_id, author_label, text, created_at) VALUES (?, 'sign-past-cap-instance', 'A Shopper', ?, ?)
      `).bind(`sign-past-cap-${i}`, `Post ${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
    await env.DB.batch(statements);

    const list = await api('/instances/sign-past-cap-instance/posts');
    expect(list.body.posts).toHaveLength(200);
    expect(list.body.totalCount).toBe(205);
    // The surviving window is the newest 200 (post 5 through post 204), not
    // the oldest 200 (post 0 through post 199) the pre-#356 query kept —
    // and still returned oldest-first within that window, since
    // rebuildSignSprites (src/main.js) depends on that ordering to grab the
    // most recent posts via .slice(-SIGN_MAX_VISIBLE_POSTS).
    expect(list.body.posts[0].postId).toBe('sign-past-cap-5');
    expect(list.body.posts[199].postId).toBe('sign-past-cap-204');
  });
});
