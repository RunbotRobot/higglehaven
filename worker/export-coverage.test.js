// #4142 (step 2): the right-to-access export (GET /auth/export-data) must not
// silently fall behind the schema. Every table that holds a person's own data
// (a column keyed on the account, builder or seller) is either read by the
// export functions in worker/index.js or named below with the reason it is not.
// A new such table fails this test until someone decides which, so the next
// assistant-thread-sized omission is caught the day its migration lands rather
// than when a person asks for their data.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import indexSource from './index.js?raw';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Left out on purpose. The reason is the decision: change it here and in the
// export together, and say why in the PR.
const NOT_EXPORTED = {
  // Secrets and sessions: credentials are never handed back, even to their owner.
  sessions: 'login session tokens',
  email_verification_tokens: 'one-time secrets',
  password_reset_tokens: 'one-time secrets',
  // Moderation, safety and legal: the person is shown the decision and its
  // reasoning (account_moderation_decisions, #2385), never how enforcement works
  // or who reported them; legal evidence is segregated and admin-only (#3041).
  account_suspensions: 'moderation enforcement record; the decision and reasoning are exported (#2385)',
  self_dealing_flags: 'fraud-detection signal about the account',
  card_fingerprints: 'fraud signal derived from the payment card; not content the person authored',
  product_flags: 'flags are weighed invisibly; the reporter and the reviewer stay private',
  nearby_chat_reports: 'conduct reports are invisible to the reported person and to others',
  voice_conduct_reports: 'conduct reports are invisible to the reported person and to others',
  direct_message_reports: 'conduct reports are invisible to the reported person and to others',
  ncmec_reports: 'segregated legal record, admin-only (#3041)',
  ncmec_evidence: 'segregated legal record, admin-only (#3041)',
  moderation_removal_snapshots: 'moderation plumbing; the person is told of a removal when it happens',
  dispute_auto_resolve_claims: 'internal dispute bookkeeping',
  admin_action_log: 'what admins did, not data about the person',
  // Other people's data or the platform's own bookkeeping.
  assistant_shifts: 'an assistant session\'s own check-in, not a shopper\'s data',
  assistant_card_followups: 'internal hand-off to the team; the shopper\'s words are in the thread',
  assistant_contacts: 'who they spoke to and when; derivable from the exported conversations',
  owned_avatar_purchases: 'idempotency plumbing; every field is on owned_avatars (#1985)',
  owned_animation_purchases: 'idempotency plumbing; every field is on owned_animations (#1985)',
  products: 'the shared product row; a seller\'s own listings are exported as commerce.listings (catalog_templates)',
  closed_sellers: 'record of a closed seller account kept by the platform',
  builder_label_backfill_3142: 'a one-off migration table',
  // Moves with a person for a few seconds or minutes only.
  nearby_chat_messages: 'deleted after 30 minutes (NEARBY_CHAT_MESSAGE_STALE_CLEANUP_MS), so there is nothing lasting to hand back',
  avatar_presence: 'live position, replaced every few seconds',
  voice_signaling_messages: 'WebRTC handshakes, deleted within seconds',
  friend_voice_channel_members: 'membership of a live voice channel',
  // Content inside a saved layout is reached through the layout.
  saved_layout_sign_posts: 'part of a saved layout; the layout\'s own export covers the layout',
  saved_layout_calendar_events: 'part of a saved layout; the layout\'s own export covers the layout',
};

// Own data that should be in the export and is not yet. Each line is a task,
// not an excuse: remove it when the section lands (tracked on #4142).
const KNOWN_GAPS = {
  // Empty on purpose: every gap #4142 found has been closed or given a reason above.
};

// The text of one top-level async function in worker/index.js.
function functionText(name) {
  const start = indexSource.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`worker/index.js no longer defines ${name}; update export-coverage.test.js`);
  const next = indexSource.indexOf('\nasync function ', start + 20);
  return indexSource.slice(start, next < 0 ? undefined : next);
}

// A table that the export only JOINs to describe something else (catalog_templates
// describes what a person OWNS) must still be read by its own key to count.
const MUST_BE_READ_BY_OWN_KEY = {
  catalog_templates: /FROM catalog_templates\s+WHERE seller_id = \?/,
};

function exportedTables() {
  const text = ['handleExportData', 'exportCommerceData', 'exportSocialSection', 'exportCommunicationData']
    .map(functionText).join('\n');
  const found = new Set();
  for (const match of text.matchAll(/(?:FROM|JOIN)\s+([a-z_0-9]+)/g)) found.add(match[1]);
  for (const [table, ownRead] of Object.entries(MUST_BE_READ_BY_OWN_KEY)) {
    if (!ownRead.test(text)) found.delete(table);
  }
  return found;
}

// Tables with a column that names a person: the account, a builder or a seller.
async function personKeyedTables() {
  const tables = (await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
  ).all()).results.map((row) => row.name);
  const keyed = [];
  for (const name of tables) {
    const columns = (await env.DB.prepare(`PRAGMA table_info(${name})`).all()).results.map((c) => c.name);
    if (columns.some((c) => /(^|_)(user|builder|seller)_id$/.test(c))) keyed.push(name);
  }
  return keyed;
}

describe('the data export covers every table that holds a person\'s own data (#4142)', () => {
  it('reads each one, or names it with the reason it does not', async () => {
    const exported = exportedTables();
    const keyed = await personKeyedTables();
    const undecided = keyed.filter((t) => !exported.has(t) && !(t in NOT_EXPORTED) && !(t in KNOWN_GAPS));
    expect(
      undecided,
      `New table(s) holding a person's data that GET /auth/export-data does not read: ${undecided.join(', ')}. ` +
        'Export them in worker/index.js (exportCommunicationData / exportSocialSection / exportCommerceData), or add each to '
        + 'NOT_EXPORTED in worker/export-coverage.test.js with the reason.',
    ).toEqual([]);
  });

  it('keeps the two lists honest: every entry is a real table the export really does not read', async () => {
    const exported = exportedTables();
    const keyed = new Set(await personKeyedTables());
    for (const [name] of [...Object.entries(NOT_EXPORTED), ...Object.entries(KNOWN_GAPS)]) {
      expect(keyed.has(name), `${name} is listed but is not a person-keyed table (renamed or dropped?)`).toBe(true);
      expect(exported.has(name), `${name} is now exported: remove it from the not-exported lists`).toBe(false);
    }
    const both = Object.keys(NOT_EXPORTED).filter((t) => t in KNOWN_GAPS);
    expect(both).toEqual([]);
  });
});
