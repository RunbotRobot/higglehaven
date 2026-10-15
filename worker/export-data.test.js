// #1984 (sub-issue of #1983, owner-greenlit on #1480): GET /api/auth/export-data,
// the foundational endpoint + identity/profile section of the GDPR/CCPA
// "right to access" companion to #1145's own "right to erasure". Later
// sub-issues (#1985 commerce/economy, #1986 social/content) add their own
// top-level keys to this same response shape -- this file covers the
// `profile` section #1984 itself ships, plus the `commerce` section #1985
// adds below.
import {
  applyD1Migrations, env,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from './index.js';
import {
  api, extractSessionCookie, signup, signupBuilder, withSession,
} from './test-helpers.js';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('GET /auth/export-data (#1984)', () => {
  it('requires a session', async () => {
    const anon = await api('/auth/export-data');
    expect(anon.response.status).toBe(401);
  });

  it('returns the account and builder profile, with no seller profile yet', async () => {
    const account = await signupBuilder('export-data-builder');
    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.exportedAt).toBeTruthy();
    expect(result.body.profile.account.email).toBe(account.email);
    expect(result.body.profile.account.password_hash).toBeUndefined();
    expect(result.body.profile.builder.builderId).toBe(account.builderId);
    expect(result.body.profile.seller).toBeNull();
    expect(result.body.profile.diditVerificationSessions).toEqual([]);
  });

  it('includes the seller profile once one exists', async () => {
    const email = `export-data-seller-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here', { username: 'export-data-seller' });
    const sessionToken = extractSessionCookie(signedUp.response);
    await api('/sellers/me', withSession(sessionToken));
    const result = await api('/auth/export-data', withSession(sessionToken));
    expect(result.response.status).toBe(200);
    expect(result.body.profile.seller).not.toBeNull();
    expect(result.body.profile.seller.label).toBe('export-data-seller');
  });

  it('includes didit verification sessions by status/timestamp only, never a raw payload', async () => {
    const account = await signupBuilder('export-data-didit');
    const userId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(account.email).first()).user_id;
    await env.DB.prepare(
      'INSERT INTO didit_verification_sessions (session_id, user_id, status, processed_at) VALUES (?, ?, ?, ?)',
    ).bind('didit-export-test-session', userId, 'approved', '2026-10-01T00:00:00.000Z').run();

    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.profile.diditVerificationSessions).toEqual([{
      sessionId: 'didit-export-test-session',
      status: 'approved',
      createdAt: expect.any(String),
      processedAt: '2026-10-01T00:00:00.000Z',
    }]);
  });

  it('rate-limits repeated calls from the same account', async () => {
    const account = await signupBuilder('export-data-rate-limit');
    for (let i = 0; i < 10; i += 1) {
      const attempt = await api('/auth/export-data', account.session());
      expect(attempt.response.status).toBe(200);
    }
    const limited = await api('/auth/export-data', account.session());
    expect(limited.response.status).toBe(429);
  });
});

// #1985 (sub-issue of #1983): the commerce/economy section -- purchases
// (as buyer), owned avatars/animations, video-generation jobs, higgles
// redemptions/earnings, and authored bundles. Deliberately excludes
// tax_1099_forms (the owner call on raw taxIdNumber/foreignTaxId inclusion,
// flagged on #1983, is still open) and owned_avatar_purchases/
// owned_animation_purchases (internal grant-bookkeeping tables with no
// field not already present on the corresponding owned_avatars/
// owned_animations row itself).
describe('GET /auth/export-data commerce section (#1985)', () => {
  it('returns every commerce list empty for a fresh account with no builder profile at all', async () => {
    const email = `export-data-commerce-no-builder-${crypto.randomUUID()}@example.com`;
    const signedUp = await signup(email, 'a fine long password here', { username: 'export-data-no-builder' });
    const sessionToken = extractSessionCookie(signedUp.response);
    const result = await api('/auth/export-data', withSession(sessionToken));
    expect(result.response.status).toBe(200);
    expect(result.body.commerce).toEqual({
      purchasesAsBuyer: [],
      ownedAvatars: [],
      ownedAnimations: [],
      videoGenerationJobs: [],
      higglesRedemptions: [],
      higglesEarningsEvents: [],
      bundles: [],
    });
  });

  it('returns every commerce list empty for a fresh builder with no commerce history', async () => {
    const account = await signupBuilder('export-data-commerce-empty');
    const result = await api('/auth/export-data', account.session());
    expect(result.response.status).toBe(200);
    expect(result.body.commerce).toEqual({
      purchasesAsBuyer: [],
      ownedAvatars: [],
      ownedAnimations: [],
      videoGenerationJobs: [],
      higglesRedemptions: [],
      higglesEarningsEvents: [],
      bundles: [],
    });
  });

  it('includes a purchase made as buyer, scoped by buyer_builder_id not builder_id (the host)', async () => {
    const host = await signupBuilder('export-data-commerce-host');
    const buyer = await signupBuilder('export-data-commerce-buyer');
    const purchaseId = `purchase-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO purchases (
        purchase_id, instance_id, template_id, builder_id, buyer_builder_id, unit_price_cents, quantity,
        total_cents, commission_cents, builder_share_cents, platform_share_cents
      ) VALUES (?, 'export-data-instance', 'export-data-template', ?, ?, 500, 1, 500, 10, 490, 10)
    `).bind(purchaseId, host.builderId, buyer.builderId).run();

    const buyerResult = await api('/auth/export-data', buyer.session());
    expect(buyerResult.body.commerce.purchasesAsBuyer).toHaveLength(1);
    expect(buyerResult.body.commerce.purchasesAsBuyer[0]).toMatchObject({
      purchaseId, builderId: host.builderId, buyerBuilderId: buyer.builderId, totalCents: 500,
    });

    // The host earned commission on this purchase but didn't buy anything —
    // buyer_builder_id, not builder_id, is what scopes "as buyer".
    const hostResult = await api('/auth/export-data', host.session());
    expect(hostResult.body.commerce.purchasesAsBuyer).toEqual([]);
  });

  it('includes owned avatars and animations with their purchasedAt timestamp', async () => {
    const builder = await signupBuilder('export-data-commerce-owned');
    await env.DB.prepare(`
      INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, price_cents)
      VALUES ('export-data-avatar-template', 'Export Data Avatar', 'avatar', '#123456', 1, 1, 2, 500)
    `).run();
    await env.DB.prepare(`
      INSERT INTO catalog_templates (template_id, name, category, color, width_m, depth_m, height_m, price_cents)
      VALUES ('export-data-animation-template', 'Export Data Animation', 'animation', '#654321', 1, 1, 2, 500)
    `).run();
    await env.DB.prepare(`
      INSERT INTO owned_avatars (builder_id, template_id, purchased_at) VALUES (?, 'export-data-avatar-template', '2026-10-01T00:00:00.000Z')
    `).bind(builder.builderId).run();
    await env.DB.prepare(`
      INSERT INTO owned_animations (builder_id, template_id, purchased_at) VALUES (?, 'export-data-animation-template', '2026-10-02T00:00:00.000Z')
    `).bind(builder.builderId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.commerce.ownedAvatars).toEqual([expect.objectContaining({
      templateId: 'export-data-avatar-template', purchasedAt: '2026-10-01T00:00:00.000Z',
    })]);
    expect(result.body.commerce.ownedAnimations).toEqual([expect.objectContaining({
      templateId: 'export-data-animation-template', purchasedAt: '2026-10-02T00:00:00.000Z',
    })]);
  });

  it('includes video generation jobs, higgles redemptions, and higgles earnings events', async () => {
    const builder = await signupBuilder('export-data-commerce-economy');
    await env.DB.prepare(`
      INSERT INTO video_generation_jobs (job_id, builder_id, provider_task_id, status, model_url)
      VALUES ('export-data-job', ?, 'export-data-task', 'complete', '/uploads/export-data.glb')
    `).bind(builder.builderId).run();
    const redemptionId = `redemption-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO higgles_redemptions (redemption_id, builder_id, amount_cents, stripe_transfer_id, stripe_payout_id)
      VALUES (?, ?, 10000, 'tr_export_data', 'po_export_data')
    `).bind(redemptionId, builder.builderId).run();
    const eventId = `earnings-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO higgles_earnings_events (event_id, builder_id, amount_cents) VALUES (?, ?, 250)
    `).bind(eventId, builder.builderId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.commerce.videoGenerationJobs).toEqual([{
      jobId: 'export-data-job', providerTaskId: 'export-data-task', status: 'complete',
      modelUrl: '/uploads/export-data.glb', error: null, createdAt: expect.any(String), processedAt: null,
    }]);
    expect(result.body.commerce.higglesRedemptions).toEqual([{
      redemptionId, amountCents: 10000, stripeTransferId: 'tr_export_data', stripePayoutId: 'po_export_data',
      createdAt: expect.any(String),
    }]);
    expect(result.body.commerce.higglesEarningsEvents).toEqual([{
      eventId, amountCents: 250, createdAt: expect.any(String),
    }]);
  });

  it('includes authored bundles', async () => {
    const builder = await signupBuilder('export-data-commerce-bundles');
    const bundleId = `bundle-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO bundles (bundle_id, builder_id, name, items_json) VALUES (?, ?, 'Export Data Bundle', '[]')",
    ).bind(bundleId, builder.builderId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.commerce.bundles).toEqual([expect.objectContaining({ bundleId, name: 'Export Data Bundle' })]);
  });

  it('scopes every commerce list to the requesting builder only, never another builder\'s own', async () => {
    const builderA = await signupBuilder('export-data-commerce-scope-a');
    const builderB = await signupBuilder('export-data-commerce-scope-b');
    const bundleId = `bundle-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO bundles (bundle_id, builder_id, name, items_json) VALUES (?, ?, 'Builder B Bundle', '[]')",
    ).bind(bundleId, builderB.builderId).run();

    const resultA = await api('/auth/export-data', builderA.session());
    expect(resultA.body.commerce.bundles).toEqual([]);
  });
});

// #1986 (sub-issue of #1983): the `social` section.
describe('GET /auth/export-data -- social section (#1986)', () => {
  async function signupIdVerifiedBuilder(label) {
    const builder = await signupBuilder(label);
    await env.DB.prepare("UPDATE users SET trust_tier = 'id_verified' WHERE user_id = (SELECT user_id FROM builders WHERE builder_id = ?)")
      .bind(builder.builderId).run();
    return builder;
  }

  async function becomeFriends(a, b) {
    const sent = await api('/friendships', a.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: b.builderId }),
    }));
    await api(`/friendships/${sent.body.friendship.friendshipId}`, b.session({
      method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
    }));
  }

  async function createTemplate(templateId) {
    const created = await api('/catalog', {
      method: 'POST',
      body: JSON.stringify({
        templateId, name: `Export test product ${templateId}`, color: '#123456', dimensions: { width: 1, depth: 1, height: 1 },
      }),
    });
    expect(created.response.status).toBe(201);
    return templateId;
  }

  async function createPurchase(templateId, buyer) {
    const host = (await api('/builders', { method: 'POST', body: JSON.stringify({ label: `Host for ${templateId} ${crypto.randomUUID()}` }) })).body.builder;
    const purchaseId = `purchase-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO purchases
        (purchase_id, instance_id, template_id, builder_id, seller_id, buyer_label, buyer_builder_id,
         unit_price_cents, quantity, total_cents, commission_cents, builder_share_cents, platform_share_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, 500, 1, 500, 10, 5, 5)
    `).bind(purchaseId, `instance-${crypto.randomUUID()}`, templateId, host.builderId, `seller-${crypto.randomUUID()}`, buyer.builder.label, buyer.builderId).run();
    return purchaseId;
  }

  it('includes friendships, direct messages, and the notification a DM fires', async () => {
    const alice = await signupIdVerifiedBuilder('export-social-alice');
    const bob = await signupIdVerifiedBuilder('export-social-bob');
    await becomeFriends(alice, bob);
    const sent = await api('/direct-messages', alice.session({
      method: 'POST', body: JSON.stringify({ recipientBuilderId: bob.builderId, text: 'Hi Bob, from the export test' }),
    }));
    expect(sent.response.status).toBe(201);

    const aliceExport = await api('/auth/export-data', alice.session());
    expect(aliceExport.body.social.friendships).toHaveLength(1);
    expect(aliceExport.body.social.friendships[0].otherBuilderId).toBe(bob.builderId);
    expect(aliceExport.body.social.directMessages).toHaveLength(1);
    expect(aliceExport.body.social.directMessages[0].text).toBe('Hi Bob, from the export test');

    const bobExport = await api('/auth/export-data', bob.session());
    expect(bobExport.body.social.friendships).toHaveLength(1);
    expect(bobExport.body.social.directMessages).toHaveLength(1);
    expect(bobExport.body.social.notifications.some((n) => n.message.includes('sent you a message'))).toBe(true);
  });

  it('includes a product review and seller feedback authored as the buyer, via the real purchase_id link', async () => {
    const buyer = await signupBuilder('export-social-buyer');
    const templateId = await createTemplate('export-social-template');
    const purchaseId = await createPurchase(templateId, buyer);

    const review = await api(`/catalog/${templateId}/reviews`, buyer.session({
      method: 'POST', body: JSON.stringify({ rating: 5, text: 'Great for the export test' }),
    }));
    expect(review.response.status).toBe(201);
    const feedback = await api(`/purchases/${purchaseId}/feedback`, buyer.session({
      method: 'POST', body: JSON.stringify({ rating: 4, text: 'Good service' }),
    }));
    expect(feedback.response.status).toBe(201);

    const result = await api('/auth/export-data', buyer.session());
    expect(result.body.social.productReviews).toHaveLength(1);
    expect(result.body.social.productReviews[0].text).toBe('Great for the export test');
    expect(result.body.social.sellerFeedback).toHaveLength(1);
    expect(result.body.social.sellerFeedback[0].text).toBe('Good service');
  });

  it('includes sign posts by this account\'s real user_id, not another account\'s', async () => {
    const author = await signupBuilder('export-social-sign-author');
    const stranger = await signupBuilder('export-social-sign-stranger');
    const authorUserId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(author.email).first()).user_id;
    const strangerUserId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(stranger.email).first()).user_id;
    const templateId = await createTemplate('export-social-sign-template');
    await env.DB.prepare(`
      INSERT INTO landlets (landlet_id, name, owner_builder_id, status) VALUES (?, ?, ?, 'claimed')
    `).bind('export-social-sign-landlet', 'Export Sign Landlet', author.builderId).run();
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, is_community_sign)
      VALUES (?, ?, ?, 0, 0, 1)
    `).bind('export-social-sign-instance', 'export-social-sign-landlet', templateId).run();
    await env.DB.prepare(`
      INSERT INTO sign_posts (post_id, instance_id, author_label, text, user_id) VALUES (?, ?, ?, ?, ?)
    `).bind('export-social-sign-post', 'export-social-sign-instance', author.builder.label, 'My own sign post', authorUserId).run();
    await env.DB.prepare(`
      INSERT INTO sign_posts (post_id, instance_id, author_label, text, user_id) VALUES (?, ?, ?, ?, ?)
    `).bind('export-social-sign-post-stranger', 'export-social-sign-instance', stranger.builder.label, 'A stranger\'s sign post', strangerUserId).run();

    const authorExport = await api('/auth/export-data', author.session());
    expect(authorExport.body.social.signPosts).toHaveLength(1);
    expect(authorExport.body.social.signPosts[0].text).toBe('My own sign post');
  });

  // #2032's own migrations/0135_calendar_events_user_id.sql gave
  // calendar_events a real user_id FK (same shape sign_posts already got
  // in #1830) -- this used to match on author_label alone, a spoofable
  // approximation this test's own old title called out explicitly. A row
  // with no user_id at all (predating that migration) is correctly left
  // out, same as the sign-posts test above does for a stranger's post.
  it('includes calendar events by this account\'s real user_id, not another account\'s or a legacy unattributed one', async () => {
    const author = await signupBuilder('export-social-calendar-author');
    const stranger = await signupBuilder('export-social-calendar-stranger');
    const authorUserId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(author.email).first()).user_id;
    const strangerUserId = (await env.DB.prepare('SELECT user_id FROM users WHERE email = ?').bind(stranger.email).first()).user_id;
    const templateId = await createTemplate('export-social-calendar-template');
    await env.DB.prepare(`
      INSERT INTO landlets (landlet_id, name, owner_builder_id, status) VALUES (?, ?, ?, 'claimed')
    `).bind('export-social-calendar-landlet', 'Export Calendar Landlet', author.builderId).run();
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, is_community_calendar)
      VALUES (?, ?, ?, 0, 0, 1)
    `).bind('export-social-calendar-instance', 'export-social-calendar-landlet', templateId).run();
    await env.DB.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text, user_id) VALUES (?, ?, ?, ?, ?)
    `).bind('export-social-calendar-event', 'export-social-calendar-instance', author.builder.label, 'My own calendar event', authorUserId).run();
    await env.DB.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text, user_id) VALUES (?, ?, ?, ?, ?)
    `).bind('export-social-calendar-event-other', 'export-social-calendar-instance', stranger.builder.label, 'Not my event', strangerUserId).run();
    // A legacy row predating migrations/0135 — no user_id to attribute at
    // all, even though its author_label happens to match today.
    await env.DB.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text) VALUES (?, ?, ?, ?)
    `).bind('export-social-calendar-event-legacy', 'export-social-calendar-instance', author.builder.label, 'Pre-migration, unattributed').run();

    const result = await api('/auth/export-data', author.session());
    expect(result.body.social.calendarEvents).toHaveLength(1);
    expect(result.body.social.calendarEvents[0].text).toBe('My own calendar event');
  });

  it('includes saved level layouts with their saved instances', async () => {
    const builder = await signupBuilder('export-social-saved-layout');
    const templateId = await createTemplate('export-social-saved-layout-template');
    await env.DB.prepare(`
      INSERT INTO saved_level_layouts (saved_layout_id, builder_id, source_level_index, name)
      VALUES (?, ?, 0, 'My Saved Layout')
    `).bind('export-social-saved-layout', builder.builderId).run();
    await env.DB.prepare(`
      INSERT INTO saved_layout_instances (saved_layout_id, source_instance_id, template_id, x_m, y_m, z_m)
      VALUES (?, ?, ?, 1, 2, 0)
    `).bind('export-social-saved-layout', 'export-social-saved-instance', templateId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.social.savedLevelLayouts).toHaveLength(1);
    expect(result.body.social.savedLevelLayouts[0].name).toBe('My Saved Layout');
    expect(result.body.social.savedLevelLayouts[0].instanceCount).toBe(1);
    expect(result.body.social.savedLevelLayouts[0].instances).toHaveLength(1);
  });

  it('includes landlet versions and their instances, for landlets this builder currently owns', async () => {
    const builder = await signupBuilder('export-social-landlet-version');
    const templateId = await createTemplate('export-social-landlet-version-template');
    await env.DB.prepare(`
      INSERT INTO landlets (landlet_id, name, owner_builder_id, status) VALUES (?, ?, ?, 'claimed')
    `).bind('export-social-version-landlet', 'Export Version Landlet', builder.builderId).run();
    await env.DB.prepare(`
      INSERT INTO landlet_versions (version_id, landlet_id, version_number, name) VALUES (?, ?, 1, 'v1')
    `).bind('export-social-version', 'export-social-version-landlet').run();
    await env.DB.prepare(`
      INSERT INTO version_instances (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_z_rad)
      VALUES (?, ?, ?, 1, 2, 0, 0)
    `).bind('export-social-version', 'export-social-version-instance', templateId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.social.landletVersions).toHaveLength(1);
    expect(result.body.social.landletVersions[0].name).toBe('v1');
    expect(result.body.social.landletVersions[0].instanceCount).toBe(1);
    expect(result.body.social.landletVersions[0].instances).toHaveLength(1);
  });

  // #2185: archived_landlet_versions/archived_version_instances
  // (migrations/0140) preserve a landlet's version history past its
  // source landlet changing hands -- a real builder_id column, not an
  // ownership-join approximation like landletVersions above, so this
  // exercises the direct match and confirms sourceLandletId round-trips.
  it('includes archived landlet versions and their instances, by builder_id directly', async () => {
    const builder = await signupBuilder('export-social-archived-version');
    const templateId = await createTemplate('export-social-archived-version-template');
    await env.DB.prepare(`
      INSERT INTO landlets (landlet_id, name, owner_builder_id, status) VALUES (?, ?, ?, 'greenbelt')
    `).bind('export-social-archived-version-landlet', 'Export Archived Version Landlet', builder.builderId).run();
    await env.DB.prepare(`
      INSERT INTO archived_landlet_versions (version_id, builder_id, source_landlet_id, version_number, name, created_at)
      VALUES (?, ?, ?, 1, 'archived-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).bind('export-social-archived-version', builder.builderId, 'export-social-archived-version-landlet').run();
    await env.DB.prepare(`
      INSERT INTO archived_version_instances (version_id, source_instance_id, template_id, x_m, y_m, z_m, rotation_z_rad)
      VALUES (?, ?, ?, 1, 2, 0, 0)
    `).bind('export-social-archived-version', 'export-social-archived-version-instance', templateId).run();

    const result = await api('/auth/export-data', builder.session());
    expect(result.body.social.archivedLandletVersions).toHaveLength(1);
    expect(result.body.social.archivedLandletVersions[0].name).toBe('archived-v1');
    expect(result.body.social.archivedLandletVersions[0].sourceLandletId).toBe('export-social-archived-version-landlet');
    expect(result.body.social.archivedLandletVersions[0].instanceCount).toBe(1);
    expect(result.body.social.archivedLandletVersions[0].instances).toHaveLength(1);
  });

  // #2185: archived_landlet_versions keys directly on builder_id, not
  // landlet ownership -- confirms another builder's archived version
  // never leaks into this account's own export.
  it('scopes archived landlet versions to the requesting builder only, never another builder\'s own', async () => {
    const owner = await signupBuilder('export-social-archived-version-owner');
    const other = await signupBuilder('export-social-archived-version-other');
    await env.DB.prepare(`
      INSERT INTO archived_landlet_versions (version_id, builder_id, version_number, name, created_at)
      VALUES (?, ?, 1, 'owner-only', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).bind('export-social-archived-version-owner-only', owner.builderId).run();

    const result = await api('/auth/export-data', other.session());
    expect(result.body.social.archivedLandletVersions).toEqual([]);
  });

  it('keeps every social collection empty for an account with none of this activity', async () => {
    const quiet = await signupBuilder('export-social-quiet');
    const result = await api('/auth/export-data', quiet.session());
    expect(result.body.social).toMatchObject({
      friendships: [], directMessages: [], notifications: [], productReviews: [], sellerFeedback: [],
      signPosts: [], calendarEvents: [], savedLevelLayouts: [], landletVersions: [], archivedLandletVersions: [],
    });
  });
});
