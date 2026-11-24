// #4142: the data export is the one place a person can ask "what does higglehaven hold about me", and
// it had fallen behind: tables added after it was written (the assistant thread, blocks) never reached it,
// and nothing noticed. This test lists every table that has a column naming a person (an account, builder
// or seller id) and fails for one that is in none of the three lists below, so the next table cannot slip by.
// Adding a table here is a decision: exported (and tested in export-data.test.js), deliberately not exported
// with the reason, or not yet decided (named on #4142 so it is on someone's list rather than forgotten).
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// In GET /auth/export-data (worker/index.js: handleExportData, exportCommerceData, exportSocialSection,
// exportAccountHelpAndBlocks).
const EXPORTED = [
  'users', 'builders', 'sellers', 'didit_verification_sessions', 'account_moderation_decisions',
  'friendships', 'direct_messages', 'notifications', 'product_reviews', 'seller_feedback', 'sign_posts',
  'calendar_events', 'saved_level_layouts', 'archived_landlet_versions', 'bundles', 'purchases',
  'owned_avatars', 'owned_animations', 'video_generation_jobs', 'higgles_redemptions',
  'higgles_earnings_events', 'tax_1099_forms', 'assistant_conversations', 'assistant_messages',
  'assistant_questions', 'user_blocks',
];

// Deliberately not exported, and why.
const NOT_EXPORTED = {
  admin_action_log: 'the admin audit trail: the acting admin is not the subject of the export',
  builder_label_backfill_3142: 'one-off migration bookkeeping',
  card_fingerprints: 'an anti-abuse signal; never shown to anyone (a probabilistic signal stays invisible)',
  dispute_auto_resolve_claims: 'internal bookkeeping for a sweep',
  email_verification_tokens: 'a credential',
  password_reset_tokens: 'a credential',
  sessions: 'a credential',
  moderation_removal_snapshots: 'moderation internals (#2385: outcome and reasoning only)',
  self_dealing_flags: 'moderation internals (#2385)',
  ncmec_evidence: 'a legal evidence store, admin-only by decision (#3041)',
  ncmec_reports: 'a legal evidence store, admin-only by decision (#3041)',
  voice_signaling_messages: 'ephemeral call set-up, gone within seconds',
  avatar_presence: 'a live position, dropped after about ten seconds',
  owned_animation_purchases: 'plumbing: every field is already on owned_animations (see exportCommerceData)',
  owned_avatar_purchases: 'plumbing: every field is already on owned_avatars (see exportCommerceData)',
  assistant_shifts: 'the assistant account\'s own working state, not a shopper\'s data',
  assistant_contacts: 'the assistant\'s own bookkeeping of who it has spoken to',
};

// Not yet decided: each is a real question for #4142 (does this belong to "what we hold about you"?).
const UNDECIDED = [
  'account_suspensions', 'assistant_card_followups', 'auction_bids', 'auctions', 'bug_reports',
  'catalog_templates', 'closed_sellers', 'commission_holds', 'credit_orbs', 'friend_voice_channel_members',
  'landlets', 'nearby_chat_messages', 'nearby_chat_reports', 'product_flags',
  'saved_layout_calendar_events', 'saved_layout_sign_posts',
  'suspended_seller_instance_snapshots', 'user_content_edit_history', 'voice_conduct_reports',
];

describe('the data export covers every table that holds a person\'s data (#4142)', () => {
  it('has a decision for every table with a person column', async () => {
    const found = await env.DB.prepare(`
      SELECT DISTINCT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' AND m.name NOT LIKE 'd1_%'
        AND (p.name = 'user_id' OR p.name LIKE '%\\_user\\_id' ESCAPE '\\'
          OR p.name = 'builder_id' OR p.name LIKE '%\\_builder\\_id' ESCAPE '\\' OR p.name = 'seller_id')
    `).all();
    const decided = new Set([...EXPORTED, ...Object.keys(NOT_EXPORTED), ...UNDECIDED]);
    const missing = found.results.map((row) => row.name).filter((name) => !decided.has(name)).sort();
    expect(missing, `tables with a person column and no export decision (add to EXPORTED, NOT_EXPORTED with a reason, or UNDECIDED): ${missing.join(', ')}`).toEqual([]);
  });

  it('names no table that does not exist, and no table twice', async () => {
    const tables = new Set((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((row) => row.name));
    const all = [...EXPORTED, ...Object.keys(NOT_EXPORTED), ...UNDECIDED];
    expect(all.filter((name) => !tables.has(name)), 'listed but not a table').toEqual([]);
    expect(all.filter((name, i) => all.indexOf(name) !== i), 'listed twice').toEqual([]);
  });
});
