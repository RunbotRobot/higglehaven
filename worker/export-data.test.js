// #1984 (sub-issue of #1983, owner-greenlit on #1480): GET /api/auth/export-data,
// the foundational endpoint + identity/profile section of the GDPR/CCPA
// "right to access" companion to #1145's own "right to erasure". Later
// sub-issues (#1985 commerce/economy, #1986 social/content) add their own
// top-level keys to this same response shape -- this file only covers the
// `profile` section this issue itself ships.
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

  it('includes calendar events matching the account\'s current label (best-effort, no real author FK)', async () => {
    const author = await signupBuilder('export-social-calendar-author');
    const templateId = await createTemplate('export-social-calendar-template');
    await env.DB.prepare(`
      INSERT INTO landlets (landlet_id, name, owner_builder_id, status) VALUES (?, ?, ?, 'claimed')
    `).bind('export-social-calendar-landlet', 'Export Calendar Landlet', author.builderId).run();
    await env.DB.prepare(`
      INSERT INTO placed_instances (instance_id, landlet_id, template_id, x_m, y_m, is_community_calendar)
      VALUES (?, ?, ?, 0, 0, 1)
    `).bind('export-social-calendar-instance', 'export-social-calendar-landlet', templateId).run();
    await env.DB.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text) VALUES (?, ?, ?, ?)
    `).bind('export-social-calendar-event', 'export-social-calendar-instance', author.builder.label, 'My own calendar event').run();
    await env.DB.prepare(`
      INSERT INTO calendar_events (event_id, instance_id, author_label, text) VALUES (?, ?, ?, ?)
    `).bind('export-social-calendar-event-other', 'export-social-calendar-instance', 'Someone Else', 'Not my event').run();

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

  it('keeps every social collection empty for an account with none of this activity', async () => {
    const quiet = await signupBuilder('export-social-quiet');
    const result = await api('/auth/export-data', quiet.session());
    expect(result.body.social).toMatchObject({
      friendships: [], directMessages: [], notifications: [], productReviews: [], sellerFeedback: [],
      signPosts: [], calendarEvents: [], savedLevelLayouts: [], landletVersions: [],
    });
  });
});
