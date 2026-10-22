// #2535: the builder-profile domain -- a builder's own row/profile shape,
// plus the account-scoped "my own avatar/animation/notification-prefs/
// low-stock" endpoints that read or mutate it. Extracted verbatim from
// worker/index.js, zero behavior change (sub-issue of #2502, itself
// sub-issue of #2500's worker/index.js module split).
//
// handleBuilders itself (the /api/builders dispatcher) stays in
// worker/index.js rather than moving here: it also routes to
// handleBuilderStripeAccount/handleBuilderRedeem/handleListSavedLayouts,
// which belong to other, not-yet-landed #2502 leaves (seller/Stripe,
// saved layouts) -- moving handleBuilders here would mean this module
// importing those back from worker/index.js while worker/index.js also
// imports from here, a real circular dependency on top of the one below.
// worker/index.js imports everything this file exports instead, the same
// one-directional shape #2501/#2528 already established.
//
// templateFromRow/recomputeLandCap are imported back from worker/index.js
// below -- they're catalog/land domain, not builder-profile, and
// genuinely shared well beyond this file (catalog search/pricing,
// land-cap recompute across many handlers). This is a real circular
// module graph (worker/index.js <-> this file), but a safe one: every
// name on both sides is only read inside an async handler function
// invoked at request time, never at module-evaluation time, so the cycle
// resolves correctly under ES module live bindings (confirmed via the
// full build + test suite, both unit and e2e). Once catalog/land get
// their own #2502 leaves, these two imports would point at those modules
// instead and the cycle disappears on its own -- not something to fix
// now.
import { json, HttpError } from './http.js';
import { readJson, labelValue } from './validation.js';
import { checkRateLimit } from './rate-limit.js';
import { requireCurrentUser } from './auth.js';
import { templateFromRow, recomputeLandCap } from '../index.js';

// #1978 (worker/index.js's own copy, which can't be exported from there --
// workerd requires every named export of the main Worker entry module to
// be a function/class binding, confirmed the hard way when exporting this
// as a plain const broke `wrangler dev` outright): D1 caps a single query
// at 100 bound parameters. Duplicated here rather than imported since
// it's an immutable platform limit, not application state.
const D1_MAX_BOUND_PARAMETERS = 100;

async function requireBuilder(db, builderId) {
  const row = await db.prepare('SELECT * FROM builders WHERE builder_id = ?').bind(builderId).first();
  if (!row) throw new HttpError('Builder not found', 404);
  return row;
}

// #807: the subset of builderFromRow safe to hand back for a lookup that
// isn't scoped to the caller's own account — GET /api/builders and its
// ?ids=/?label= variants (used by the "Add friend" name lookup, the Shop
// mode owner-label map, and the auction bid-history label map), none of
// which call requireCurrentUser. landCapM2/ownedAreaM2 stay in this public
// shape (unlike higglesBalanceCents) since landlet ownership and its cap
// are already visible to any Shop-mode visitor by design — only the real
// money balance is the sensitive field here.
function publicBuilderFromRow(row) {
  return {
    builderId: row.builder_id,
    label: row.label,
    // Land cap (docs/SPEC.md §3, migrations/0050) — how much total lándlet
    // area this builder may own at once, distinct from higglesBalanceCents
    // (which land-specific lándlets can be acquired via auction).
    landCapM2: row.land_cap_m2,
    // The real total currently counted against that cap — ground-level
    // landlet area plus every level's own cap_consumed_m2 (docs/API.md's
    // "Vertical construction"), the same sum recomputeLandCap/
    // recomputeLandCapsBatch already compute internally to grow landCapM2
    // itself. Only present (non-null) on a row that just went through one
    // of those — GET /api/builders and GET /api/builders/me both do; a
    // plain create/rename response doesn't recompute anything, so stays
    // null rather than a stale or misleadingly-precise-looking number.
    ownedAreaM2: row.owned_area_m2 ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function builderFromRow(row) {
  return {
    ...publicBuilderFromRow(row),
    // Land acquisition auctions (docs/SPEC.md §5, migrations/0045) — a
    // real, persisted ledger credited when this builder sells a landlet
    // via auction. See migrations/0045's own note on why bidding itself
    // isn't gated by having a sufficient balance yet. A real Stripe-
    // redeemable balance (handleBuilderRedeem) — never include this in a
    // shape returned from an unauthenticated or cross-account lookup (#807:
    // it was leaking through GET /api/builders and its ids/label variants,
    // none of which are gated on the caller owning the row).
    higglesBalanceCents: row.higgles_balance_cents,
    // #2067: own-account-only, same reasoning as higglesBalanceCents above
    // -- a communication preference has no reason to leak through a
    // cross-account lookup either.
    notifySoldOutEmail: !!row.notify_sold_out_email,
    // #2442: own-account-only, same reasoning as higglesBalanceCents above
    // -- this balance (migrations/0127) was never surfaced anywhere in the
    // response shape at all, so the Upload Model modal had nothing to read
    // to show a builder how many free video-to-3D generations they have
    // left before they actually attempt one.
    videoGenerationCredits: row.video_generation_credits,
  };
}

// Real accounts (migrations/0054_link_builders_sellers_to_users.sql) — the
// builder profile behind the current session, auto-provisioned if somehow
// missing. Every account already gets one at signup (see handleSignup,
// docs/SPEC.md §3's "every user is automatically a builder"); the
// get-or-create here is a defensive fallback for that invariant, not the
// primary way a builder profile comes to exist, so this should really
// only ever hit the "already exists" path in practice. 401 with no
// session (requireCurrentUser); never a 404 either way.
export async function getOrCreateBuilderForUser(db, user) {
  // #946: INSERT OR IGNORE + unconditional re-read (mirroring
  // ownedAvatarStatement below) rather than SELECT-then-conditionally-
  // INSERT — the latter raced two concurrent requests for the same
  // account's builder profile against the partial UNIQUE INDEX on
  // builders.user_id (migrations/0054), surfacing to the loser as a
  // confusing 409 instead of a clean idempotent get-or-create.
  const builderId = `builder-${crypto.randomUUID()}`;
  await db.prepare('INSERT OR IGNORE INTO builders (builder_id, label, user_id) VALUES (?, ?, ?)')
    .bind(builderId, user.username, user.user_id).run();
  const row = await db.prepare('SELECT * FROM builders WHERE user_id = ?').bind(user.user_id).first();
  // #336/#325: keeps a real "was this builder recently active" signal
  // fresh — see migrations/0067's own comment for why neither of this
  // table's existing timestamps works for that. Bumped here (every
  // caller resolves "my builder profile," whether that's to mutate
  // something or just to load it on entering a mode) rather than only in
  // requireSessionBuilder, per the owner's #325 decision: "I'm inclined
  // to count any login as activity — even if only logging in for
  // shopping or selling." Every one of this function's own callers is
  // already an authenticated request by definition (requireCurrentUser
  // already ran), so there's nothing further to gate this on.
  // #783: inactivity_warning_sent_at (migrations/0109) is re-armed to
  // NULL in this same statement — real activity ends the current
  // inactivity cycle, so warnInactiveLandletOwners should be free to warn
  // again the next time this builder goes quiet, rather than staying
  // permanently silenced by a warning from a previous cycle.
  await db.prepare(
    `UPDATE builders SET last_active_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), inactivity_warning_sent_at = NULL WHERE builder_id = ?`,
  ).bind(row.builder_id).run();
  return row;
}

export async function handleMyBuilder(request, db) {
  const user = await requireCurrentUser(request, db);
  const row = await getOrCreateBuilderForUser(db, user);
  const { nextCap, ownedAreaM2 } = await recomputeLandCap(db, row.builder_id);
  row.land_cap_m2 = nextCap;
  row.owned_area_m2 = ownedAreaM2;
  return json({ builder: builderFromRow(row) });
}

// #680 (sub-issue of #679, N53): every "avatar"-category catalog template
// this account currently owns (owned_avatars, migrations/0083) — for a
// future picker UI to offer, independent of which one (if any) is
// currently equipped. Same requireCurrentUser-only bar as
// handleBuilderStripeAccount/handleBuilderRedeem just below (not the
// full requireSessionBuilder/assertVerified gate) — reading your own
// purchase history isn't a world/shop-selling action N44 was aimed at.
export async function handleMyOwnedAvatars(request, db) {
  const user = await requireCurrentUser(request, db);
  const builder = await getOrCreateBuilderForUser(db, user);
  const { results } = await db.prepare(`
    SELECT catalog_templates.*, owned_avatars.purchased_at AS owned_purchased_at
    FROM owned_avatars
    JOIN catalog_templates ON catalog_templates.template_id = owned_avatars.template_id
    WHERE owned_avatars.builder_id = ?
    ORDER BY owned_avatars.purchased_at DESC
  `).bind(builder.builder_id).all();
  return json({
    avatars: results.map((row) => ({ ...templateFromRow(row), purchasedAt: row.owned_purchased_at })),
  });
}

// #1057: PUT below had no rate limit at all, unlike every comparable
// authenticated mutation resource in this file (BUNDLE_MUTATE_RATE_LIMIT_MAX
// #892, FRIENDSHIP_MUTATE_RATE_LIMIT_MAX #899, and others) — #680 never got
// the equivalent when it introduced this endpoint.
const AVATAR_EQUIP_RATE_LIMIT_MAX = 20;

// #680: which owned avatar (if any) this account currently has equipped
// as their own in-world character. GET returns the current choice (null
// means today's hardcoded default — see createShopAvatar in src/main.js
// and #679's own "assigned instantly at registration" note, unaffected
// either way). PUT changes it, rejecting anything not already present in
// owned_avatars so equipping is only ever "pick one you've already paid
// for," never a way to wear an arbitrary unbought template.
export async function handleMyAvatar(request, db) {
  const user = await requireCurrentUser(request, db);
  const builder = await getOrCreateBuilderForUser(db, user);

  if (request.method === 'GET') {
    return json({ avatar: await myAvatarJson(db, builder) });
  }

  if (request.method === 'PUT') {
    await checkRateLimit(db, `avatar-equip:${builder.builder_id}`, AVATAR_EQUIP_RATE_LIMIT_MAX);
    const input = await readJson(request);
    let templateId = null;
    if (input.templateId !== null && input.templateId !== undefined) {
      templateId = labelValue(input.templateId, 'templateId');
      // Eager check for a clear 403 in the common case — the atomic guard
      // folded into the UPDATE's own WHERE clause below is the real race
      // guard (#801): without it, a refund's owned_avatars revocation
      // landing between this SELECT and the UPDATE could still let this
      // request equip an item that was just revoked out from under it,
      // same non-atomic-check-then-write class of bug this file guards
      // against elsewhere (e.g. the refund's own conditional UPDATE).
      const owned = await db.prepare(
        'SELECT 1 FROM owned_avatars WHERE builder_id = ? AND template_id = ?',
      ).bind(builder.builder_id, templateId).first();
      if (!owned) throw new HttpError('You do not own this avatar', 403);
    }
    const result = await db.prepare(`
      UPDATE builders SET equipped_avatar_template_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE builder_id = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM owned_avatars WHERE builder_id = ? AND template_id = ?))
    `).bind(templateId, builder.builder_id, templateId, builder.builder_id, templateId).run();
    if (result.meta.changes === 0) {
      throw new HttpError('You do not own this avatar', 403);
    }
    const updated = await requireBuilder(db, builder.builder_id);
    return json({ avatar: await myAvatarJson(db, updated) });
  }

  return json({ error: 'Not found' }, 404);
}

async function myAvatarJson(db, builder) {
  if (!builder.equipped_avatar_template_id) {
    return { equippedTemplateId: null, modelUrl: null, skeletonSignature: null };
  }
  // A template can vanish after being equipped (its seller later deletes
  // it) — falls back to the default the same way a dangling seller_id/
  // templateId elsewhere in this app already does, rather than erroring.
  const template = await db.prepare(
    'SELECT model_url, skeleton_signature FROM catalog_templates WHERE template_id = ?',
  ).bind(builder.equipped_avatar_template_id).first();
  return {
    equippedTemplateId: template ? builder.equipped_avatar_template_id : null,
    modelUrl: template?.model_url || null,
    // #1164 (sub-issue of #1161): the equipped avatar's own skeleton
    // signature (#1162), so the shop/equip UI can compare it against a
    // purchasable/owned animation's own signature for compatibility
    // without a second round trip. null for the default procedural avatar
    // (no equipped template at all) or a custom avatar with no skeleton —
    // either way, nothing for an animation to ever compare equal to.
    skeletonSignature: template?.skeleton_signature || null,
  };
}

// #2103: PUT below had no rate limit at all, unlike handleMyAvatar's own
// PUT (AVATAR_EQUIP_RATE_LIMIT_MAX #1057) -- this function's own comment
// already says it mirrors that handler's shape exactly, but never got the
// rate limit that shape calls for.
const NOTIFICATION_PREFERENCES_RATE_LIMIT_MAX = 20;

// #2067 (leaf sub-issue of #1973, part of #1947): GET/PUT this account's
// sold-out-email opt-in, same requireCurrentUser-only bar and GET/PUT
// shape as handleMyAvatar above -- a communication preference isn't a
// world/shop-selling action N44 was aimed at either.
export async function handleMyNotificationPreferences(request, db) {
  const user = await requireCurrentUser(request, db);
  const builder = await getOrCreateBuilderForUser(db, user);

  if (request.method === 'GET') {
    return json({ notifySoldOutEmail: !!builder.notify_sold_out_email });
  }

  if (request.method === 'PUT') {
    await checkRateLimit(db, `notification-preferences:${builder.builder_id}`, NOTIFICATION_PREFERENCES_RATE_LIMIT_MAX);
    const input = await readJson(request);
    if (typeof input.notifySoldOutEmail !== 'boolean') {
      throw new HttpError('notifySoldOutEmail must be a boolean', 400);
    }
    await db.prepare(`
      UPDATE builders SET notify_sold_out_email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE builder_id = ?
    `).bind(input.notifySoldOutEmail ? 1 : 0, builder.builder_id).run();
    return json({ notifySoldOutEmail: input.notifySoldOutEmail });
  }

  return json({ error: 'Not found' }, 404);
}

// #1164 (sub-issue of #1161): every "animation"-category template this
// account currently owns (owned_animations, migration 0106), mirroring
// handleMyOwnedAvatars above exactly.
export async function handleMyOwnedAnimations(request, db) {
  const user = await requireCurrentUser(request, db);
  const builder = await getOrCreateBuilderForUser(db, user);
  const { results } = await db.prepare(`
    SELECT catalog_templates.*, owned_animations.purchased_at AS owned_purchased_at
    FROM owned_animations
    JOIN catalog_templates ON catalog_templates.template_id = owned_animations.template_id
    WHERE owned_animations.builder_id = ?
    ORDER BY owned_animations.purchased_at DESC
  `).bind(builder.builder_id).all();
  return json({
    animations: results.map((row) => ({ ...templateFromRow(row), purchasedAt: row.owned_purchased_at })),
  });
}

// #1949 (sub-issue of #1947): a builder-facing view of every template they
// currently have placed that carries finite stock (#1948's own
// stock_quantity column), each annotated with an estimated days-remaining
// figure -- lets a builder weigh which of their own placed products are at
// risk of selling out and disappearing from their land (per #1947's own
// framing, that's expected, normal behavior, not a bug to prevent).
//
// Owner guidance (direct conversation, 2026-10-13, captured on issue #1949
// itself): no fixed trailing window -- "please have the assigned session
// use its best judgment, probably using a more dynamic calculation rather
// than a static 30-days, particularly for new products. It could be
// beneficial to look at how quickly similar products have sold." A
// one-of-a-kind item (stockQuantity === 1) is a single sale event, not a
// queue being drawn down, so "for single-quantity items, the builder should
// understand that it's going to be very unpredictable" -- it always gets an
// explicit "unpredictable" state rather than a fabricated day count,
// regardless of any sales data.
//
// #2660: every other repeatable endpoint in this file already rate-limits
// itself (AVATAR_EQUIP_RATE_LIMIT_MAX #1057, NOTIFICATION_PREFERENCES_
// RATE_LIMIT_MAX #2103, ANIMATION_EQUIP_RATE_LIMIT_MAX) -- this one was
// missed despite firing one extra categorySalesVelocityPerDay query per
// distinct category needing the cross-builder fallback below, the same
// non-O(1)-read shape worker/lib/catalog.js's own similarity-search
// endpoint already rate-limits for. Generous limit since this is
// read-only informational data a builder's Settings/Build panel may poll
// somewhat often, not a rare deliberate action.
const BUILDER_LOW_STOCK_RATE_LIMIT_MAX = 60;

export async function handleBuilderLowStock(request, db) {
  const user = await requireCurrentUser(request, db);
  const builder = await getOrCreateBuilderForUser(db, user);
  await checkRateLimit(db, `builder-low-stock:${builder.builder_id}`, BUILDER_LOW_STOCK_RATE_LIMIT_MAX);
  const { results: templates } = await db.prepare(`
    SELECT ct.template_id AS templateId, ct.name AS name, ct.category AS category,
           ct.stock_quantity AS stockQuantity, COUNT(*) AS placedInstanceCount
    FROM placed_instances pi
    JOIN landlets l ON l.landlet_id = pi.landlet_id
    JOIN catalog_templates ct ON ct.template_id = pi.template_id
    WHERE l.owner_builder_id = ? AND ct.stock_quantity IS NOT NULL
    GROUP BY ct.template_id
  `).bind(builder.builder_id).all();
  if (templates.length === 0) return json({ templates: [] });

  const templateIds = templates.map((t) => t.templateId);
  const ownVelocityByTemplateId = await templateSalesVelocity(db, templateIds);
  // Only the categories genuinely needed -- a template with sales history
  // of its own never looks at this.
  const categoriesNeedingFallback = [...new Set(
    templates.filter((t) => !ownVelocityByTemplateId.has(t.templateId)).map((t) => t.category),
  )];
  const categoryVelocityByCategory = new Map(await Promise.all(
    categoriesNeedingFallback.map(async (category) => [category, await categorySalesVelocityPerDay(db, category)]),
  ));

  return json({
    templates: templates.map((t) => ({
      templateId: t.templateId,
      name: t.name,
      category: t.category,
      stockQuantity: t.stockQuantity,
      placedInstanceCount: t.placedInstanceCount,
      ...estimateDaysRemaining(t, ownVelocityByTemplateId.get(t.templateId), categoryVelocityByCategory.get(t.category)),
    })),
  });
}

function estimateDaysRemaining(template, ownUnitsPerDay, categoryUnitsPerDay) {
  if (template.stockQuantity === 1) {
    return { daysRemaining: null, predictability: 'unpredictable' };
  }
  const unitsPerDay = ownUnitsPerDay ?? categoryUnitsPerDay;
  if (!unitsPerDay) {
    return { daysRemaining: null, predictability: 'notEnoughData' };
  }
  return {
    daysRemaining: Math.round((template.stockQuantity / unitsPerDay) * 10) / 10,
    predictability: ownUnitsPerDay ? 'estimated' : 'estimatedFromCategory',
  };
}

// One units-per-day rate per template, derived from every non-refunded sale
// of that specific template across every builder who happens to host an
// instance of it -- the same cross-builder, shared-stock-pool shape
// GET /api/purchases?templateId= already uses, since #1947 itself requires
// velocity to be "computed across every builder selling that same
// template," not just this one builder's own sales.
async function templateSalesVelocity(db, templateIds) {
  const velocityByTemplateId = new Map();
  // #2321: chunked at D1_MAX_BOUND_PARAMETERS -- a builder can own more than
  // one landlet (auctions can transfer extra ones in, see the comment on
  // ownersByBuilderId above) and place well over 100 distinct finite-stock
  // templates across them, same bug class as #2038/#2204/#2216/#2233/#2283.
  // Each chunk's own GROUP BY operates on a disjoint subset of template_id,
  // so merging across chunks needs no further aggregation.
  for (let i = 0; i < templateIds.length; i += D1_MAX_BOUND_PARAMETERS) {
    const chunk = templateIds.slice(i, i + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db.prepare(`
      SELECT template_id AS templateId, SUM(quantity) AS totalSold,
             MIN(created_at) AS firstSaleAt, MAX(created_at) AS lastSaleAt
      FROM purchases
      WHERE template_id IN (${placeholders}) AND refunded_at IS NULL
      GROUP BY template_id
    `).bind(...chunk).all();
    for (const row of results) velocityByTemplateId.set(row.templateId, salesVelocityPerDay(row));
  }
  return velocityByTemplateId;
}

// #1949: the owner-endorsed fallback for a template with no sales history
// of its own -- every other template in the same category, regardless of
// seller, averaged into one rate. Deliberately not scoped to this builder's
// own templates; "similar products" means the category as a whole, the
// same freeform `category` column (indexed, always populated) every other
// browse/filter feature in this file already groups by.
async function categorySalesVelocityPerDay(db, category) {
  const { results } = await db.prepare(`
    SELECT p.template_id AS templateId, SUM(p.quantity) AS totalSold,
           MIN(p.created_at) AS firstSaleAt, MAX(p.created_at) AS lastSaleAt
    FROM purchases p
    JOIN catalog_templates ct ON ct.template_id = p.template_id
    WHERE ct.category = ? AND p.refunded_at IS NULL
    GROUP BY p.template_id
  `).bind(category).all();
  if (results.length === 0) return null;
  const rates = results.map(salesVelocityPerDay);
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

// Spans however long this template has actually been selling (first sale to
// last sale), never an assumed fixed window -- a single sale floors the
// span at one day rather than dividing by zero, which is deliberately a
// rough, early estimate (one data point) rather than a crash.
function salesVelocityPerDay(row) {
  const spanDays = Math.max(1, (new Date(row.lastSaleAt).getTime() - new Date(row.firstSaleAt).getTime()) / 86400000);
  return row.totalSold / spanDays;
}

// #1057's own fix, mirrored for the new PUT below from day one rather than
// shipping without it the way #680's own avatar-equip endpoint originally
// did.
const ANIMATION_EQUIP_RATE_LIMIT_MAX = 20;

// #1164: which owned animation (if any) this account currently has
// applied — mirrors handleMyAvatar above exactly, validated against
// owned_animations instead. GET returns the current choice (null means
// no animation applied, root motion plays as normal). PUT changes it,
// rejecting anything not already present in owned_animations. Actually
// making the applied choice play at runtime is #1165's own scope.
export async function handleMyAnimation(request, db) {
  const user = await requireCurrentUser(request, db);
  const builder = await getOrCreateBuilderForUser(db, user);

  if (request.method === 'GET') {
    return json({ animation: await myAnimationJson(db, builder) });
  }

  if (request.method === 'PUT') {
    await checkRateLimit(db, `animation-equip:${builder.builder_id}`, ANIMATION_EQUIP_RATE_LIMIT_MAX);
    const input = await readJson(request);
    let templateId = null;
    if (input.templateId !== null && input.templateId !== undefined) {
      templateId = labelValue(input.templateId, 'templateId');
      const owned = await db.prepare(
        'SELECT 1 FROM owned_animations WHERE builder_id = ? AND template_id = ?',
      ).bind(builder.builder_id, templateId).first();
      if (!owned) throw new HttpError('You do not own this animation', 403);
    }
    const result = await db.prepare(`
      UPDATE builders SET equipped_animation_template_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE builder_id = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM owned_animations WHERE builder_id = ? AND template_id = ?))
    `).bind(templateId, builder.builder_id, templateId, builder.builder_id, templateId).run();
    if (result.meta.changes === 0) {
      throw new HttpError('You do not own this animation', 403);
    }
    const updated = await requireBuilder(db, builder.builder_id);
    return json({ animation: await myAnimationJson(db, updated) });
  }

  return json({ error: 'Not found' }, 404);
}

async function myAnimationJson(db, builder) {
  if (!builder.equipped_animation_template_id) {
    return { equippedTemplateId: null, modelUrl: null, skeletonSignature: null };
  }
  const template = await db.prepare(
    'SELECT model_url, skeleton_signature FROM catalog_templates WHERE template_id = ?',
  ).bind(builder.equipped_animation_template_id).first();
  return {
    equippedTemplateId: template ? builder.equipped_animation_template_id : null,
    modelUrl: template?.model_url || null,
    skeletonSignature: template?.skeleton_signature || null,
  };
}

export { builderFromRow, publicBuilderFromRow, requireBuilder };
