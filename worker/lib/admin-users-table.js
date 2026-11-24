// #4060: the admin dashboard's table of users. One admin-only request returns every user (capped), and
// the page sorts, filters and chooses columns itself ("the simple build": the owner has a handful of
// accounts today; paging is its own issue when the count nears the cap, not before).
//
// A fixed number of queries whatever the user count (D1 free tier): the users rows with their one-to-one
// joins, then a few grouped counts joined to the rows here in the Worker.
//
// Never returned, in any form: password_hash, tax_id_encrypted (only whether one is on file), session
// tokens (only how many are open), anything from a KYC form. Every field below has an honest source in
// the schema; a field without one is left out rather than approximated.
import { json } from './http.js';
import { requireAdmin } from './auth.js';
import { isAssistantUsername } from './fleet-agents.js';

export const ADMIN_USERS_LIMIT = 1000;

// The column definitions are the one list the page draws from: key, label, group, kind (text, yes/no,
// number, money in cents, date, choice), whether it shows by default, and a title that says where the
// value comes from when that is not obvious.
export const ADMIN_USER_COLUMNS = [
  { key: 'username', label: 'Username', group: 'Account', kind: 'text', default: true },
  { key: 'email', label: 'Email', group: 'Account', kind: 'text', default: true },
  { key: 'userId', label: 'Account id', group: 'Account', kind: 'text' },
  { key: 'kind', label: 'Kind', group: 'Account', kind: 'choice', default: true, title: 'Person, fleet account, assistant or admin' },
  { key: 'createdAt', label: 'Created', group: 'Account', kind: 'date', default: true },
  { key: 'emailVerifiedAt', label: 'Email verified', group: 'Account', kind: 'date', default: true },
  { key: 'ageAttestedAt', label: 'Age attested', group: 'Account', kind: 'date' },
  { key: 'trustTier', label: 'Trust tier', group: 'Account', kind: 'choice', default: true },
  { key: 'idVerified', label: 'ID verified', group: 'Account', kind: 'bool', title: 'Trust tier is id_verified' },
  { key: 'lockedUntil', label: 'Locked until', group: 'Account', kind: 'date', title: 'Sign-in lock after repeated failures' },
  { key: 'failedLoginAttempts', label: 'Failed sign-ins', group: 'Account', kind: 'number' },
  { key: 'deletedAt', label: 'Deleted', group: 'Account', kind: 'date' },
  { key: 'updatedAt', label: 'Last changed', group: 'Account', kind: 'date', title: 'When the account row last changed' },
  { key: 'cardFunding', label: 'Card type on file', group: 'Account', kind: 'choice' },
  { key: 'cardRefusalCount', label: 'Card refusals', group: 'Account', kind: 'number' },
  { key: 'cardRefusalCode', label: 'Last card refusal code', group: 'Account', kind: 'text' },
  { key: 'cardRefusalAt', label: 'Last card refusal', group: 'Account', kind: 'date' },
  { key: 'taxFormType', label: 'Tax form', group: 'Account', kind: 'choice' },
  { key: 'taxFormCompletedAt', label: 'Tax form completed', group: 'Account', kind: 'date' },
  { key: 'taxIdOnFile', label: 'Tax id on file', group: 'Account', kind: 'bool', title: 'Yes or no only; the id itself is never sent' },
  { key: 'loadingTipsOff', label: 'Loading tips off', group: 'Account', kind: 'bool' },
  { key: 'firstHintsDone', label: 'First hints done', group: 'Account', kind: 'text' },
  { key: 'antiAbuseCheckFailedAt', label: 'Anti-abuse check failed', group: 'Account', kind: 'date', title: 'An admin-only signal; it changes nothing for the person' },

  { key: 'lastSeenAt', label: 'Last seen', group: 'Activity', kind: 'date', default: true, title: 'Latest of: builder activity, avatar presence, latest sign-in' },
  { key: 'sessionsOpen', label: 'Sessions open now', group: 'Activity', kind: 'number' },

  { key: 'hasBuilder', label: 'Builder profile', group: 'Building', kind: 'bool' },
  { key: 'landletsClaimed', label: 'Lándlets claimed', group: 'Building', kind: 'number', default: true },
  { key: 'itemsPlaced', label: 'Items placed', group: 'Building', kind: 'number', title: 'Items placed on lándlets this person owns' },
  { key: 'versionsPublished', label: 'Published versions', group: 'Building', kind: 'number' },
  { key: 'higglesBalanceCents', label: 'Higgles balance', group: 'Building', kind: 'money', default: true },
  { key: 'higglesEarnedCents', label: 'Higgles earned, all time', group: 'Building', kind: 'money' },

  { key: 'hasSeller', label: 'Seller profile', group: 'Selling', kind: 'bool' },
  { key: 'storefrontName', label: 'Storefront name', group: 'Selling', kind: 'text' },
  { key: 'productsListed', label: 'Products listed', group: 'Selling', kind: 'number', default: true, title: 'Not delisted' },
  { key: 'unitsSold', label: 'Units sold', group: 'Selling', kind: 'number', title: 'Excluding fully refunded orders' },
  { key: 'grossSalesCents', label: 'Gross sales', group: 'Selling', kind: 'money', title: 'Order totals less refunds' },
  { key: 'payoutsState', label: 'Payouts set up', group: 'Selling', kind: 'choice', title: 'The payment provider account state, in plain words' },
  { key: 'suspended', label: 'Suspended', group: 'Selling', kind: 'bool', default: true, title: 'An active, not lifted or escalated, suspension' },

  { key: 'ordersCount', label: 'Orders', group: 'Buying', kind: 'number', default: true },
  { key: 'totalSpentCents', label: 'Total spent', group: 'Buying', kind: 'money', title: 'Order totals less refunds' },
  { key: 'lastOrderAt', label: 'Last order', group: 'Buying', kind: 'date' },
  { key: 'avatarsOwned', label: 'Avatars owned', group: 'Buying', kind: 'number' },

  { key: 'friendsCount', label: 'Friends', group: 'People', kind: 'number' },
  { key: 'pendingRequests', label: 'Pending friend requests', group: 'People', kind: 'number', title: 'Waiting for this person to answer' },
  { key: 'blocksMade', label: 'Blocks made', group: 'People', kind: 'number', title: 'A count only' },
  { key: 'reportsReceived', label: 'Conduct reports received', group: 'People', kind: 'number', title: 'Nearby chat and voice' },
  { key: 'reportsMade', label: 'Conduct reports made', group: 'People', kind: 'number', title: 'Nearby chat and voice' },
  { key: 'strikes', label: 'Seller strikes', group: 'People', kind: 'number' },

  { key: 'hasAssistantThread', label: 'Has an assistant thread', group: 'Help', kind: 'bool' },
  { key: 'lastAssistantMessageAt', label: 'Last assistant message', group: 'Help', kind: 'date' },
];

function payoutsStateWords(status) {
  if (status === null || status === undefined) return null;
  if (status === 'complete') return 'Set up';
  if (status === 'not_started' || status === '') return 'Not started';
  return 'In progress';
}

function kindOf(row) {
  if (row.is_admin === 1) return 'Admin';
  if (row.is_fleet === 1) return isAssistantUsername(row.username) ? 'Assistant' : 'Fleet account';
  return 'Person';
}

// Counts keyed by id from a `SELECT key, ... GROUP BY key` result.
function byKey(results, keyField = 'k') {
  const map = new Map();
  for (const row of results) map.set(row[keyField], row);
  return map;
}

export async function handleAdminUsers(request, db) {
  await requireAdmin(request, db);
  const nowIso = new Date().toISOString();
  const users = (await db.prepare(`
    SELECT users.user_id, users.email, users.username, users.email_verified_at, users.failed_login_attempts,
      users.locked_until, users.created_at, users.updated_at, users.is_admin, users.is_fleet,
      users.age_attested_at, users.trust_tier, users.card_funding, users.tax_form_type,
      users.tax_form_completed_at, users.tax_id_encrypted IS NOT NULL AND users.tax_id_encrypted != '' AS tax_id_on_file,
      users.deleted_at, users.turnstile_failed_at, users.card_refusal_code, users.card_refusal_at,
      users.card_refusal_count, users.loading_tips_off, users.first_hints_done,
      builders.builder_id, builders.higgles_balance_cents, builders.last_active_at,
      sellers.seller_id, sellers.label AS seller_label, sellers.stripe_onboarding_status, sellers.strike_count,
      avatar_presence.updated_at AS presence_at,
      (SELECT count(*) FROM sessions s WHERE s.user_id = users.user_id AND s.expires_at > ?1) AS sessions_open,
      (SELECT max(created_at) FROM sessions s WHERE s.user_id = users.user_id) AS last_sign_in_at,
      EXISTS (SELECT 1 FROM account_suspensions a WHERE a.user_id = users.user_id
        AND a.lifted_at IS NULL AND a.escalated_at IS NULL) AS suspended
    FROM users
    LEFT JOIN builders ON builders.user_id = users.user_id
    LEFT JOIN sellers ON sellers.user_id = users.user_id
    LEFT JOIN avatar_presence ON avatar_presence.user_id = users.user_id
    ORDER BY users.created_at DESC
    LIMIT ?2
  `).bind(nowIso, ADMIN_USERS_LIMIT).all()).results;
  const total = (await db.prepare('SELECT count(*) AS n FROM users').first()).n;

  const [landlets, items, versions, earned, listed, sold, bought, avatars, friends, pending, blocks, repRecv, repMade, threads] = await Promise.all([
    db.prepare(`SELECT owner_builder_id AS k, count(*) AS n FROM landlets WHERE status = 'claimed' AND owner_builder_id IS NOT NULL GROUP BY owner_builder_id`).all(),
    db.prepare(`SELECT landlets.owner_builder_id AS k, count(*) AS n FROM placed_instances
      JOIN landlets ON landlets.landlet_id = placed_instances.landlet_id
      WHERE landlets.owner_builder_id IS NOT NULL GROUP BY landlets.owner_builder_id`).all(),
    db.prepare(`SELECT landlets.owner_builder_id AS k, count(*) AS n FROM landlet_versions
      JOIN landlets ON landlets.landlet_id = landlet_versions.landlet_id
      WHERE landlets.owner_builder_id IS NOT NULL GROUP BY landlets.owner_builder_id`).all(),
    db.prepare('SELECT builder_id AS k, sum(amount_cents) AS n FROM higgles_earnings_events GROUP BY builder_id').all(),
    db.prepare('SELECT seller_id AS k, count(*) AS n FROM catalog_templates WHERE delisted_at IS NULL AND seller_id IS NOT NULL GROUP BY seller_id').all(),
    db.prepare(`SELECT seller_user_id AS k, sum(CASE WHEN refunded_amount_cents >= total_cents THEN 0 ELSE quantity END) AS units, sum(total_cents - refunded_amount_cents) AS gross FROM purchases
      WHERE seller_user_id IS NOT NULL GROUP BY seller_user_id`).all(),
    db.prepare(`SELECT buyer_user_id AS k, count(*) AS n, sum(total_cents - refunded_amount_cents) AS spent, max(created_at) AS last_at
      FROM purchases WHERE buyer_user_id IS NOT NULL GROUP BY buyer_user_id`).all(),
    db.prepare('SELECT builder_id AS k, count(*) AS n FROM owned_avatars GROUP BY builder_id').all(),
    db.prepare(`SELECT u AS k, count(*) AS n FROM (
        SELECT requester_user_id AS u FROM friendships WHERE status = 'accepted'
        UNION ALL SELECT recipient_user_id AS u FROM friendships WHERE status = 'accepted'
      ) WHERE u IS NOT NULL GROUP BY u`).all(),
    db.prepare(`SELECT recipient_user_id AS k, count(*) AS n FROM friendships WHERE status = 'pending' AND recipient_user_id IS NOT NULL GROUP BY recipient_user_id`).all(),
    db.prepare('SELECT blocker_user_id AS k, count(*) AS n FROM user_blocks GROUP BY blocker_user_id').all(),
    db.prepare(`SELECT u AS k, count(*) AS n FROM (
        SELECT reported_user_id AS u FROM nearby_chat_reports UNION ALL SELECT reported_user_id AS u FROM voice_conduct_reports UNION ALL SELECT reported_user_id AS u FROM direct_message_reports
      ) WHERE u IS NOT NULL GROUP BY u`).all(),
    db.prepare(`SELECT u AS k, count(*) AS n FROM (
        SELECT reporter_user_id AS u FROM nearby_chat_reports UNION ALL SELECT reporter_user_id AS u FROM voice_conduct_reports UNION ALL SELECT reporter_user_id AS u FROM direct_message_reports
      ) WHERE u IS NOT NULL GROUP BY u`).all(),
    db.prepare(`SELECT assistant_conversations.shopper_user_id AS k, max(assistant_messages.created_at) AS last_at
      FROM assistant_conversations LEFT JOIN assistant_messages ON assistant_messages.conversation_id = assistant_conversations.conversation_id
      GROUP BY assistant_conversations.shopper_user_id`).all(),
  ]);
  const m = {
    landlets: byKey(landlets.results), items: byKey(items.results), versions: byKey(versions.results),
    earned: byKey(earned.results), listed: byKey(listed.results), sold: byKey(sold.results), bought: byKey(bought.results),
    avatars: byKey(avatars.results), friends: byKey(friends.results), pending: byKey(pending.results),
    blocks: byKey(blocks.results), repRecv: byKey(repRecv.results), repMade: byKey(repMade.results), threads: byKey(threads.results),
  };
  const num = (map, key, field = 'n') => (key == null ? 0 : (map.get(key)?.[field] ?? 0));
  const latest = (...values) => values.filter(Boolean).sort().pop() ?? null;

  return json({
    columns: ADMIN_USER_COLUMNS,
    limit: ADMIN_USERS_LIMIT,
    total,
    truncated: total > users.length,
    users: users.map((row) => {
      const hasBuilder = row.builder_id !== null;
      const hasSeller = row.seller_id !== null;
      const thread = m.threads.get(row.user_id);
      return {
        userId: row.user_id,
        username: row.username,
        email: row.email,
        kind: kindOf(row),
        createdAt: row.created_at,
        emailVerifiedAt: row.email_verified_at,
        ageAttestedAt: row.age_attested_at,
        trustTier: row.trust_tier,
        idVerified: row.trust_tier === 'id_verified',
        lockedUntil: row.locked_until,
        failedLoginAttempts: row.failed_login_attempts,
        deletedAt: row.deleted_at,
        updatedAt: row.updated_at,
        cardFunding: row.card_funding,
        cardRefusalCount: row.card_refusal_count ?? 0,
        cardRefusalCode: row.card_refusal_code,
        cardRefusalAt: row.card_refusal_at,
        taxFormType: row.tax_form_type,
        taxFormCompletedAt: row.tax_form_completed_at,
        taxIdOnFile: row.tax_id_on_file === 1,
        loadingTipsOff: row.loading_tips_off === 1,
        firstHintsDone: row.first_hints_done,
        antiAbuseCheckFailedAt: row.turnstile_failed_at,
        lastSeenAt: latest(row.last_active_at, row.presence_at, row.last_sign_in_at),
        sessionsOpen: row.sessions_open,
        hasBuilder,
        landletsClaimed: hasBuilder ? num(m.landlets, row.builder_id) : 0,
        itemsPlaced: hasBuilder ? num(m.items, row.builder_id) : 0,
        versionsPublished: hasBuilder ? num(m.versions, row.builder_id) : 0,
        higglesBalanceCents: hasBuilder ? row.higgles_balance_cents : null,
        higglesEarnedCents: hasBuilder ? num(m.earned, row.builder_id) : null,
        hasSeller,
        storefrontName: hasSeller ? row.seller_label : null,
        productsListed: hasSeller ? num(m.listed, row.seller_id) : 0,
        unitsSold: num(m.sold, row.user_id, 'units'),
        grossSalesCents: num(m.sold, row.user_id, 'gross'),
        payoutsState: hasSeller ? payoutsStateWords(row.stripe_onboarding_status) : null,
        suspended: row.suspended === 1,
        ordersCount: num(m.bought, row.user_id),
        totalSpentCents: num(m.bought, row.user_id, 'spent'),
        lastOrderAt: m.bought.get(row.user_id)?.last_at ?? null,
        avatarsOwned: hasBuilder ? num(m.avatars, row.builder_id) : 0,
        friendsCount: num(m.friends, row.user_id),
        pendingRequests: num(m.pending, row.user_id),
        blocksMade: num(m.blocks, row.user_id),
        reportsReceived: num(m.repRecv, row.user_id),
        reportsMade: num(m.repMade, row.user_id),
        strikes: hasSeller ? (row.strike_count ?? 0) : 0,
        hasAssistantThread: Boolean(thread),
        lastAssistantMessageAt: thread?.last_at ?? null,
      };
    }),
  });
}
