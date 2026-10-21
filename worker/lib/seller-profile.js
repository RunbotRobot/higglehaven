// #2618 (leaf of #2536, itself sub-issue of #2502/#2500): the seller
// profile domain -- the /api/sellers dispatcher (handleSellers) and the
// seller- and builder-facing Stripe Connect onboarding handlers. Payouts
// and tax compliance (handleSellerPayouts/handleTax/handleTaxIdForm/
// handleBuilderRedeem) are the sibling leaf #2619 instead -- despite
// sharing getOrCreateSellerForUser/stripeAccountStatusJson with this
// module, tracing every call site showed those two groups aren't a
// single contiguous domain (see #2536's own scoping comment).
//
// sellerFromRow/getOrCreateSellerForUser/stripeAccountStatusJson stay in
// worker/index.js and are imported back here, same one-directional,
// request-time-only safe pattern #2535/#2534/#2613 already established:
// each is also used by code outside this leaf (sellerFromRow by the
// export-data handler; getOrCreateSellerForUser by index.js's own
// requireSessionSeller and by the sibling #2619 leaf;
// stripeAccountStatusJson by an unrelated admin stripe-account-reset
// branch and by the sibling #2619 leaf). BUILDER_LIST_RATE_LIMIT_MAX,
// STRIPE_ACCOUNT_RESET_RATE_LIMIT_MAX and STRIPE_RATE_LIMIT_MAX are
// duplicated locally rather than exported, per the precedent
// worker/lib/stripe.js already set for STRIPE_RATE_LIMIT_MAX -- each is
// a plain rate-limit cap shared with code that stays in index.js, not
// something worth threading an export through.
import { json, HttpError, clientIp } from './http.js';
import { checkRateLimit } from './rate-limit.js';
import { adminActionLogStatement } from './admin-log.js';
import {
  readJson, stringValue, labelValue, queryLimit, decodeCursor, encodeCursor,
} from './validation.js';
import { requireCurrentUser, requireAdmin, assertOwner } from './auth.js';
import { getOrCreateBuilderForUser } from './builder-profile.js';
import { handleSellerFeedbackList } from './reputation.js';
import {
  sellerFromRow, getOrCreateSellerForUser, stripeAccountStatusJson, stripeConfigured, stripeRequest,
  deriveStripeOnboardingStatus, requireSessionSeller, integerValue, selectRowsByIdsChunked,
  sellerDeletionStatements, handleSellerPayouts,
} from '../index.js';

const SELLER_CREATE_RATE_LIMIT_MAX = 20;
const SELLER_RENAME_RATE_LIMIT_MAX = 20;
const SELLER_DELETE_RATE_LIMIT_MAX = 20;
const BUILDER_LIST_RATE_LIMIT_MAX = 200;
const STRIPE_ACCOUNT_RESET_RATE_LIMIT_MAX = 20;
const STRIPE_RATE_LIMIT_MAX = 20;

// A genuinely separate roster from builders (see 0037_sellers.sql) —
// catalog_templates.seller_id references this table's IDs now, not a
// builder's. Simpler than handleBuilders: a seller owns no land, so
// deleting one has no ownership-release cleanup to do — it just leaves
// any of their existing templates' seller_id pointing at an ID no longer
// in the roster, the same way a template can already have a null
// seller_id for an unclaimed custom upload.
async function handleSellers(request, env, db, route, url) {
  if (request.method === 'GET' && route.length === 3 && route[2] === 'feedback') {
    return handleSellerFeedbackList(db, route[1]);
  }

  if (route.length === 3 && route[1] === 'me' && route[2] === 'stripe-account') {
    return handleSellerStripeAccount(request, env, db);
  }

  if (route.length === 3 && route[1] === 'me' && route[2] === 'payouts') {
    return handleSellerPayouts(request, env, db);
  }

  if (request.method === 'GET' && route.length === 2 && route[1] === 'me') {
    return handleMySeller(request, db);
  }

  if (request.method === 'GET' && route.length === 1) {
    // #2095: GET /api/builders's identical GET route.length===1 branch
    // above gates on this exact same check (added by #1844) before its
    // own ids/label/cursor-list sub-cases -- this branch mirrors all
    // three of those sub-cases but had never picked up the guard.
    await checkRateLimit(db, `seller-list:${clientIp(request)}`, BUILDER_LIST_RATE_LIMIT_MAX);
    // #1213: same bounded-lookup shape as GET /api/builders's ids/label
    // filters above (#717/#716) — added once a real caller (seller-lookup
    // by name) existed, mirroring that endpoint's own reasoning exactly.
    const idsParam = url.searchParams.get('ids');
    if (idsParam !== null) {
      const ids = [...new Set(idsParam.split(',').map((id) => id.trim()).filter((id) => id !== ''))];
      if (ids.length === 0) return json({ sellers: [] });
      if (ids.length > 200) throw new HttpError('ids must contain at most 200 items', 400);
      const results = await selectRowsByIdsChunked(db, 'sellers', 'seller_id', ids);
      return json({ sellers: results.map(sellerFromRow) });
    }

    // Exact (case-insensitive) label lookup, same as GET /api/builders's
    // own. Still returns every matching row, not just the first — #1219
    // enforces uniqueness going forward on create/rename (see those
    // handlers below), but doesn't retroactively guarantee it against
    // whatever already existed before that, same caveat as #1187 left for
    // builders.
    const label = url.searchParams.get('label');
    if (label) {
      const { results } = await db.prepare(
        'SELECT * FROM sellers WHERE LOWER(label) = LOWER(?) ORDER BY created_at, seller_id',
      ).bind(label).all();
      return json({ sellers: results.map(sellerFromRow) });
    }

    // #715 (sub-issue of #711): same cursor-pagination shape as
    // GET /api/builders just above — see that endpoint's own comment.
    // No frontend caller of GET /api/sellers exists today, so there's no
    // unbounded-response assumption to fix first, unlike builders.
    const limit = queryLimit(url.searchParams.get('limit'), 100);
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const conditions = [];
    const bindings = [];
    if (cursor) {
      conditions.push('(created_at > ? OR (created_at = ? AND seller_id > ?))');
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { results } = await db.prepare(`
      SELECT * FROM sellers ${where}
      ORDER BY created_at, seller_id LIMIT ?
    `).bind(...bindings, limit + 1).all();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return json({
      sellers: page.map(sellerFromRow),
      nextCursor: hasMore ? encodeCursor(last.created_at, last.seller_id) : null,
    });
  }

  if (request.method === 'POST' && route.length === 1) {
    // Unauthenticated on purpose — same reasoning as POST /api/builders
    // above: a brand-new, unlinked row, nothing to spoof.
    const input = await readJson(request);
    await checkRateLimit(db, `seller-create:${clientIp(request)}`, SELLER_CREATE_RATE_LIMIT_MAX);
    const label = labelValue(input.label, 'label');
    const sellerId = input.sellerId !== undefined
      ? stringValue(input.sellerId, 'sellerId')
      : `seller-${crypto.randomUUID()}`;
    // #1219: same case-insensitive uniqueness guard #1187 gave builders —
    // see that issue's own PR comment on POST /api/builders above for why
    // this is an app-level NOT EXISTS rather than a schema-level UNIQUE
    // index.
    const inserted = await db.prepare(`
      INSERT INTO sellers (seller_id, label)
      SELECT ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM sellers WHERE seller_id = ? OR label = ? COLLATE NOCASE)
    `).bind(sellerId, label, sellerId, label).run();
    if (inserted.meta.changes === 0) {
      // Same disambiguation idiom as POST /api/builders above — the
      // atomic guard already refused to happen, this only decides which
      // friendly message to show.
      const sellerIdTaken = await db.prepare('SELECT 1 FROM sellers WHERE seller_id = ?').bind(sellerId).first();
      if (sellerIdTaken) throw new HttpError('sellerId is already taken', 409);
      throw new HttpError('That seller name is already taken — names must be unique, ignoring case', 409);
    }
    const row = await db.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(sellerId).first();
    return json({ seller: sellerFromRow(row) }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && route.length === 2) {
    await requireSeller(db, route[1]);
    const sessionSeller = await requireSessionSeller(request, db);
    assertOwner(route[1], sessionSeller.seller_id, 'Not your seller profile');
    await checkRateLimit(db, `seller-rename:${sessionSeller.seller_id}`, SELLER_RENAME_RATE_LIMIT_MAX);
    const input = await readJson(request);
    // #479: same gap as the builder-rename fix just above — this used
    // plain stringValue (no upper bound), unlike POST /api/sellers' own
    // create path (already labelValue). Same fix shape as #337/#358.
    const label = labelValue(input.label, 'label');
    // #1219: same case-insensitive uniqueness guard as the create path
    // above (and the same shape #1187 gave builders' own rename path) —
    // excludes this seller's own current row so a case-only rename of
    // your own label isn't rejected as colliding with itself.
    const result = await db.prepare(`
      UPDATE sellers SET label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE seller_id = ? AND NOT EXISTS (SELECT 1 FROM sellers WHERE label = ? COLLATE NOCASE AND seller_id != ?)
    `).bind(label, route[1], label, route[1]).run();
    if (result.meta.changes === 0) {
      // requireSeller/assertOwner above already confirmed this seller_id
      // exists and belongs to the caller, so the only way the atomic guard
      // just above could have refused this update is the NOT EXISTS
      // failing — another seller already holds this label.
      throw new HttpError('That seller name is already taken — names must be unique, ignoring case', 409);
    }
    const updated = await requireSeller(db, route[1]);
    return json({ seller: sellerFromRow(updated) });
  }

  if (request.method === 'DELETE' && route.length === 2) {
    await requireSeller(db, route[1]);
    const sessionSeller = await requireSessionSeller(request, db);
    assertOwner(route[1], sessionSeller.seller_id, 'Not your seller profile');
    await checkRateLimit(db, `seller-delete:${sessionSeller.seller_id}`, SELLER_DELETE_RATE_LIMIT_MAX);

    // #732: getOrCreateSellerForUser looks up by user_id, not seller_id — if
    // this seller_id is deleted with real-money proceeds still unpaid, a
    // later GET /sellers/me mints a brand-new seller_id (Stripe account
    // unset) and the old seller_id's unpaid purchases become unreachable
    // through the app forever, with no record left of which Stripe account
    // the money is sitting in. Same "don't strand real money" guard the
    // builder-deletion handler above already has for auction payouts —
    // folded into the DELETE's own WHERE clause (not a separate SELECT
    // first) to close the same check-then-delete race that guard's own
    // comment calls out.
    //
    // #1148: factored into sellerDeletionStatements below so the exact same
    // guard is reused unchanged by cascadeDeleteAccount (real account
    // deletion) -- see that function's own comment.
    const { statements: sellerStatements } = await sellerDeletionStatements(db, route[1]);
    const [{ meta }] = await db.batch(sellerStatements);
    if (meta.changes === 0) {
      const stillExists = await db.prepare('SELECT seller_id FROM sellers WHERE seller_id = ?').bind(route[1]).first();
      if (!stillExists) throw new HttpError('Seller not found', 404);
      throw new HttpError("Cannot delete this seller while a real-money purchase's proceeds are still unpaid — request a payout first", 409);
    }
    return json({ deleted: true });
  }

  // #1065 (sub-issue of #1404): mechanical plumbing only, mirroring the
  // builder-side reset above handleBuilders adds — see that handler's own
  // comment for the full reasoning (why stripe_account_id otherwise never
  // clears, and why this makes no judgment call about whether reconnection
  // should be allowed).
  if (request.method === 'POST' && route.length === 3 && route[2] === 'stripe-account-reset') {
    const admin = await requireAdmin(request, db);
    await checkRateLimit(db, `stripe-account-reset:${admin.user_id}`, STRIPE_ACCOUNT_RESET_RATE_LIMIT_MAX);
    const seller = await requireSeller(db, route[1]);
    if (!seller.stripe_account_id) {
      throw new HttpError('This seller has no connected Stripe account to reset', 409);
    }
    const previousAccountId = seller.stripe_account_id;
    const nowIso = new Date().toISOString();
    // #1414: same fix as the builder-side handler above -- the UPDATE's own
    // WHERE must re-assert stripe_account_id, not just seller_id, or a
    // concurrent/retried reset (from this same stale read) can land after
    // the seller has already reconnected a brand-new account and silently
    // null that one out instead.
    const result = await db.prepare(`
      UPDATE sellers
      SET stripe_account_id = NULL, stripe_onboarding_status = 'not_started', stripe_requirements_due = NULL, stripe_updated_at = ?, updated_at = ?
      WHERE seller_id = ? AND stripe_account_id = ?
    `).bind(nowIso, nowIso, route[1], previousAccountId).run();
    if (result.meta.changes === 0) {
      throw new HttpError('This seller\'s Stripe account changed concurrently -- refetch and retry', 409);
    }
    await adminActionLogStatement(db, admin.user_id, 'stripe_account_reset', 'seller', route[1], { previousAccountId }).run();
    const updated = await requireSeller(db, route[1]);
    return json(stripeAccountStatusJson(env, updated));
  }

  return json({ error: 'Not found' }, 404);
}

async function requireSeller(db, sellerId) {
  const row = await db.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(sellerId).first();
  if (!row) throw new HttpError('Seller not found', 404);
  return row;
}

async function handleMySeller(request, db) {
  const user = await requireCurrentUser(request, db);
  const row = await getOrCreateSellerForUser(db, user);
  return json({ seller: sellerFromRow(row) });
}

function boundedIntegerValue(value, field, min, max) {
  const number = integerValue(value, field);
  if (number < min || number > max) throw new HttpError(`${field} must be between ${min} and ${max}`, 400);
  return number;
}

// Individual-only for now (the common case for a marketplace seller) —
// business_type: 'company' would need a different, larger field set
// (business name, EIN, representative/owner info) and is deliberately
// left for a fast-follow once an actual seller needs it, per #452's own
// "not in scope" note on document-verification UI.
function buildStripeIndividualParams(input, userEmail, request, productDescription = 'higglehaven marketplace seller') {
  const individual = input.individual || {};
  const externalAccount = input.externalAccount || {};
  const country = stringValue(individual.addressCountry, 'individual.addressCountry').toUpperCase();
  const ssnLast4 = stringValue(individual.ssnLast4, 'individual.ssnLast4');
  if (!/^\d{4}$/.test(ssnLast4)) throw new HttpError('individual.ssnLast4 must be exactly 4 digits', 400);

  const dobMonth = boundedIntegerValue(individual.dobMonth, 'individual.dobMonth', 1, 12);
  const dobYear = boundedIntegerValue(individual.dobYear, 'individual.dobYear', 1900, new Date().getUTCFullYear());
  // #1940: 1-31 alone accepts e.g. Feb 30 or Apr 31 -- day 0 of the
  // following month is the last real day of dobMonth (UTC avoids any
  // local-timezone shift landing on the wrong side of midnight).
  const daysInDobMonth = new Date(Date.UTC(dobYear, dobMonth, 0)).getUTCDate();
  const dobDay = boundedIntegerValue(individual.dobDay, 'individual.dobDay', 1, daysInDobMonth);

  return {
    country,
    email: userEmail,
    business_type: 'individual',
    business_profile: { product_description: productDescription },
    capabilities: { transfers: { requested: 'true' }, card_payments: { requested: 'true' } },
    individual: {
      first_name: stringValue(individual.firstName, 'individual.firstName'),
      last_name: stringValue(individual.lastName, 'individual.lastName'),
      email: userEmail,
      dob: { day: dobDay, month: dobMonth, year: dobYear },
      ssn_last_4: ssnLast4,
      address: {
        line1: stringValue(individual.addressLine1, 'individual.addressLine1'),
        city: stringValue(individual.addressCity, 'individual.addressCity'),
        state: stringValue(individual.addressState, 'individual.addressState'),
        postal_code: stringValue(individual.addressPostalCode, 'individual.addressPostalCode'),
        country,
      },
    },
    external_account: {
      object: 'bank_account',
      country,
      currency: stringValue(externalAccount.currency, 'externalAccount.currency').toLowerCase(),
      routing_number: stringValue(externalAccount.routingNumber, 'externalAccount.routingNumber'),
      account_number: stringValue(externalAccount.accountNumber, 'externalAccount.accountNumber'),
    },
    tos_acceptance: {
      date: Math.floor(Date.now() / 1000),
      ip: clientIp(request),
    },
  };
}

// GET returns the seller's current onboarding state; POST creates the
// Stripe Custom account on first submission or updates it (e.g. after
// Stripe comes back asking for more via requirements.currently_due) on
// every submission after. No KYC field (name, DOB, SSN, bank account) is
// ever persisted in our own DB — see the migration's own comment — only
// Stripe's account id and derived onboarding status are.
async function handleSellerStripeAccount(request, env, db) {
  const user = await requireCurrentUser(request, db);
  const sessionSeller = await getOrCreateSellerForUser(db, user);

  if (request.method === 'GET') {
    return json(stripeAccountStatusJson(env, sessionSeller));
  }

  if (request.method === 'POST') {
    const input = await readJson(request);
    const params = buildStripeIndividualParams(input, user.email, request);
    // #948: same placement as #839's own precedent (checkRateLimit ahead of
    // the stripeConfigured check) — this is what makes the limiter itself
    // exercisable in a test suite that never configures Stripe at all.
    await checkRateLimit(db, `stripe-account:${sessionSeller.seller_id}`, STRIPE_RATE_LIMIT_MAX);
    if (!stripeConfigured(env)) {
      throw new HttpError('Stripe payouts are not configured on this server yet.', 503);
    }

    let account;
    let createdNewAccount = false;
    if (sessionSeller.stripe_account_id) {
      // country can't be changed on an existing Stripe account.
      const { country, ...updateParams } = params;
      account = await stripeRequest(env, 'POST', `accounts/${sessionSeller.stripe_account_id}`, updateParams);
    } else {
      // #473: keyed on seller_id alone is safe here — this branch only
      // ever runs while stripe_account_id is still null, and a successful
      // create (or #474's own DB guard losing a concurrent race) means it
      // never runs again for this seller, so there's no future "genuine
      // second create" this key could wrongly dedupe against.
      account = await stripeRequest(env, 'POST', 'accounts', { type: 'custom', ...params }, `seller-account-create:${sessionSeller.seller_id}`);
      createdNewAccount = true;
    }

    const status = deriveStripeOnboardingStatus(account);
    const requirementsDue = account.requirements?.currently_due || [];
    const nowIso = new Date().toISOString();
    // Found via backlog audit (#474): two concurrent first-time submissions
    // (double-click, a retried request) both read stripe_account_id as
    // null above and both create their own real, distinct Stripe account —
    // an unconditional write here would let the loser's account id get
    // silently discarded, leaving a live Stripe account holding real KYC
    // PII that nothing in this app ever references again. Only matters
    // for first-time creation — two concurrent updates to an *existing*
    // account both target the same id, so there's no orphaning risk there.
    const result = await db.prepare(`
      UPDATE sellers
      SET stripe_account_id = ?, stripe_onboarding_status = ?, stripe_requirements_due = ?, stripe_updated_at = ?, updated_at = ?
      WHERE seller_id = ?${createdNewAccount ? ' AND stripe_account_id IS NULL' : ''}
    `).bind(account.id, status, JSON.stringify(requirementsDue), nowIso, nowIso, sessionSeller.seller_id).run();

    if (createdNewAccount && result.meta.changes === 0) {
      // Lost the race — another request's account already won. Don't leave
      // the account this request just created live and unreferenced:
      // best-effort delete it (a Custom account with no completed
      // onboarding can be deleted), then hand back the winning
      // submission's own state instead of this one's.
      // #2304: a failure here previously vanished with no trail at all --
      // logging it at least leaves an admin something to find and clean up
      // the orphaned, PII-bearing Stripe account by hand.
      await stripeRequest(env, 'DELETE', `accounts/${account.id}`).catch((error) => {
        console.error('Failed to clean up race-losing Stripe account', account.id, error);
      });
      const winner = await db.prepare('SELECT * FROM sellers WHERE seller_id = ?').bind(sessionSeller.seller_id).first();
      // #1780: changes === 0 isn't always "a winner" -- this seller's own
      // row can also just be gone (a concurrent self-delete landing before
      // the UPDATE above, while this request was still awaiting the
      // outbound Stripe create call). Falling through to
      // stripeAccountStatusJson(env, undefined) would throw a TypeError
      // dereferencing stripe_account_id, surfacing as an opaque 500
      // instead of a clean "not found" -- the Stripe account is already
      // cleaned up either way, so there's nothing left to do but report it.
      if (!winner) throw new HttpError('Seller not found', 404);
      return json(stripeAccountStatusJson(env, winner));
    }

    return json(stripeAccountStatusJson(env, {
      stripe_account_id: account.id,
      stripe_onboarding_status: status,
      stripe_requirements_due: JSON.stringify(requirementsDue),
      stripe_updated_at: nowIso,
    }));
  }

  return json({ error: 'Not found' }, 404);
}

// #624 (sub-issue of #349/#324): a builder's own Stripe Connect Custom
// account, so higgles-redeemed cash (#625) has somewhere real to land —
// same shape as handleSellerStripeAccount just above (same Custom-account
// create/update/status flow, same #473/#474 race guard on first-time
// creation), against the builders table instead of sellers. productDescription
// distinguishes the two roles in Stripe's own dashboard/compliance view
// only — nothing here is seller-specific in practice.
async function handleBuilderStripeAccount(request, env, db) {
  const user = await requireCurrentUser(request, db);
  const sessionBuilder = await getOrCreateBuilderForUser(db, user);

  if (request.method === 'GET') {
    return json(stripeAccountStatusJson(env, sessionBuilder));
  }

  if (request.method === 'POST') {
    const input = await readJson(request);
    const params = buildStripeIndividualParams(input, user.email, request, 'higglehaven marketplace builder');
    // #948: same placement as #839's own precedent — see the seller-account
    // handler's own comment above.
    await checkRateLimit(db, `stripe-account:${sessionBuilder.builder_id}`, STRIPE_RATE_LIMIT_MAX);
    if (!stripeConfigured(env)) {
      throw new HttpError('Stripe payouts are not configured on this server yet.', 503);
    }

    let account;
    let createdNewAccount = false;
    if (sessionBuilder.stripe_account_id) {
      const { country, ...updateParams } = params;
      account = await stripeRequest(env, 'POST', `accounts/${sessionBuilder.stripe_account_id}`, updateParams);
    } else {
      account = await stripeRequest(env, 'POST', 'accounts', { type: 'custom', ...params }, `builder-account-create:${sessionBuilder.builder_id}`);
      createdNewAccount = true;
    }

    const status = deriveStripeOnboardingStatus(account);
    const requirementsDue = account.requirements?.currently_due || [];
    const nowIso = new Date().toISOString();
    const result = await db.prepare(`
      UPDATE builders
      SET stripe_account_id = ?, stripe_onboarding_status = ?, stripe_requirements_due = ?, stripe_updated_at = ?, updated_at = ?
      WHERE builder_id = ?${createdNewAccount ? ' AND stripe_account_id IS NULL' : ''}
    `).bind(account.id, status, JSON.stringify(requirementsDue), nowIso, nowIso, sessionBuilder.builder_id).run();

    if (createdNewAccount && result.meta.changes === 0) {
      // #2304: same logging gap as the seller sibling above.
      await stripeRequest(env, 'DELETE', `accounts/${account.id}`).catch((error) => {
        console.error('Failed to clean up race-losing Stripe account', account.id, error);
      });
      const winner = await db.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(sessionBuilder.builder_id).first();
      // #1780: same "a concurrent self-delete, not just a race loser" gap
      // as the seller sibling above.
      if (!winner) throw new HttpError('Builder not found', 404);
      return json(stripeAccountStatusJson(env, winner));
    }

    return json(stripeAccountStatusJson(env, {
      stripe_account_id: account.id,
      stripe_onboarding_status: status,
      stripe_requirements_due: JSON.stringify(requirementsDue),
      stripe_updated_at: nowIso,
    }));
  }

  return json({ error: 'Not found' }, 404);
}

export { handleSellers, handleMySeller, handleSellerStripeAccount, handleBuilderStripeAccount };
