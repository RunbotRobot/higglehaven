// Thin wrapper around the backend Worker API (worker/index.js). Every call
// here can fail — network down, Worker not deployed yet, etc. Callers are
// expected to catch and fall back to layoutStorage.js's localStorage
// functions, not this module; nothing in here retries or caches.
const API_BASE = '/api';

async function requestJson(path, options) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

// Paginated server-side (100 per request, same as instances/landlets) —
// pages through everything rather than silently keeping only the first
// 100 templates once the catalog grows past that.
export async function fetchCatalog() {
  const all = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { templates, nextCursor } = await requestJson(`/catalog?${query.toString()}`);
    all.push(...templates);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
}

export async function fetchBuilders() {
  const { builders } = await requestJson('/builders');
  return builders;
}

export async function createBuilder(label, builderId) {
  const { builder } = await requestJson('/builders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(builderId ? { label, builderId } : { label }),
  });
  return builder;
}

export async function renameBuilder(builderId, label) {
  const { builder } = await requestJson(`/builders/${encodeURIComponent(builderId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return builder;
}

// Releases whatever this builder currently owns back to greenbelt
// server-side (see docs/API.md) — the caller doesn't need to separately
// reset the landlet.
export async function deleteBuilder(builderId) {
  const result = await requestJson(`/builders/${encodeURIComponent(builderId)}`, { method: 'DELETE' });
  return result.releasedLandletIds;
}

// A separate roster from builders (see docs/API.md's "Sellers" section) —
// catalog_templates.seller_id references these, not a builder's ID. Same
// shared, cross-device, no-real-auth shape as builders above.
export async function fetchSellers() {
  const { sellers } = await requestJson('/sellers');
  return sellers;
}

export async function createSeller(label) {
  const { seller } = await requestJson('/sellers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return seller;
}

export async function renameSeller(sellerId, label) {
  const { seller } = await requestJson(`/sellers/${encodeURIComponent(sellerId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return seller;
}

// A seller owns no land, so unlike deleteBuilder there's no owned-land
// release to report back — existing templates just keep whatever
// seller_id they already had, the same as one that was never in the
// roster at all.
export async function deleteSeller(sellerId) {
  await requestJson(`/sellers/${encodeURIComponent(sellerId)}`, { method: 'DELETE' });
}

// Pages through every instance on a landlet rather than returning just the
// first 100 (the server's per-request cap) — a landlet with a large build
// (a brick wall hundreds of pieces deep, say) silently lost everything
// past the first page otherwise, without so much as a sign anything was
// missing. Same pattern as fetchAllLandlets() below.
export async function fetchInstances(landletId) {
  const all = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ landletId, limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { instances, nextCursor } = await requestJson(`/instances?${query.toString()}`);
    all.push(...instances);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
}

export async function fetchWorld() {
  const { world } = await requestJson('/world');
  return world;
}

// params is a plain object of query string keys (status, ownerBuilderId,
// limit, ...) — only non-null/undefined ones are included, so callers can
// pass `{ status, ownerBuilderId }` without worrying about either being
// unset.
export async function fetchLandlets(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  const { landlets } = await requestJson(`/landlets${suffix ? `?${suffix}` : ''}`);
  return landlets;
}

export async function fetchLandlet(landletId) {
  const { landlet } = await requestJson(`/landlets/${encodeURIComponent(landletId)}`);
  return landlet;
}

// Pages through every landlet regardless of world size — unlike
// fetchLandlets above (which returns one page and drops nextCursor), Shop
// mode needs the whole world's ground shapes up front, not just the first
// 100.
export async function fetchAllLandlets() {
  const all = [];
  let cursor;
  for (;;) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const { landlets, nextCursor } = await requestJson(`/landlets?${query.toString()}`);
    all.push(...landlets);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
}

export async function claimLandlet(landletId, builderId) {
  const { landlet } = await requestJson(`/landlets/${encodeURIComponent(landletId)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId }),
  });
  return landlet;
}

// Grows the world circle by one configured increment, promoting any
// generation-complete landlets it now fully encloses to greenbelt. Throws
// (409, surfaced as a normal Error) if the greenbelt reserve is already at
// or above the configured minimum ratio.
export async function expandWorld() {
  const { world } = await requestJson('/world/expand', { method: 'POST' });
  return world;
}

// Procedurally creates one gap-free band of wedge-shaped land candidates —
// see docs/API.md's "POST /api/land-candidates/generate-ring". Candidates
// whose inner edge already touches the current world boundary (the default
// when innerRadiusM is omitted) materialize immediately as 'generating'
// landlets; they still need completeRingGeneration + enough expandWorld()
// calls before they can become claimable.
export async function generateLandRing(params) {
  return requestJson('/land-candidates/generate-ring', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export async function fetchLandCandidateRing(ringId) {
  const { ring } = await requestJson(`/land-candidate-rings/${encodeURIComponent(ringId)}`);
  return ring;
}

// Marks every (already-materialized) landlet in a generated ring as
// generation-complete, making it eligible to promote to greenbelt the next
// time the world encloses it. Throws if any ring member hasn't materialized
// yet — see generateLandRing's doc comment.
export async function completeRingGeneration(ringId) {
  return requestJson(`/land-candidate-rings/${encodeURIComponent(ringId)}/generation-complete`, {
    method: 'POST',
  });
}

export async function createInstanceRemote(instance) {
  const { instance: created } = await requestJson('/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(instance),
  });
  return created;
}

export async function updateInstanceRemote(instanceId, patch) {
  const { instance: updated } = await requestJson(`/instances/${encodeURIComponent(instanceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return updated;
}

export async function deleteInstanceRemote(instanceId) {
  await requestJson(`/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
}

const INSTANCE_BATCH_CHUNK_SIZE = 100; // matches the worker's own per-request cap

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Bulk create/update/delete, used anywhere many instances change at once
// (paste, a multi-item group move, multi-delete, and undo/redo restoring a
// snapshot that touches several). Chunks sequentially (never all at once)
// rather than firing one request per item: hundreds of simultaneous
// fire-and-forget single-instance requests is exactly the load pattern that
// let some quietly never reach the server while the rest succeeded, with
// nothing to tell the builder anything had gone wrong until their next
// reload silently came back short.
export async function createInstancesRemote(instances) {
  const created = [];
  for (const batch of chunk(instances, INSTANCE_BATCH_CHUNK_SIZE)) {
    const { instances: stored } = await requestJson('/instances/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: batch }),
    });
    created.push(...stored);
  }
  return created;
}

export async function upsertInstancesRemote(instances) {
  const updated = [];
  for (const batch of chunk(instances, INSTANCE_BATCH_CHUNK_SIZE)) {
    const { instances: stored } = await requestJson('/instances/batch', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: batch }),
    });
    updated.push(...stored);
  }
  return updated;
}

export async function deleteInstancesRemote(instanceIds) {
  for (const batch of chunk(instanceIds, INSTANCE_BATCH_CHUNK_SIZE)) {
    await requestJson('/instances/batch', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceIds: batch }),
    });
  }
}

// Uploads a .glb file directly. Distinct from requestJson above since this
// needs a raw multipart body, not a JSON one.
export async function uploadModelFile(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`${API_BASE}/models`, { method: 'POST', body: form });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Model upload failed with HTTP ${response.status}`);
  }
  return response.json(); // { modelUrl, sourceName, sizeBytes }
}

export async function createCatalogTemplate(template) {
  const { template: created } = await requestJson('/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(template),
  });
  return created;
}

export async function updateCatalogTemplate(templateId, patch) {
  const { template: updated } = await requestJson(`/catalog/${encodeURIComponent(templateId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return updated;
}

export async function deleteCatalogTemplate(templateId) {
  await requestJson(`/catalog/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
}

// Builder-facing notifications (see migrations/0038_notifications.sql) —
// currently only ever produced by a seller changing a placed product's
// dimensions. unreadOnly narrows the list server-side rather than filtering
// client-side, since the same call is used both for the unread badge count
// and (without the flag) the full history list.
export async function fetchNotifications(builderId, { unreadOnly = false } = {}) {
  const query = new URLSearchParams({ builderId });
  if (unreadOnly) query.set('unreadOnly', 'true');
  const { notifications } = await requestJson(`/notifications?${query.toString()}`);
  return notifications;
}

export async function markNotificationRead(notificationId) {
  const { notification } = await requestJson(`/notifications/${encodeURIComponent(notificationId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ read: true }),
  });
  return notification;
}

export async function markAllNotificationsRead(builderId) {
  await requestJson('/notifications/mark-all-read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId }),
  });
}

// Friend requests (see migrations/0049_friendships.sql). Each returned
// friendship is already shaped relative to `builderId` — otherLabel,
// direction, otherLandlet — so the frontend never has to figure out "which
// side of this row am I."
export async function fetchFriendships(builderId) {
  const { friendships } = await requestJson(`/friendships?${new URLSearchParams({ builderId }).toString()}`);
  return friendships;
}

export async function sendFriendRequest(requesterBuilderId, recipientBuilderId) {
  const { friendship } = await requestJson('/friendships', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requesterBuilderId, recipientBuilderId }),
  });
  return friendship;
}

export async function acceptFriendRequest(friendshipId) {
  const { friendship } = await requestJson(`/friendships/${encodeURIComponent(friendshipId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  return friendship;
}

export async function removeFriendship(friendshipId) {
  await requestJson(`/friendships/${encodeURIComponent(friendshipId)}`, { method: 'DELETE' });
}

// Landlet versions (see docs/API.md's "Landlet drafts"/"Landlet versions") —
// immutable snapshots of a landlet's placed instances, separate from the
// mutable placed_instances rows a builder is actively editing. A landlet's
// activeVersionId points at whichever snapshot (if any) shoppers see; a
// landlet that's never been published has none, and Shop mode falls back to
// showing the live draft in that case (see loadShopLandletInstances).
export async function fetchLandletVersions(landletId, { limit, cursor } = {}) {
  const query = new URLSearchParams();
  if (limit) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  const qs = query.toString();
  return requestJson(`/landlets/${encodeURIComponent(landletId)}/versions${qs ? `?${qs}` : ''}`);
}

// Snapshots the landlet's *current* live instances as a new immutable
// version — this alone doesn't change what shoppers see (see
// activateLandletVersion); "Publish" in the UI does both in sequence.
export async function saveLandletVersion(landletId, { name, metadata } = {}) {
  const { version } = await requestJson(`/landlets/${encodeURIComponent(landletId)}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, metadata }),
  });
  return version;
}

// Version metadata plus its snapshotted `instances` array (same shape as an
// ordinary placed instance — see worker/index.js's versionInstanceFromRow —
// so it can be handed straight to createMeshForInstance or replaceLandletDraft).
export async function fetchLandletVersion(landletId, versionId) {
  const { version } = await requestJson(`/landlets/${encodeURIComponent(landletId)}/versions/${encodeURIComponent(versionId)}`);
  return version;
}

// Points the landlet's activeVersionId at an existing snapshot — the
// builder's own live draft is untouched, only what Shop mode shows changes.
export async function activateLandletVersion(landletId, versionId) {
  return requestJson(`/landlets/${encodeURIComponent(landletId)}/versions/${encodeURIComponent(versionId)}/activate`, {
    method: 'POST',
  });
}

// Atomically replaces the landlet's entire live draft (every placed
// instance) with `instances` — used to restore an older version into the
// editor. Always creates a new version snapshot of its own as a side effect
// (even restoring counts as a save), giving a clean audit trail back to
// "restored from Version N" rather than silently overwriting history.
export async function replaceLandletDraft(landletId, { instances, versionName, versionMetadata } = {}) {
  return requestJson(`/landlets/${encodeURIComponent(landletId)}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instances, versionName, versionMetadata }),
  });
}

// Bundles (see migrations/0039_bundles.sql) — a saved, named group of items
// a builder can stamp down together later, in the exact relative-offset
// shape (dx/dy/dz + rotation + crop + scale per item) placeClipboardItems
// already consumes for an ordinary Paste, so a fetched bundle's `items` can
// be handed straight to enterPlacementMode({ type: 'clipboard', items })
// with no translation. Private to the owning builder.
export async function fetchBundles(builderId) {
  const { bundles } = await requestJson(`/bundles?${new URLSearchParams({ builderId })}`);
  return bundles;
}

export async function createBundle({ builderId, name, items, shared }) {
  const { bundle } = await requestJson('/bundles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId, name, items, shared }),
  });
  return bundle;
}

// A partial update — only send the fields actually changing (see the
// worker's own PATCH handler, which treats each of name/shared
// independently and leaves the other untouched when omitted).
export async function updateBundle(bundleId, patch) {
  const { bundle } = await requestJson(`/bundles/${encodeURIComponent(bundleId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return bundle;
}

// The community tab: every builder's shared bundles, not just one
// builder's — a separate listing from fetchBundles(builderId), not a
// filtered version of it (see the worker's own GET handler).
export async function fetchSharedBundles() {
  const { bundles } = await requestJson('/bundles?shared=true');
  return bundles;
}

export async function deleteBundle(bundleId) {
  await requestJson(`/bundles/${encodeURIComponent(bundleId)}`, { method: 'DELETE' });
}

// Community sign posts (see migrations/0041_community_signs.sql) — nested
// under the sign's own instanceId, not a top-level collection, since a post
// never exists independent of the sign it's on.
export async function fetchSignPosts(instanceId) {
  const { posts } = await requestJson(`/instances/${encodeURIComponent(instanceId)}/posts`);
  return posts;
}

export async function createSignPost(instanceId, { authorLabel, text }) {
  const { post } = await requestJson(`/instances/${encodeURIComponent(instanceId)}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorLabel, text }),
  });
  return post;
}

export async function deleteSignPost(instanceId, postId) {
  await requestJson(`/instances/${encodeURIComponent(instanceId)}/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
}

// Community calendar events (see migrations/0042_community_calendar.sql) —
// same nested-under-the-instance shape as sign posts above, for the same
// reason.
export async function fetchCalendarEvents(instanceId) {
  const { events } = await requestJson(`/instances/${encodeURIComponent(instanceId)}/events`);
  return events;
}

export async function createCalendarEvent(instanceId, { authorLabel, text, scheduledAt } = {}) {
  const { event } = await requestJson(`/instances/${encodeURIComponent(instanceId)}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorLabel, text, scheduledAt }),
  });
  return event;
}

export async function deleteCalendarEvent(instanceId, eventId) {
  await requestJson(`/instances/${encodeURIComponent(instanceId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
}

// The one-shot creative-tool trigger (docs/SPEC.md §6's own "scheduled
// confetti-cannon" example) — see docs/API.md's "Community calendar" for
// why this is idempotent and safe to call speculatively any time a
// calendar's events are loaded, not just once a builder is sure it's due.
export async function triggerCalendarEvent(instanceId, eventId) {
  return requestJson(`/instances/${encodeURIComponent(instanceId)}/events/${encodeURIComponent(eventId)}/trigger`, { method: 'POST' });
}

// Product reviews (see migrations/0048_product_reviews_on_template.sql) —
// nested under the catalog *template* (the product itself), not under any
// one placed instance of it, so the same review list is shared by every
// placement of that product. GET's response also carries
// averageRating/count so callers don't need to recompute them from the raw
// list.
export async function fetchProductReviews(templateId) {
  return requestJson(`/catalog/${encodeURIComponent(templateId)}/reviews`);
}

export async function createProductReview(templateId, { authorLabel, rating, text } = {}) {
  const { review } = await requestJson(`/catalog/${encodeURIComponent(templateId)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorLabel, rating, text }),
  });
  return review;
}

export async function deleteProductReview(templateId, reviewId) {
  await requestJson(`/catalog/${encodeURIComponent(templateId)}/reviews/${encodeURIComponent(reviewId)}`, { method: 'DELETE' });
}

// Land acquisition auctions (see migrations/0045_auctions.sql).
export async function startAuction(landletId, { builderId, startingBidCents, durationHours } = {}) {
  const { auction } = await requestJson(`/landlets/${encodeURIComponent(landletId)}/auction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId, startingBidCents, durationHours }),
  });
  return auction;
}

export async function fetchAuctions({ status, landletId } = {}) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (landletId) params.set('landletId', landletId);
  const query = params.toString();
  const { auctions } = await requestJson(`/auctions${query ? `?${query}` : ''}`);
  return auctions;
}

export async function fetchAuction(auctionId) {
  const { auction } = await requestJson(`/auctions/${encodeURIComponent(auctionId)}`);
  return auction;
}

export async function fetchAuctionBids(auctionId) {
  const { bids } = await requestJson(`/auctions/${encodeURIComponent(auctionId)}/bids`);
  return bids;
}

export async function placeBid(auctionId, { builderId, amountCents }) {
  const { bid } = await requestJson(`/auctions/${encodeURIComponent(auctionId)}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ builderId, amountCents }),
  });
  return bid;
}

export async function resolveAuctionNow(auctionId) {
  const { auction } = await requestJson(`/auctions/${encodeURIComponent(auctionId)}/resolve`, { method: 'POST' });
  return auction;
}

// Simulated purchases (see migrations/0051_purchases.sql) — a dev-mode-only
// "buy" that never charges anything real, but does run the actual
// commission math and credit a real builder, completing the earning loop
// land cap (migrations/0050) is normalized against.
export async function purchaseInstance(instanceId, { quantity, buyerLabel } = {}) {
  const { purchase } = await requestJson(`/instances/${encodeURIComponent(instanceId)}/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quantity, buyerLabel }),
  });
  return purchase;
}

export async function fetchPurchases({ builderId, templateId } = {}) {
  const params = new URLSearchParams();
  if (builderId) params.set('builderId', builderId);
  if (templateId) params.set('templateId', templateId);
  const { purchases } = await requestJson(`/purchases?${params.toString()}`);
  return purchases;
}

// Refund + dáller-commission clawback (migrations/0052_purchase_refunds.sql).
export async function refundPurchase(purchaseId) {
  const { purchase } = await requestJson(`/purchases/${encodeURIComponent(purchaseId)}/refund`, { method: 'POST' });
  return purchase;
}
