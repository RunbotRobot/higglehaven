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


describe('Extensibility (crop floor)', () => {
  it('rejects a non-object metadata.extensible', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-not-an-object',
        name: 'Bad extensible shape',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: 'x' },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/metadata\.extensible must be an object/);
  });

  it('rejects an unrecognized axis key', async () => {
    const rejected = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-bad-axis',
        name: 'Bad extensible axis',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: { w: { minM: 1 } } },
      }),
    });
    expect(rejected.response.status).toBe(400);
    expect(rejected.body.error).toMatch(/metadata\.extensible key "w" must be one of/);
  });

  // The actual bug (#271): a bypassed-frontend request that sets a
  // non-numeric/missing/negative minM used to sail straight through with
  // no validation at all, defeating assertCropWithinTemplateBounds's crop
  // floor at read time (JS's numeric comparison makes `anything < NaN` and
  // `anything < undefined` both false).
  it('rejects a missing, non-numeric, NaN, zero, or negative metadata.extensible.x.minM', async () => {
    let n = 0;
    for (const minM of [undefined, 'not-a-number', NaN, 0, -1]) {
      n += 1;
      const rejected = await api('/catalog', {
        method: 'POST',
        body: JSON.stringify({
          templateId: `extensible-bad-minm-${n}`,
          name: 'Bad extensible minM',
          color: '#111111',
          dimensions: { width: 2, depth: 2, height: 2 },
          metadata: { extensible: { x: minM === undefined ? {} : { minM } } },
        }),
      });
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toMatch(/metadata\.extensible\.x\.minM must be a positive number/);
    }
  });

  it('rejects a minM at or above the template\'s own dimension for that axis', async () => {
    const atMax = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-minm-at-max',
        name: 'minM equals width',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: { x: { minM: 2 } } },
      }),
    });
    expect(atMax.response.status).toBe(400);
    expect(atMax.body.error).toMatch(/metadata\.extensible\.x\.minM must be less than this template's own width/);

    const overMax = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-minm-over-max',
        name: 'minM exceeds width',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 2 },
        metadata: { extensible: { x: { minM: 3 } } },
      }),
    });
    expect(overMax.response.status).toBe(400);
  });

  it('accepts a valid multi-axis metadata.extensible and round-trips it through GET and PATCH', async () => {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-valid-template',
        name: 'Extensible along x and y',
        color: '#111111',
        dimensions: { width: 4, depth: 3, height: 1 },
        metadata: { extensible: { x: { minM: 1 }, y: { minM: 0.5 } } },
      }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.template.metadata.extensible).toEqual({ x: { minM: 1 }, y: { minM: 0.5 } });

    const fetched = await api('/catalog/extensible-valid-template');
    expect(fetched.body.template.metadata.extensible).toEqual({ x: { minM: 1 }, y: { minM: 0.5 } });

    // Clearing it (an all-axes-unchecked save, per src/main.js's own "full
    // replace, not merge" contract) removes the key entirely, same as the
    // sibling flags above.
    const cleared = await api('/catalog/extensible-valid-template', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.template.metadata.extensible).toBeUndefined();
  });

  // #1734: notifyBuildersOfDimensionChange used to only compare
  // width/depth/height -- tightening metadata.extensible.x.minM (or
  // removing an axis's extensibility) through this same PATCH changes what's
  // actually safe for an already-placed, already-cropped instance just as
  // much as an outright dimension shrink does, but fired no notification at
  // all.
  it('notifies hosting builders when a PATCH tightens metadata.extensible without changing dimensions', async () => {
    const builder = await signupBuilder('extensible-notify-builder');
    await createGreenbeltLandlet('extensible-notify-landlet');
    await api('/landlets/extensible-notify-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'extensible-notify-template',
        name: 'Extensible notify template',
        color: '#111111',
        dimensions: { width: 4, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 1 } } },
      }),
    });
    await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'extensible-notify-instance',
        landletId: 'extensible-notify-landlet',
        templateId: 'extensible-notify-template',
        x: 1, y: 1,
      }),
    }));

    const tightened = await api('/catalog/extensible-notify-template', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { extensible: { x: { minM: 2 } } } }),
    });
    expect(tightened.response.status).toBe(200);

    const notices = await api('/notifications', builder.session());
    expect(notices.body.notifications).toHaveLength(1);
    expect(notices.body.notifications[0].message).toContain('had its placement rules changed by its seller');
    expect(notices.body.notifications[0].templateId).toBe('extensible-notify-template');

    // A PATCH that doesn't touch extensible/flooring at all (just the name)
    // is a genuinely unrelated change -- still no second notification.
    const unrelated = await api('/catalog/extensible-notify-template', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Extensible notify template (renamed)' }),
    });
    expect(unrelated.response.status).toBe(200);
    const noticesAfterUnrelated = await api('/notifications', builder.session());
    expect(noticesAfterUnrelated.body.notifications).toHaveLength(1);
  });

  // #1734: same gap, for metadata.flooring -- toggling it changes
  // meshDimensions' own live footprint for every existing placed copy
  // (src/main.js) without touching width/depth/height at all, so the
  // dimension-only "changed" check never fired for it either.
  it('notifies hosting builders when a PATCH toggles metadata.flooring', async () => {
    const builder = await signupBuilder('flooring-notify-builder');
    await createGreenbeltLandlet('flooring-notify-landlet');
    await api('/landlets/flooring-notify-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'flooring-notify-template',
        name: 'Flooring notify template',
        color: '#111111',
        dimensions: { width: 2, depth: 2, height: 1 },
      }),
    });
    await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'flooring-notify-instance',
        landletId: 'flooring-notify-landlet',
        templateId: 'flooring-notify-template',
        x: 1, y: 1,
      }),
    }));

    const toggled = await api('/catalog/flooring-notify-template', {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { flooring: true } }),
    });
    expect(toggled.response.status).toBe(200);

    const notices = await api('/notifications', builder.session());
    expect(notices.body.notifications).toHaveLength(1);
    expect(notices.body.notifications[0].message).toContain('had its placement rules changed by its seller');
    expect(notices.body.notifications[0].templateId).toBe('flooring-notify-template');
  });

  // Found via backlog audit (#338): shrinking a template's width (or
  // raising its extensible.x.minM) after an instance already has a valid
  // crop set used to brick that instance -- any later PATCH re-validated
  // the *carried-over* crop against the template's *current* bounds, even
  // when the request itself never touched crop or templateId.
  it('does not re-validate an unchanged crop value against a template shrunk after the crop was set', async () => {
    const builder = await signupBuilder('crop-revalidation-builder');
    await createGreenbeltLandlet('crop-revalidation-landlet');
    await api('/landlets/crop-revalidation-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'crop-revalidation-template',
        name: 'Shrinkable extensible product',
        color: '#111111',
        dimensions: { width: 4, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 1 } } },
      }),
    });

    const placed = await api('/instances', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'crop-revalidation-instance',
        landletId: 'crop-revalidation-landlet',
        templateId: 'crop-revalidation-template',
        x: 1, y: 1,
        crop: { x: 2 },
      }),
    }));
    expect(placed.response.status).toBe(201);

    // Seller shrinks the template — the now-stale crop.x=2 no longer fits
    // (width 4 -> 1.5), but nothing re-validates existing instances yet.
    const shrunk = await api('/catalog/crop-revalidation-template', {
      method: 'PATCH',
      body: JSON.stringify({ dimensions: { width: 1.5, depth: 1, height: 1 } }),
    });
    expect(shrunk.response.status).toBe(200);

    // An unrelated PATCH (just moving it) must still succeed even though it
    // resends the same unchanged crop.x=2 -- matching src/main.js's
    // syncUpdate, which always round-trips the mesh's full current state
    // (crop included) on every edit, not just a sparse diff. A presence-only
    // check ("did the body include crop?") would wrongly re-reject this.
    const moved = await api('/instances/crop-revalidation-instance', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ x: 5, y: 5, crop: { x: 2 } }),
    }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.instance.crop).toEqual({ x: 2 });
    expect(moved.body.instance).toMatchObject({ x: 5, y: 5 });

    // But actually changing the crop value now correctly 400s -- the caller
    // IS asserting a new crop/template pairing that must hold today. 1.6 is
    // above the shrunk template's own width (1.5), so it's out of bounds
    // regardless of this fix.
    const realCropChange = await api('/instances/crop-revalidation-instance', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ crop: { x: 1.6 } }),
    }));
    expect(realCropChange.response.status).toBe(400);

    // Switching templateId is re-validated even with the same crop value,
    // since it's now measured against a different template's bounds.
    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'crop-revalidation-other-template',
        name: 'Another extensible product',
        color: '#111111',
        dimensions: { width: 1, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 0.5 } } },
      }),
    });
    const templateSwap = await api('/instances/crop-revalidation-instance', builder.session({
      method: 'PATCH',
      body: JSON.stringify({ templateId: 'crop-revalidation-other-template', crop: { x: 2 } }),
    }));
    expect(templateSwap.response.status).toBe(400);
  });

  // #597: same fix as directly above, but for PUT /instances/batch, which
  // never got it -- src/api.js's upsertInstancesRemote uses this endpoint
  // for a multi-item group move or an undo/redo snapshot restore, both of
  // which resend every affected instance's full current state (crop
  // included), untouched ones alongside whatever the request actually
  // meant to change. Unconditionally re-validating crop there would brick
  // the *entire batch* the moment it included an instance whose template
  // was shrunk after its crop was already set -- the same bricking #338
  // fixed for the single-instance endpoint just above.
  it('does not re-validate an unchanged crop value in a batch that also moves an unrelated instance', async () => {
    const builder = await signupBuilder('batch-crop-revalidation-builder');
    await createGreenbeltLandlet('batch-crop-revalidation-landlet');
    await api('/landlets/batch-crop-revalidation-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'batch-crop-revalidation-template',
        name: 'Shrinkable extensible product',
        color: '#111111',
        dimensions: { width: 4, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 1 } } },
      }),
    });

    const placed = await api('/instances/batch', builder.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-crop-revalidation-instance',
          landletId: 'batch-crop-revalidation-landlet',
          templateId: 'batch-crop-revalidation-template',
          x: 1, y: 1,
          crop: { x: 2 },
        }],
      }),
    }));
    expect(placed.response.status).toBe(201);

    // Shrink the template — the stale crop.x=2 no longer fits (width 4 -> 1.5).
    const shrunk = await api('/catalog/batch-crop-revalidation-template', {
      method: 'PATCH',
      body: JSON.stringify({ dimensions: { width: 1.5, depth: 1, height: 1 } }),
    });
    expect(shrunk.response.status).toBe(200);

    // A group move that resends this instance's full current state (crop
    // included, unchanged) must still succeed, same as the single-instance
    // case above — a presence-only check would wrongly re-reject it.
    const moved = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-crop-revalidation-instance',
          landletId: 'batch-crop-revalidation-landlet',
          templateId: 'batch-crop-revalidation-template',
          x: 5, y: 5,
          crop: { x: 2 },
        }],
      }),
    }));
    expect(moved.response.status).toBe(200);
    expect(moved.body.instances[0].crop).toEqual({ x: 2 });
    expect(moved.body.instances[0]).toMatchObject({ x: 5, y: 5 });

    // But actually changing the crop value in a batch still correctly 400s
    // — 1.6 is above the shrunk template's own width (1.5).
    const realCropChange = await api('/instances/batch', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-crop-revalidation-instance',
          landletId: 'batch-crop-revalidation-landlet',
          templateId: 'batch-crop-revalidation-template',
          x: 5, y: 5,
          crop: { x: 1.6 },
        }],
      }),
    }));
    expect(realCropChange.response.status).toBe(400);
  });

  // #929: same race shape as the create/update tests above, for the two
  // DELETE branches — unlike their POST/PUT/PATCH siblings, they used a
  // point-in-time requireOwnedLandlet(s) check followed by a plain DELETE
  // with no ownership condition folded in and no meta.changes check
  // afterward, so a transfer landing in the await gap would let the old
  // owner's DELETE still remove the row.
  it('does not let a concurrent instance delete land once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('instance-delete-resolve-race-owner');
    const bidder = await signupBuilder('instance-delete-resolve-race-bidder');
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(100_000_000, bidder.builderId).run();
    await createGreenbeltLandlet('instance-delete-resolve-race-landlet');
    await api('/landlets/instance-delete-resolve-race-landlet/claim', owner.session({ method: 'POST' }));
    await api('/instances', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instanceId: 'instance-delete-resolve-race-instance', landletId: 'instance-delete-resolve-race-landlet',
        templateId: 'placeholder-tree', x: 1, y: 1,
      }),
    }));
    const started = await api('/landlets/instance-delete-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [deleted] = await Promise.all([
      api('/instances/instance-delete-resolve-race-instance', owner.session({ method: 'DELETE' })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    // 403 is also legitimate here (same shape as the create/update tests
    // above): the endpoint's own early requireOwnedLandlet check can
    // itself lose the race and see the new owner already in place, ahead
    // of ever reaching the write-time guard this fix adds (which is what
    // produces 409 instead). 404 is legitimate too — resolveAuction's own
    // unconditional wipe can beat this DELETE's initial existence check.
    expect([200, 403, 404, 409]).toContain(deleted.response.status);

    const landlet = await api('/landlets/instance-delete-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    // Whichever ran first, the instance never survives under the new
    // owner: this DELETE's own guard rejected it if resolve won, or
    // resolve's wipe removed it right after if this DELETE won.
    const instances = await api('/instances?landletId=instance-delete-resolve-race-landlet');
    expect(instances.body.instances).toEqual([]);
  });

  // #929: same race shape, for the batch delete endpoint.
  it('does not let a concurrent batch instance delete land once an auction transfers the landlet', async () => {
    const owner = await signupBuilder('batch-delete-resolve-race-owner');
    const bidder = await signupBuilder('batch-delete-resolve-race-bidder');
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(100_000_000, bidder.builderId).run();
    await createGreenbeltLandlet('batch-delete-resolve-race-landlet');
    await api('/landlets/batch-delete-resolve-race-landlet/claim', owner.session({ method: 'POST' }));
    await api('/instances/batch', owner.session({
      method: 'POST',
      body: JSON.stringify({
        instances: [{
          instanceId: 'batch-delete-resolve-race-instance',
          landletId: 'batch-delete-resolve-race-landlet',
          templateId: 'placeholder-tree', x: 1, y: 1,
        }],
      }),
    }));
    const started = await api('/landlets/batch-delete-resolve-race-landlet/auction', owner.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 0 }),
    }));
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 1500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();

    const [deleted] = await Promise.all([
      api('/instances/batch', owner.session({
        method: 'DELETE',
        body: JSON.stringify({ instanceIds: ['batch-delete-resolve-race-instance'] }),
      })),
      api(`/auctions/${auctionId}/resolve`, { method: 'POST' }),
    ]);
    expect([200, 403, 404, 409]).toContain(deleted.response.status);

    const landlet = await api('/landlets/batch-delete-resolve-race-landlet');
    expect(landlet.body.landlet.ownerBuilderId).toBe(bidder.builderId);
    const instances = await api('/instances?landletId=batch-delete-resolve-race-landlet');
    expect(instances.body.instances).toEqual([]);
  });

  // #860: same fix as the two tests directly above, but for
  // PUT /landlets/:id/draft, which never got it either -- this endpoint
  // always resends the landlet's *entire* current draft on every save
  // (autosave included), untouched instances alongside whatever the
  // request actually meant to change, so unconditionally re-validating
  // crop there would brick *every future save on the whole landlet*, not
  // just the affected instance/batch -- the same bricking #338/#597 fixed
  // at their own narrower scopes.
  it('does not re-validate an unchanged crop value in a lándlet draft save that also adds an unrelated instance', async () => {
    const builder = await signupBuilder('draft-crop-revalidation-builder');
    await createGreenbeltLandlet('draft-crop-revalidation-landlet');
    await api('/landlets/draft-crop-revalidation-landlet/claim', builder.session({ method: 'POST' }));

    await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId: 'draft-crop-revalidation-template',
        name: 'Shrinkable extensible product',
        color: '#111111',
        dimensions: { width: 4, depth: 1, height: 1 },
        metadata: { extensible: { x: { minM: 1 } } },
      }),
    });

    const placed = await api('/landlets/draft-crop-revalidation-landlet/draft', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'draft-crop-revalidation-instance',
          templateId: 'draft-crop-revalidation-template',
          x: 1, y: 1,
          crop: { x: 2 },
        }],
      }),
    }));
    expect(placed.response.status).toBe(200);

    // Shrink the template — the stale crop.x=2 no longer fits (width 4 -> 1.5).
    const shrunk = await api('/catalog/draft-crop-revalidation-template', {
      method: 'PATCH',
      body: JSON.stringify({ dimensions: { width: 1.5, depth: 1, height: 1 } }),
    });
    expect(shrunk.response.status).toBe(200);

    // A draft save that resends this instance's full current state (crop
    // included, unchanged) alongside a brand-new, unrelated instance must
    // still succeed -- a presence-only check would wrongly re-reject the
    // whole save, not just the affected instance.
    const saved = await api('/landlets/draft-crop-revalidation-landlet/draft', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [
          {
            instanceId: 'draft-crop-revalidation-instance',
            templateId: 'draft-crop-revalidation-template',
            x: 5, y: 5,
            crop: { x: 2 },
          },
          {
            instanceId: 'draft-crop-revalidation-new-instance',
            templateId: 'placeholder-tree',
            x: 2, y: 2,
          },
        ],
      }),
    }));
    expect(saved.response.status).toBe(200);
    const savedMoved = saved.body.instances.find((i) => i.instanceId === 'draft-crop-revalidation-instance');
    expect(savedMoved.crop).toEqual({ x: 2 });
    expect(savedMoved).toMatchObject({ x: 5, y: 5 });

    // But actually changing the crop value in a draft save still correctly
    // 400s -- 1.6 is above the shrunk template's own width (1.5).
    const realCropChange = await api('/landlets/draft-crop-revalidation-landlet/draft', builder.session({
      method: 'PUT',
      body: JSON.stringify({
        instances: [{
          instanceId: 'draft-crop-revalidation-instance',
          templateId: 'draft-crop-revalidation-template',
          x: 5, y: 5,
          crop: { x: 1.6 },
        }],
      }),
    }));
    expect(realCropChange.response.status).toBe(400);
  });
});

describe('Land cap', () => {
  async function createBuilder(label) {
    const res = await api('/builders', { method: 'POST', body: JSON.stringify({ label }) });
    return res.body.builder.builderId;
  }

  async function createGreenbeltLandletWithArea(landletId, areaM2) {
    return api('/landlets', adminSession({
      method: 'POST',
      body: JSON.stringify({ landletId, name: `Test ${landletId}`, areaM2, status: 'greenbelt' }),
    }));
  }

  async function claim(landletId, builder) {
    return api(`/landlets/${landletId}/claim`, builder.session({ method: 'POST' }));
  }

  // #629: bidding now also requires the bidder to actually hold enough
  // higgles_balance_cents to cover the bid — independent of the land-cap
  // gating these tests exist to exercise. Fund bidders past their (small)
  // bid amount so a rejection here is unambiguously about land cap, not
  // balance (see worker/index.js's handleAuctionBids/resolveAuction).
  async function fundHiggles(builder, amountCents = 100_000_000) {
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = ? WHERE builder_id = ?')
      .bind(amountCents, builder.builderId).run();
  }

  async function startAuction(landletId, seller) {
    return api(`/landlets/${landletId}/auction`, seller.session({
      method: 'POST',
      body: JSON.stringify({ startingBidCents: 0, durationHours: 1 }),
    }));
  }

  function landCapOf(listResponse, builderId) {
    return listResponse.body.builders.find((b) => b.builderId === builderId).landCapM2;
  }

  // #715's default page (100, ascending by created_at) means an unfiltered
  // GET /builders can leave this test's own freshly-created builder off
  // the first page once enough other builders have been created earlier
  // in this file -- the #717 ids= lookup bypasses pagination entirely, so
  // this stays correct regardless of how many builders exist elsewhere.
  it('defaults every new builder to a 1000 m² land cap', async () => {
    const builderId = await createBuilder('Land Cap Default Builder');
    expect(landCapOf(await api(`/builders?ids=${builderId}`), builderId)).toBe(1000);
  });

  // #489 (owner-confirmed): this used to be deliberately unenforced — see
  // that issue and worker/index.js's own handleAuctionBids comment for why
  // ("real checkout now exists" was the trigger the original comment
  // named to revisit this). A bid is only ever a *ground* landlet
  // changing hands (resolveAuction deletes the sold landlet's levels
  // before transferring it), so what's checked is the bidder's own
  // current owned area plus the auctioned landlet's area_m2 against their
  // cap — a fresh bidder here owns nothing yet, so a 5000m² landlet alone
  // already exceeds their default 1000m² cap.
  it('blocks a bid that would take the bidder over their land cap', async () => {
    const seller = await signupBuilder('land-cap-seller-a');
    const bidder = await signupBuilder('land-cap-bidder-a');
    await fundHiggles(bidder);
    await createGreenbeltLandletWithArea('land-cap-big-landlet', 5000);
    await claim('land-cap-big-landlet', seller);
    const started = await startAuction('land-cap-big-landlet', seller);
    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(409);
    expect(bid.body.error).toMatch(/land cap/i);
  });

  it('allows a bid that stays within the bidder\'s land cap', async () => {
    const seller = await signupBuilder('land-cap-seller-b');
    const bidder = await signupBuilder('land-cap-bidder-b');
    await fundHiggles(bidder);
    await createGreenbeltLandletWithArea('land-cap-small-landlet', 900);
    await claim('land-cap-small-landlet', seller);
    const started = await startAuction('land-cap-small-landlet', seller);
    const bid = await api(`/auctions/${started.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(201);
  });

  // Same one-unit display-rounding buffer as the level-add gate (owner
  // feedback — see worker/index.js's land-cap comment block), pinned down
  // on the bidding side too: a fresh bidder's default cap is 1000m², so a
  // 1001m² landlet is within the buffer and a 1002m² one is not.
  it('gives the auction-bid land cap gate the same one-unit display-rounding buffer', async () => {
    const sellerWithin = await signupBuilder('land-cap-buffer-seller-within');
    const bidderWithin = await signupBuilder('land-cap-buffer-bidder-within');
    await fundHiggles(bidderWithin);
    await createGreenbeltLandletWithArea('land-cap-buffer-within-landlet', 1001);
    await claim('land-cap-buffer-within-landlet', sellerWithin);
    const startedWithin = await startAuction('land-cap-buffer-within-landlet', sellerWithin);
    const withinBid = await api(`/auctions/${startedWithin.body.auction.auctionId}/bids`, bidderWithin.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(withinBid.response.status).toBe(201);

    const sellerBeyond = await signupBuilder('land-cap-buffer-seller-beyond');
    const bidderBeyond = await signupBuilder('land-cap-buffer-bidder-beyond');
    await fundHiggles(bidderBeyond);
    await createGreenbeltLandletWithArea('land-cap-buffer-beyond-landlet', 1002);
    await claim('land-cap-buffer-beyond-landlet', sellerBeyond);
    const startedBeyond = await startAuction('land-cap-buffer-beyond-landlet', sellerBeyond);
    const beyondBid = await api(`/auctions/${startedBeyond.body.auction.auctionId}/bids`, bidderBeyond.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(beyondBid.response.status).toBe(409);
  });

  // #706: docs/SPEC.md §5 promises land cap "frees" the moment a builder
  // commits a landlet to an auction with a $0 starting bid — immediately,
  // not only once the auction actually resolves. Before this fix, the
  // committed landlet's area kept counting against the seller's own cap
  // the whole time it sat mid-auction, silently breaking that promise
  // once #489 made land cap a real gate.
  it('frees land-cap headroom immediately for a builder\'s own $0-starting auction, letting them bid elsewhere', async () => {
    const committer = await signupBuilder('land-cap-free-immediate-committer');
    await fundHiggles(committer);
    await createGreenbeltLandletWithArea('land-cap-free-immediate-own', 1000);
    await claim('land-cap-free-immediate-own', committer);
    await startAuction('land-cap-free-immediate-own', committer); // $0 starting bid

    const target = await signupBuilder('land-cap-free-immediate-target-seller');
    await createGreenbeltLandletWithArea('land-cap-free-immediate-target', 900);
    await claim('land-cap-free-immediate-target', target);
    const targetAuction = await startAuction('land-cap-free-immediate-target', target);

    const bid = await api(`/auctions/${targetAuction.body.auction.auctionId}/bids`, committer.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(bid.response.status).toBe(201);
  });

  // Same promise, other clause: a >$0-starting auction only frees cap
  // once an actual bid lands (any bid guarantees eventual transfer) — not
  // from the moment the auction merely starts.
  it('frees land-cap headroom for a >$0-starting auction only once a bid actually lands on it', async () => {
    const committer = await signupBuilder('land-cap-free-on-bid-committer');
    await fundHiggles(committer);
    await createGreenbeltLandletWithArea('land-cap-free-on-bid-own', 1000);
    await claim('land-cap-free-on-bid-own', committer);
    const ownAuction = await api('/landlets/land-cap-free-on-bid-own/auction', committer.session({
      method: 'POST', body: JSON.stringify({ startingBidCents: 100, durationHours: 1 }),
    }));

    const target = await signupBuilder('land-cap-free-on-bid-target-seller');
    await createGreenbeltLandletWithArea('land-cap-free-on-bid-target', 900);
    await claim('land-cap-free-on-bid-target', target);
    const targetAuction = await startAuction('land-cap-free-on-bid-target', target);

    const tooEarly = await api(`/auctions/${targetAuction.body.auction.auctionId}/bids`, committer.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(tooEarly.response.status).toBe(409);

    const outsideBidder = await signupBuilder('land-cap-free-on-bid-outside-bidder');
    await fundHiggles(outsideBidder);
    const landedBid = await api(`/auctions/${ownAuction.body.auction.auctionId}/bids`, outsideBidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(landedBid.response.status).toBe(201);

    const afterBid = await api(`/auctions/${targetAuction.body.auction.auctionId}/bids`, committer.session({
      method: 'POST', body: JSON.stringify({ amountCents: 100 }),
    }));
    expect(afterBid.response.status).toBe(201);
  });

  it('grows a builder\'s land cap from trailing higgles earnings, normalized per 1000 m² owned', async () => {
    const builderId = await createBuilder('Land Cap Formula Builder');
    // $40 of trailing earnings, normalized against zero owned (floored to
    // the 1000 m² baseline), at 100 m² per dollar per 1000 m² owned =>
    // +4000 m² -> candidate cap 5000.
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-formula-earning', builderId, 4000).run();
    expect(landCapOf(await api(`/builders?ids=${builderId}`), builderId)).toBe(5000);
  });

  it('ratchets — a cap increase never reverts even after the earnings that produced it age out of the trailing window', async () => {
    const builderId = await createBuilder('Land Cap Ratchet Builder');
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, ?)
    `).bind('land-cap-ratchet-earning', builderId, 4000).run();
    expect(landCapOf(await api(`/builders?ids=${builderId}`), builderId)).toBe(5000);

    // Age the earning out of the 30-day trailing window, then force another
    // recompute (any GET /builders does this) — the cap must NOT drop back
    // down even though the earnings that grew it are now stale, matching
    // docs/SPEC.md §3's "ratcheting: once increased, never decreases."
    await env.DB.prepare(`
      UPDATE higgles_earnings_events SET created_at = '2000-01-01T00:00:00.000Z' WHERE event_id = ?
    `).bind('land-cap-ratchet-earning').run();
    expect(landCapOf(await api(`/builders?ids=${builderId}`), builderId)).toBe(5000);
  });

  it('credits a real per-event earnings ledger entry when an auction actually sells', async () => {
    const seller = await signupBuilder('land-cap-ledger-seller');
    const bidder = await signupBuilder('land-cap-ledger-bidder');
    await fundHiggles(bidder);
    await createGreenbeltLandletWithArea('land-cap-ledger-landlet', 1000);
    await claim('land-cap-ledger-landlet', seller);
    const started = await startAuction('land-cap-ledger-landlet', seller);
    const auctionId = started.body.auction.auctionId;
    await api(`/auctions/${auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    await env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`).bind(auctionId).run();
    await api(`/auctions/${auctionId}`); // GET resolves a due auction lazily

    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(seller.builderId).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(500);
  });

  // #629 (owner-confirmed): a bid holds land cap until the bidder is
  // outbid or the auction closes, so leading on one auction now counts
  // against what a second bid elsewhere is allowed to commit to — closing
  // the gap where a builder could win more auctions than their cap could
  // ever actually cover.
  it("counts a bidder's currently-leading bid on another active auction against their land cap for a new bid", async () => {
    const sellerA = await signupBuilder('land-cap-hold-seller-a');
    const sellerB = await signupBuilder('land-cap-hold-seller-b');
    const bidder = await signupBuilder('land-cap-hold-bidder');
    await fundHiggles(bidder);
    // A fresh builder's cap is 1000 m² — leading on a 700 m² auction plus
    // a second 700 m² bid would be 1400 m², over cap, even though neither
    // bid alone would be.
    await createGreenbeltLandletWithArea('land-cap-hold-landlet-a', 700);
    await createGreenbeltLandletWithArea('land-cap-hold-landlet-b', 700);
    await claim('land-cap-hold-landlet-a', sellerA);
    await claim('land-cap-hold-landlet-b', sellerB);
    const auctionA = await startAuction('land-cap-hold-landlet-a', sellerA);
    const auctionB = await startAuction('land-cap-hold-landlet-b', sellerB);

    const firstBid = await api(`/auctions/${auctionA.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(firstBid.response.status).toBe(201);

    const secondBid = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(secondBid.response.status).toBe(409);
    expect(secondBid.body.error).toMatch(/land cap/i);

    // Being outbid releases the hold — the same bid now succeeds once
    // someone else takes over the lead on the first auction.
    const outbidder = await signupBuilder('land-cap-hold-outbidder');
    await fundHiggles(outbidder);
    const outbid = await api(`/auctions/${auctionA.body.auction.auctionId}/bids`, outbidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 600 }),
    }));
    expect(outbid.response.status).toBe(201);

    const thirdBid = await api(`/auctions/${auctionB.body.auction.auctionId}/bids`, bidder.session({
      method: 'POST', body: JSON.stringify({ amountCents: 500 }),
    }));
    expect(thirdBid.response.status).toBe(201);
  });

  // #785: resolveAuction used to gate the winner's land cap with a plain
  // recomputeLandCap() read-then-compare, not an atomic conditional write
  // (unlike the balance debit right above it in the same function, and
  // unlike handleAuctionBids' own already-atomic INSERT ... WHERE guard for
  // the very same check at bid-placement time, #489/#629). Two auctions the
  // same builder is the sole bidder on can each resolve reading the other's
  // pre-transfer owned area, so both pass a cap that only actually covers
  // one of them. Bids are seeded directly rather than placed through the
  // API because handleAuctionBids' own bid-time hold (#629, already atomic)
  // would correctly refuse the second bid up front — this test is for
  // resolveAuction's own independent atomicity, a defense that must hold
  // regardless of whether some other gate happens to also catch this case.
  it("never lets a builder's land end up over cap when two of their winning auctions resolve concurrently", async () => {
    const sellerA = await signupBuilder('land-cap-resolve-race-seller-a');
    const sellerB = await signupBuilder('land-cap-resolve-race-seller-b');
    const bidder = await signupBuilder('land-cap-resolve-race-bidder');
    await fundHiggles(bidder);
    // A fresh builder's cap is 1000 m² — winning both 700 m² auctions would
    // be 1400 m², over cap, even though either alone fits comfortably.
    await createGreenbeltLandletWithArea('land-cap-resolve-race-landlet-a', 700);
    await createGreenbeltLandletWithArea('land-cap-resolve-race-landlet-b', 700);
    await claim('land-cap-resolve-race-landlet-a', sellerA);
    await claim('land-cap-resolve-race-landlet-b', sellerB);
    const auctionA = await startAuction('land-cap-resolve-race-landlet-a', sellerA);
    const auctionB = await startAuction('land-cap-resolve-race-landlet-b', sellerB);
    const auctionIdA = auctionA.body.auction.auctionId;
    const auctionIdB = auctionB.body.auction.auctionId;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)`,
      ).bind('land-cap-resolve-race-bid-a', auctionIdA, bidder.builderId, 100),
      env.DB.prepare(
        `INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)`,
      ).bind('land-cap-resolve-race-bid-b', auctionIdB, bidder.builderId, 100),
      env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id IN (?, ?)`)
        .bind(auctionIdA, auctionIdB),
    ]);

    await Promise.all([
      api(`/auctions/${auctionIdA}`),
      api(`/auctions/${auctionIdB}`),
    ]);

    const { results: landlets } = await env.DB.prepare(
      `SELECT landlet_id, owner_builder_id FROM landlets WHERE landlet_id IN (?, ?)`,
    ).bind('land-cap-resolve-race-landlet-a', 'land-cap-resolve-race-landlet-b').all();
    const wonByBidder = landlets.filter((l) => l.owner_builder_id === bidder.builderId);
    // Exactly one of the two must have actually transferred — the other
    // candidate must have lost the atomic land-cap gate and stayed with its
    // seller, never both landing on the same over-cap builder at once.
    expect(wonByBidder).toHaveLength(1);
  });

  // #883: a candidate skipped in resolveAuction's candidate loop (their
  // balance or land cap no longer covers their own bid by resolution time)
  // used to get zero notification of losing -- nobody outbid them (they
  // were still the standing-highest bid), and the resolution branches only
  // ever notified the seller. Seed two bids directly (bypassing
  // handleAuctionBids' own bid-time balance check, same technique as the
  // #785 test above) so the higher bid's bidder is under-funded by
  // resolution time and gets skipped in favor of the lower, affordable bid.
  it('#883: notifies a skipped candidate who was the standing-highest bid but could not be settled', async () => {
    const seller = await signupBuilder('skip-notify-seller');
    const highBidder = await signupBuilder('skip-notify-high-bidder');
    const lowBidder = await signupBuilder('skip-notify-low-bidder');
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 50 WHERE builder_id = ?')
      .bind(highBidder.builderId).run();
    await fundHiggles(lowBidder);
    await createGreenbeltLandletWithArea('skip-notify-landlet', 100);
    await claim('skip-notify-landlet', seller);
    const started = await startAuction('skip-notify-landlet', seller);
    const auctionId = started.body.auction.auctionId;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)`,
      ).bind('skip-notify-bid-high', auctionId, highBidder.builderId, 200),
      env.DB.prepare(
        `INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)`,
      ).bind('skip-notify-bid-low', auctionId, lowBidder.builderId, 100),
      env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`)
        .bind(auctionId),
    ]);

    const resolved = await api(`/auctions/${auctionId}`);
    expect(resolved.response.status).toBe(200);

    const landlet = await env.DB.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?')
      .bind('skip-notify-landlet').first();
    expect(landlet.owner_builder_id).toBe(lowBidder.builderId);

    const { results: highBidderNotifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(highBidder.builderId).all();
    expect(highBidderNotifications.some((n) => /could no longer be honored/.test(n.message))).toBe(true);
  });

  // #966: nothing stops the same builder placing two (increasing) bids on
  // one auction -- handleAuctionBids only requires a new bid to beat the
  // current highest, never checks for an existing bid from the same
  // bidder. If their higher bid gets skipped at resolution (balance no
  // longer covers it) but their own earlier, lower bid does, the candidate
  // loop used to leave that builder's id in skippedCandidateBuilderIds
  // *and* set them as winner -- sending the same builder both "you did not
  // win this auction" and "you won the auction" for the same resolution.
  // Seed two bids from the same builder directly (same technique as the
  // #883 test above), sized so only the lower one is affordable by
  // resolution time.
  it('#966: does not send a contradictory loss notification to a builder who wins via their own lower bid', async () => {
    const seller = await signupBuilder('self-bid-contradiction-seller');
    const bidder = await signupBuilder('self-bid-contradiction-bidder');
    await env.DB.prepare('UPDATE builders SET higgles_balance_cents = 100 WHERE builder_id = ?')
      .bind(bidder.builderId).run();
    await createGreenbeltLandletWithArea('self-bid-contradiction-landlet', 100);
    await claim('self-bid-contradiction-landlet', seller);
    const started = await startAuction('self-bid-contradiction-landlet', seller);
    const auctionId = started.body.auction.auctionId;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)`,
      ).bind('self-bid-contradiction-bid-high', auctionId, bidder.builderId, 150),
      env.DB.prepare(
        `INSERT INTO auction_bids (bid_id, auction_id, bidder_builder_id, amount_cents) VALUES (?, ?, ?, ?)`,
      ).bind('self-bid-contradiction-bid-low', auctionId, bidder.builderId, 100),
      env.DB.prepare(`UPDATE auctions SET ends_at = '2000-01-01T00:00:00.000Z' WHERE auction_id = ?`)
        .bind(auctionId),
    ]);

    const resolved = await api(`/auctions/${auctionId}`);
    expect(resolved.response.status).toBe(200);

    const landlet = await env.DB.prepare('SELECT owner_builder_id FROM landlets WHERE landlet_id = ?')
      .bind('self-bid-contradiction-landlet').first();
    expect(landlet.owner_builder_id).toBe(bidder.builderId);

    const { results: notifications } = await env.DB.prepare(
      'SELECT message FROM notifications WHERE builder_id = ? ORDER BY created_at',
    ).bind(bidder.builderId).all();
    expect(notifications.some((n) => /you won the auction/i.test(n.message))).toBe(true);
    expect(notifications.some((n) => /could no longer be honored/.test(n.message))).toBe(false);
  });

  it('lets a builder claim their one free starter lándlet regardless of the land cap', async () => {
    // The claim endpoint's own NOT EXISTS guard already limits a builder to
    // exactly one claimed lándlet at a time regardless of land cap, so a
    // fresh builder's default 1000 m² cap claiming a 1000 m² starter
    // lándlet is unaffected by this feature at all.
    const builder = await signupBuilder('land-cap-claim-builder');
    await createGreenbeltLandletWithArea('land-cap-starter-landlet', 1000);
    const claimed = await claim('land-cap-starter-landlet', builder);
    expect(claimed.response.status).toBe(200);
    expect(claimed.body.landlet.ownerBuilderId).toBe(builder.builderId);
  });

  // #489 made land cap a real gate, so anything (a test fixture, an e2e
  // suite) that needs a builder to already have cap headroom now needs a
  // legitimate way to grant it — there's no shortcut through the normal
  // player-facing API, on purpose (a real earnings event is the only thing
  // that's ever supposed to grow a cap). Admin-gated for the same reason
  // POST /api/landlets is: an anonymous caller must not be able to credit
  // themselves real land-cap headroom.
  it('grants land cap headroom via a real earnings event, admin-only', async () => {
    const builder = await createBuilder('Land Cap Grant Builder');

    const unauthenticated = await api(`/builders/${builder}/land-cap-grants`, {
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    });
    expect(unauthenticated.response.status).toBe(401);

    const nonAdmin = await api(`/builders/${builder}/land-cap-grants`, (await signupBuilder('land-cap-grant-non-admin')).session({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(nonAdmin.response.status).toBe(403);

    const granted = await api(`/builders/${builder}/land-cap-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(granted.response.status).toBe(201);
    expect(granted.body.landCapM2).toBeGreaterThan(1000);
    // #717's bounded ids= lookup, not the unfiltered listing -- this
    // file's test builders accumulate across every `it` (storage isn't
    // reset between them), and the unfiltered list defaults to the first
    // 100 by created_at, so a builder created late enough in this file's
    // own run can silently fall off page 1.
    expect(landCapOf(await api(`/builders?ids=${builder}`), builder)).toBe(granted.body.landCapM2);

    // It's a real earnings event, same ledger auction sales credit — not a
    // side-channel that bypasses it.
    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(builder).all();
    expect(results).toHaveLength(1);
    expect(results[0].amount_cents).toBe(100000);

    const missingBuilder = await api('/builders/does-not-exist/land-cap-grants', adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(missingBuilder.response.status).toBe(404);

    // #816 (sub-issue of #813): a real-money-equivalent admin top-up must
    // leave a record of which admin granted it.
    const me = await api('/auth/me', adminSession());
    const logRow = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('land_cap_grant', builder).first();
    expect(logRow.admin_user_id).toBe(me.body.user.userId);
    expect(logRow.target_type).toBe('builder');
    expect(JSON.parse(logRow.detail_json)).toEqual({ amountCents: 100000 });
  });

  // #1372: computeNextLandCap used to round-trip trailingEarningsCents
  // through an intermediate cents/100 dollars division before multiplying
  // back by 100, which IEEE-754 doesn't always cancel exactly (29 cents ->
  // 0.29 * 100 === 28.999999999999996, not 29) -- the truncating Math.floor
  // then silently cost the builder 1 m² of cap they actually earned. 29 is
  // one of the smallest cents values that triggers it (verified by scanning
  // every integer cents value 0-2,000,000 against the exact expected
  // result). A fresh builder owns 0 m² (normalizedThousands clamps to the
  // 1000 m² starter), so the grant should land exactly at 1000 + 29 = 1029,
  // not 1028.
  it('does not lose a m² of land cap to floating-point imprecision on a 29-cent earnings grant', async () => {
    const builder = await createBuilder('Land Cap Precision Builder');
    const granted = await api(`/builders/${builder}/land-cap-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 29 }),
    }));
    expect(granted.response.status).toBe(201);
    expect(granted.body.landCapM2).toBe(1029);
  });

  // #629: bidding now also requires the bidder to hold enough
  // higgles_balance_cents to cover their bid — deliberately independent of
  // land-cap-grants above, which only ever touches the earnings ledger
  // (cap growth), never balance. A test fixture needing a builder to
  // actually *afford* a bid needs this instead.
  it('grants higgles balance directly, admin-only, independent of land-cap-grants', async () => {
    const builder = await createBuilder('Higgles Grant Builder');

    const unauthenticated = await api(`/builders/${builder}/higgles-grants`, {
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    });
    expect(unauthenticated.response.status).toBe(401);

    const nonAdmin = await api(`/builders/${builder}/higgles-grants`, (await signupBuilder('higgles-grant-non-admin')).session({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(nonAdmin.response.status).toBe(403);

    const granted = await api(`/builders/${builder}/higgles-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(granted.response.status).toBe(201);
    expect(granted.body.higglesBalanceCents).toBe(100000);

    // Additive, not a flat set — a second grant stacks onto the first.
    const grantedAgain = await api(`/builders/${builder}/higgles-grants`, adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 50000 }),
    }));
    expect(grantedAgain.response.status).toBe(201);
    expect(grantedAgain.body.higglesBalanceCents).toBe(150000);

    // Unlike land-cap-grants, this never touches the earnings ledger — it's
    // a pure balance top-up, not a stand-in for real income.
    const { results } = await env.DB.prepare(
      'SELECT * FROM higgles_earnings_events WHERE builder_id = ?',
    ).bind(builder).all();
    expect(results).toHaveLength(0);
    // #717's bounded ids= lookup -- same reasoning as the land-cap-grants
    // test above.
    expect(landCapOf(await api(`/builders?ids=${builder}`), builder)).toBe(1000);

    const missingBuilder = await api('/builders/does-not-exist/higgles-grants', adminSession({
      method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
    }));
    expect(missingBuilder.response.status).toBe(404);

    // #816 (sub-issue of #813): same accountability record as
    // land-cap-grants above — one row per grant, most recent last.
    const me = await api('/auth/me', adminSession());
    const { results: logRows } = await env.DB.prepare(
      'SELECT * FROM admin_action_log WHERE action_type = ? AND target_id = ? ORDER BY created_at',
    ).bind('higgles_grant', builder).all();
    expect(logRows).toHaveLength(2);
    expect(logRows[0].admin_user_id).toBe(me.body.user.userId);
    expect(logRows[0].target_type).toBe('builder');
    expect(JSON.parse(logRows[0].detail_json)).toEqual({ amountCents: 100000 });
    expect(JSON.parse(logRows[1].detail_json)).toEqual({ amountCents: 50000 });
  });

  // #1667: both grant endpoints above used to batch their own admin_action_log
  // INSERT unconditionally alongside the real write -- a builder self-deleting
  // (DELETE /builders/:id, above) in the gap between the admin's requireBuilder
  // read and that write landing could still commit a log row crediting a grant
  // that never actually happened, since D1's db.batch() commits every statement
  // regardless of an earlier one's row count (same root cause #897's
  // /admin-forms/:formId/approve fix already addressed for a sibling handler).
  // Races a genuine self-delete against each grant call, same Promise.all shape
  // #1055's generation-complete-vs-expand race test (worker/worker-api.test.js)
  // uses, since the race only manifests when the two writes actually interleave
  // inside the same window -- the invariant checked below (a log row exists iff
  // the real write landed) must hold regardless of which order actually won.
  it('#1667: a builder self-deleting concurrently with land-cap-grants/higgles-grants never logs a grant that did not land', async () => {
    const landCapBuilder = await signupBuilder('land-cap-grant-race-builder');
    const [landCapGrant, landCapDelete] = await Promise.all([
      api(`/builders/${landCapBuilder.builderId}/land-cap-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
      })),
      api(`/builders/${landCapBuilder.builderId}`, landCapBuilder.session({ method: 'DELETE' })),
    ]);
    expect(landCapDelete.response.status).toBe(200);
    expect([201, 404]).toContain(landCapGrant.response.status);
    // Not cross-checked against higgles_earnings_events here -- that row
    // (if the grant did land first) gets cascade-deleted by the builder
    // delete regardless, per migrations/0093's own ON DELETE CASCADE, so
    // it can't distinguish "never inserted" from "inserted, then cascaded
    // away." admin_action_log.target_id carries no such FK and survives,
    // so it's the only reliable signal of what this request itself did.
    const landCapLogCount = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('land_cap_grant', landCapBuilder.builderId).first()).n;
    if (landCapGrant.response.status === 201) {
      expect(landCapLogCount).toBe(1);
    } else {
      expect(landCapGrant.body).toEqual({ error: 'Builder not found' });
      expect(landCapLogCount).toBe(0);
    }

    const higglesBuilder = await signupBuilder('higgles-grant-race-builder');
    const [higglesGrant, higglesDelete] = await Promise.all([
      api(`/builders/${higglesBuilder.builderId}/higgles-grants`, adminSession({
        method: 'POST', body: JSON.stringify({ amountCents: 100000 }),
      })),
      api(`/builders/${higglesBuilder.builderId}`, higglesBuilder.session({ method: 'DELETE' })),
    ]);
    expect(higglesDelete.response.status).toBe(200);
    expect([201, 404]).toContain(higglesGrant.response.status);
    const higglesLogCount = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM admin_action_log WHERE action_type = ? AND target_id = ?',
    ).bind('higgles_grant', higglesBuilder.builderId).first()).n;
    if (higglesGrant.response.status === 201) {
      expect(higglesLogCount).toBe(1);
    } else {
      expect(higglesGrant.body).toEqual({ error: 'Builder not found' });
      expect(higglesLogCount).toBe(0);
    }
  });
});
