// #2556 (part of #2504/#2500's src/main.js module split, see #2503's
// design comment for the full dependency map): notifications/friends/DM/
// my-lands account-menu chrome, extracted wholesale from src/main.js.
// refreshNotificationsBadge/refreshFriendsBadge/refreshDmBadge are
// exported since mode-entry code in main.js (bootstrap()/enterSellMode()/
// enterLayoutPreviewMode()) and the seller Edit Size save flow refresh
// these three badges directly after resolving builderId; everything else
// below is only ever reached from inside this module's own account-menu
// panel/modals.
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { builderId, currentMode } from '../world/state.js';
import { currentAuthUser } from './auth.js';
import { formatArea } from '../settings.js';
// formatHiggles/START_MODE_KEY/BUILD_TARGET_LANDLET_ID_KEY stay owned by
// main.js (formatHiggles is a shared money formatter used throughout that
// file; the other two are reload-carried sessionStorage keys read by
// main.js's own resolveLandletId/bootstrap) — imported back the same
// temporary-circular-import way account/auth.js and account/identity.js
// already do for their own not-yet-extracted dependencies.
import { formatHiggles, START_MODE_KEY, BUILD_TARGET_LANDLET_ID_KEY } from '../main.js';
// #2781 (sub-issue of #2777): join/leave a friend voice channel also has
// to open/close this module's own RTCPeerConnection, not just write the
// membership row -- src/shop/voiceChat.js owns that (and keeps running
// its own reconciliation regardless of Shop mode, see that module's own
// comment), so this panel calls into it rather than hitting the API
// directly the way fetchFriendVoiceChannels (read-only, used for
// rendering only) does.
import { joinFriendVoiceChannel, leaveFriendVoiceChannel } from '../shop/voiceChat.js';
import {
  fetchMyBuilder,
  fetchTaxSummary,
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  fetchFriendships,
  sendFriendRequest,
  acceptFriendRequest,
  removeFriendship,
  fetchWorld,
  fetchBuilders,
  fetchDirectMessages,
  sendDirectMessage,
  clearDirectMessageIdempotencyKey,
  markDirectMessagesRead,
  fetchUnreadDirectMessageCount,
  fetchAllLandlets,
  renameLandlet,
  fetchFriendVoiceChannels,
} from '../api.js';

// Builder-facing notifications (see migrations/0038_notifications.sql) —
// currently only ever produced by a seller changing a placed product's
// dimensions (notifyBuildersOfDimensionChange, worker/index.js). A plain
// pill button + badge count, refreshed whenever a builder identity
// resolves or the modal itself opens/closes — no live polling, since
// nothing else in this app pushes updates to an already-open tab either.
const notificationsBtn = document.getElementById('notifications-btn');
const notificationsBadgeEl = document.getElementById('notifications-badge');
const notificationsModalEl = document.getElementById('notifications-modal');
const notificationsCloseBtn = document.getElementById('notifications-close-btn');
const notificationsListEl = document.getElementById('notifications-list');
const notificationsEmptyEl = document.getElementById('notifications-empty');
const notificationsMarkAllBtn = document.getElementById('notifications-mark-all-btn');
const notificationsLoadMoreBtn = document.getElementById('notifications-load-more-btn');

export async function refreshNotificationsBadge() {
  if (!builderId) return;
  try {
    // A real count query, not fetchNotifications({ unreadOnly: true })'s
    // own first page — that list is cursor-paginated (issue #320) one
    // page at a time, which would still undercount the badge if this read
    // only the first page's own .length (e.g. a popular auction's worth
    // of bid notifications).
    const count = await fetchUnreadNotificationCount();
    notificationsBadgeEl.textContent = String(count);
    notificationsBadgeEl.hidden = count === 0;
  } catch (err) {
    console.warn('Could not refresh notifications badge:', err);
  }
}

function formatNotificationTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

// #245: renderNotifications awaits fetchNotifications() before populating
// the panel; if it's invoked again (e.g. the bell clicked twice in quick
// succession) before that await resolves, the second call's own
// `innerHTML = ''` clears whatever the first call is about to append,
// but nothing then stops the first call's now-stale fetch from appending
// its rows on top of the second call's fresh ones once it resolves —
// duplicate rows, the same missing-re-entrancy-guard shape #244 already
// fixed for renderSignPosts/renderCalendarEvents (lower severity here:
// this always renders the same session-wide list, never a per-click
// target that could show the wrong object's data). Each call captures the
// token's value before it starts awaiting, then checks it's still the
// latest afterward; a superseded call bails out quietly instead of
// rendering anything.
let notificationsLoadToken = 0;
// The cursor for whatever page comes after the ones currently rendered —
// null once there's nothing more to load (see fetchNotifications'/
// handleNotifications' nextCursor, issue #320). Reset to null every time
// renderNotifications starts a fresh first page; advanced by
// loadMoreNotifications as later pages come in.
let notificationsNextCursor = null;

function appendNotificationRow(notification) {
  const row = document.createElement('div');
  row.className = 'notification-row';
  row.classList.toggle('unread', !notification.readAt);
  const message = document.createElement('div');
  message.textContent = notification.message;
  row.appendChild(message);
  const time = document.createElement('div');
  time.className = 'notification-row-time';
  time.textContent = formatNotificationTime(notification.createdAt);
  row.appendChild(time);
  // Tapping any notice marks just that one read — simpler than a
  // separate per-row dismiss button, and "Mark all read" still exists
  // for clearing the whole list at once.
  if (!notification.readAt) {
    const markReadOnClick = async () => {
      try {
        await markNotificationRead(notification.notificationId);
        row.classList.remove('unread');
        row.removeEventListener('click', markReadOnClick);
        row.removeEventListener('keydown', markReadOnKeydown);
        row.removeAttribute('role');
        row.removeAttribute('tabindex');
        row.removeAttribute('aria-label');
        refreshNotificationsBadge();
      } catch (err) {
        console.warn('Could not mark notification read:', err);
      }
    };
    // #2329: this row has no native button underneath it, so without an
    // explicit role/tabindex/keydown handler it's reachable by mouse only —
    // every other interactive control in this file is a real <button>.
    const markReadOnKeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      markReadOnClick();
    };
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', `Mark notification as read: ${notification.message}`);
    row.addEventListener('click', markReadOnClick);
    row.addEventListener('keydown', markReadOnKeydown);
  }
  notificationsListEl.appendChild(row);
}

async function renderNotifications() {
  const myLoadToken = ++notificationsLoadToken;
  notificationsListEl.innerHTML = '';
  notificationsLoadMoreBtn.hidden = true;
  notificationsNextCursor = null;
  if (!builderId) return;
  let page;
  try {
    page = await fetchNotifications();
  } catch (err) {
    if (myLoadToken !== notificationsLoadToken) return; // superseded while loading — a newer call owns the panel now
    notificationsEmptyEl.textContent = err.message || 'Could not load notices.';
    notificationsEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== notificationsLoadToken) return; // superseded while loading — a newer call owns the panel now
  // #1128: same reset-on-success fix as reviewEmptyEl in the Seller
  // modal — without it a past fetch failure leaves this stuck on its
  // error message forever, even once a later load succeeds with zero
  // notifications.
  notificationsEmptyEl.textContent = 'Nothing here yet.';
  notificationsEmptyEl.hidden = page.notifications.length > 0;
  for (const notification of page.notifications) appendNotificationRow(notification);
  notificationsNextCursor = page.nextCursor;
  notificationsLoadMoreBtn.hidden = !notificationsNextCursor;
}

notificationsLoadMoreBtn.addEventListener('click', async () => {
  const myLoadToken = notificationsLoadToken; // this panel's current, already-rendered load — not a fresh reset
  notificationsLoadMoreBtn.disabled = true;
  try {
    const page = await fetchNotifications({ cursor: notificationsNextCursor });
    if (myLoadToken !== notificationsLoadToken) return; // panel was reset while this page was loading
    for (const notification of page.notifications) appendNotificationRow(notification);
    notificationsNextCursor = page.nextCursor;
    notificationsLoadMoreBtn.hidden = !notificationsNextCursor;
  } catch (err) {
    console.warn('Could not load more notifications:', err);
  } finally {
    notificationsLoadMoreBtn.disabled = false;
  }
});

function closeNotificationsModal() {
  notificationsModalEl.classList.remove('visible');
  refreshNotificationsBadge();
  closeModalA11y(notificationsModalEl);
}
notificationsBtn.addEventListener('click', () => {
  notificationsModalEl.classList.add('visible');
  openModalA11y(notificationsModalEl, closeNotificationsModal);
  renderNotifications();
});
notificationsCloseBtn.addEventListener('click', closeNotificationsModal);
notificationsMarkAllBtn.addEventListener('click', async () => {
  if (!builderId) return;
  notificationsMarkAllBtn.disabled = true;
  try {
    await markAllNotificationsRead();
    await renderNotifications();
    await refreshNotificationsBadge();
  } catch (err) {
    console.warn('Could not mark all notifications read:', err);
  } finally {
    notificationsMarkAllBtn.disabled = false;
  }
});

// Owner (Control Room feedback): "Builders should see their lánd cap in
// the menu somewhere" — until now the only place it appeared was Settings
// > Build (renderLandCapField above), which needs Build mode active *and*
// Settings opened *and* its Build tab picked. Same "no live polling,
// refresh on open" approach as refreshNotificationsBadge/refreshFriendsBadge
// just below, except the source of truth to refresh against is this panel
// itself (see the accountMenuToggle click handler further down) rather
// than a separate modal.
const accountMenuLandCapEl = document.getElementById('account-menu-landcap');
async function refreshAccountMenuLandCap() {
  if (!builderId) {
    accountMenuLandCapEl.hidden = true;
    return;
  }
  try {
    // fetchMyBuilder (GET /api/builders/me), not a full-roster scan — see
    // renderLandCapField's own comment above on why.
    const me = await fetchMyBuilder();
    accountMenuLandCapEl.textContent = `Land cap: ${formatArea(me.ownedAreaM2 ?? 0, 0)} / ${formatArea(me.landCapM2, 0)}`;
    accountMenuLandCapEl.hidden = false;
  } catch (err) {
    console.warn('Could not refresh land cap menu display:', err);
    accountMenuLandCapEl.hidden = true;
  }
}

// Tax reporting notice (#613, sub-issue of #350) — same "no live polling,
// refresh on open" approach as refreshAccountMenuLandCap just above. This
// notice itself is purely informational and never blocks anything — #615's
// actual earnings-above-threshold gate (worker/index.js's
// taxThresholdPayoutBlockedError, both live) re-derives "crossed" straight
// from the same totalCents/thresholdCents this notice shows, independent of
// this element ever having been read.
const accountMenuTaxNoticeEl = document.getElementById('account-menu-tax-notice');
const TAX_NOTICE_TEXT = {
  early: (total, threshold) =>
    `You've earned ${formatHiggles(total)} of this year's ${formatHiggles(threshold)} tax-reporting threshold — no action needed yet.`,
  approaching: (total, threshold) =>
    `You're nearing this year's ${formatHiggles(threshold)} tax-reporting threshold (${formatHiggles(total)} so far) — ` +
    `tax paperwork will be required once you cross it.`,
  crossed: (total, threshold) =>
    `You've crossed this year's ${formatHiggles(threshold)} tax-reporting threshold (${formatHiggles(total)} earned) — ` +
    `tax paperwork will be required to access earnings above it.`,
};
async function refreshAccountMenuTaxNotice() {
  if (!builderId) {
    accountMenuTaxNoticeEl.hidden = true;
    return;
  }
  try {
    const summary = await fetchTaxSummary();
    const text = TAX_NOTICE_TEXT[summary.noticeLevel];
    if (!text) {
      accountMenuTaxNoticeEl.hidden = true;
      return;
    }
    accountMenuTaxNoticeEl.textContent = text(summary.totalCents, summary.thresholdCents);
    accountMenuTaxNoticeEl.classList.toggle('crossed', summary.noticeLevel === 'crossed');
    accountMenuTaxNoticeEl.hidden = false;
  } catch (err) {
    console.warn('Could not refresh tax notice:', err);
    accountMenuTaxNoticeEl.hidden = true;
  }
}

// Friend requests (docs/SPEC.md §6: "Friend/group systems: standard friend
// requests; social map shows an accepted friend's location.") Same plain
// pill-button-plus-badge design as Notices just above, badge counting
// pending incoming requests rather than unread notices.
const friendsBtn = document.getElementById('friends-btn');
const friendsBadgeEl = document.getElementById('friends-badge');
// #1661: shares friends-btn with friendsBadgeEl above but counts something
// different (unread direct messages, not pending incoming requests) —
// messaging has no top-level entry point of its own (openDmModal is only
// reached per-friend from inside the Friends panel), so this rides the
// one button that leads there.
const dmBadgeEl = document.getElementById('dm-badge');
const friendsModalEl = document.getElementById('friends-modal');
const friendsCloseBtn = document.getElementById('friends-close-btn');
const friendsAddBtn = document.getElementById('friends-add-btn');
const friendsStatusEl = document.getElementById('friends-status');
const friendsIncomingListEl = document.getElementById('friends-incoming-list');
const friendsIncomingEmptyEl = document.getElementById('friends-incoming-empty');
const friendsOutgoingListEl = document.getElementById('friends-outgoing-list');
const friendsOutgoingEmptyEl = document.getElementById('friends-outgoing-empty');
const friendsAcceptedListEl = document.getElementById('friends-accepted-list');
const friendsAcceptedEmptyEl = document.getElementById('friends-accepted-empty');
// #2781: the caller's own current friend-voice-channel membership status
// line, rendered above the Requests/Friends sections -- see index.html's
// own comment on this element.
const friendsVoiceChannelStatusEl = document.getElementById('friends-voice-channel-status');
const friendsMapBtn = document.getElementById('friends-map-btn');
const friendsMapModalEl = document.getElementById('friends-map-modal');
const friendsMapCloseBtn = document.getElementById('friends-map-close-btn');
const friendsMapCanvas = document.getElementById('friends-map-canvas');
const friendsMapEmptyEl = document.getElementById('friends-map-empty');

// Direct messages (#1637) — a thread with one other builder, reached only
// via each accepted friend's own "Message" button below, same "swaps
// places with #friends-modal" idiom friends-map-modal already uses rather
// than stacking as a second modal layer.
const dmModalEl = document.getElementById('dm-modal');
const dmCloseBtn = document.getElementById('dm-close-btn');
const dmModalTitleEl = document.getElementById('dm-modal-title');
const dmStatusEl = document.getElementById('dm-status');
const dmLoadMoreBtn = document.getElementById('dm-load-more-btn');
const dmListEl = document.getElementById('dm-list');
const dmEmptyEl = document.getElementById('dm-empty');
const dmComposeForm = document.getElementById('dm-compose-form');
const dmComposeInput = document.getElementById('dm-compose-input');
const dmSendBtn = document.getElementById('dm-send-btn');
let dmOtherBuilderId = null;
let dmOtherLabel = '';
// Same missing-re-entrancy-guard shape as friendsLoadToken just above —
// opening a thread, sending a message, and the mark-read call each await
// before touching the DOM, so a stale response landing after a fresher one
// (e.g. the modal reopened against a different friend in between) would
// otherwise append that friend's messages into the wrong thread.
let dmLoadToken = 0;
// #1677: the cursor for whatever page of OLDER messages comes after the
// ones currently rendered — null once there's nothing more to load. Same
// shape as savedLayoutsNextCursor/notificationsNextCursor, just paired
// with a "Load more" that prepends above the thread instead of appending
// below it, since older messages belong visually above what's already shown.
let dmNextCursor = null;

function createDmRow(message) {
  const row = document.createElement('div');
  row.className = message.senderBuilderId === builderId ? 'dm-row sent' : 'dm-row';
  const text = document.createElement('div');
  text.textContent = message.text;
  row.appendChild(text);
  const time = document.createElement('div');
  time.className = 'dm-row-time';
  time.textContent = formatNotificationTime(message.createdAt);
  row.appendChild(time);
  return row;
}

async function renderDmThread() {
  const myLoadToken = ++dmLoadToken;
  dmListEl.innerHTML = '';
  dmStatusEl.textContent = '';
  dmStatusEl.classList.remove('error');
  dmLoadMoreBtn.hidden = true;
  dmNextCursor = null;
  if (!dmOtherBuilderId) return;
  let messages;
  let nextCursor;
  try {
    const page = await fetchDirectMessages(dmOtherBuilderId);
    messages = page.messages;
    nextCursor = page.nextCursor;
  } catch (err) {
    if (myLoadToken !== dmLoadToken) return; // superseded while loading — a newer call owns the panel now
    dmStatusEl.textContent = err.message || 'Could not load messages.';
    dmStatusEl.classList.add('error');
    return;
  }
  if (myLoadToken !== dmLoadToken) return; // superseded while loading — a newer call owns the panel now
  dmEmptyEl.hidden = messages.length > 0;
  // Newest-first from the server (same shape as notifications) — reversed
  // here so the thread reads chronologically top-to-bottom, like any chat.
  for (const message of [...messages].reverse()) {
    dmListEl.appendChild(createDmRow(message));
  }
  dmNextCursor = nextCursor;
  dmLoadMoreBtn.hidden = !dmNextCursor;
  dmListEl.scrollTop = dmListEl.scrollHeight;
  // Best-effort — opening the thread is "reading" it, same as notifications'
  // own read-on-click idiom, just for the whole thread at once rather than
  // one row at a time.
  try {
    await markDirectMessagesRead(dmOtherBuilderId);
    // #1661: the just-read thread's own messages no longer count toward
    // the unread total — reflect that promptly rather than waiting for
    // some unrelated later refresh to catch up.
    refreshDmBadge();
  } catch (err) {
    console.warn('Could not mark messages read:', err);
  }
}

dmLoadMoreBtn.addEventListener('click', async () => {
  const myLoadToken = dmLoadToken; // this thread's current render — not a fresh reset
  dmLoadMoreBtn.disabled = true;
  try {
    const page = await fetchDirectMessages(dmOtherBuilderId, { cursor: dmNextCursor });
    if (myLoadToken !== dmLoadToken) return; // thread was closed/reopened against someone else while this page was loading
    // Prepend above the currently-rendered messages (this page is also
    // newest-first, so reverse it the same way the initial render does) and
    // keep the scroll position anchored to what was already visible, rather
    // than jumping to the newly-inserted top the way a plain append-below
    // (saved layouts'/notifications' own idiom) never has to worry about.
    const scrollHeightBefore = dmListEl.scrollHeight;
    const scrollTopBefore = dmListEl.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const message of [...page.messages].reverse()) {
      fragment.appendChild(createDmRow(message));
    }
    dmListEl.insertBefore(fragment, dmListEl.firstChild);
    dmListEl.scrollTop = scrollTopBefore + (dmListEl.scrollHeight - scrollHeightBefore);
    dmNextCursor = page.nextCursor;
    dmLoadMoreBtn.hidden = !dmNextCursor;
  } catch (err) {
    console.warn('Could not load more messages:', err);
  } finally {
    dmLoadMoreBtn.disabled = false;
  }
});

function closeDmModal() {
  dmModalEl.classList.remove('visible');
  closeModalA11y(dmModalEl);
  friendsModalEl.classList.add('visible');
  openModalA11y(friendsModalEl, closeFriendsModal);
}

function openDmModal(otherBuilderId, otherLabel) {
  dmOtherBuilderId = otherBuilderId;
  dmOtherLabel = otherLabel;
  dmModalTitleEl.textContent = `Messages: ${otherLabel}`;
  dmComposeInput.value = '';
  friendsModalEl.classList.remove('visible');
  closeModalA11y(friendsModalEl);
  dmModalEl.classList.add('visible');
  openModalA11y(dmModalEl, closeDmModal);
  renderDmThread();
}

dmCloseBtn.addEventListener('click', closeDmModal);

dmComposeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = dmComposeInput.value.trim();
  if (!text || !dmOtherBuilderId) return;
  dmStatusEl.textContent = '';
  dmStatusEl.classList.remove('error');
  dmSendBtn.disabled = true;
  try {
    await sendDirectMessage(dmOtherBuilderId, text);
    clearDirectMessageIdempotencyKey(dmOtherBuilderId);
    dmComposeInput.value = '';
    await renderDmThread();
  } catch (err) {
    dmStatusEl.textContent = err.message || 'Could not send this message.';
    dmStatusEl.classList.add('error');
  } finally {
    dmSendBtn.disabled = false;
  }
});

export async function refreshFriendsBadge() {
  if (!builderId) return;
  try {
    const friendships = await fetchFriendships();
    const incoming = friendships.filter((f) => f.direction === 'incoming' && f.status === 'pending');
    friendsBadgeEl.textContent = String(incoming.length);
    friendsBadgeEl.hidden = incoming.length === 0;
  } catch (err) {
    console.warn('Could not refresh friends badge:', err);
  }
}

// #1661: same shape as refreshFriendsBadge/refreshNotificationsBadge just
// above — fetchUnreadDirectMessageCount already existed (and the backend
// endpoint/index behind it), just never had a caller. Same id_verified gate
// the "Message" button itself uses (see its own #1637 comment above) --
// the endpoint is requireIdVerifiedSessionBuilder-gated server-side, so
// calling it for a non-id_verified account would just always 403.
export async function refreshDmBadge() {
  if (!builderId || currentAuthUser?.trustTier !== 'id_verified') return;
  try {
    const count = await fetchUnreadDirectMessageCount();
    dmBadgeEl.textContent = String(count);
    dmBadgeEl.hidden = count === 0;
  } catch (err) {
    console.warn('Could not refresh DM badge:', err);
  }
}

// "Social map" (see worker/index.js's own comment on handleFriendships for
// why this is simplified to a friend's claimed lándlet rather than a live
// position — exact coordinates, not fuzzed, per #1195's owner decision) —
// rendered here as plain text, not an actual map widget. A real map would
// need its own renderer/camera the way the claim flyover does (a full
// WebGL scene, not something to spin up just for a small modal list) —
// this ships the underlying "where do my friends live" data first.
function friendLocationText(friendship) {
  if (!friendship.otherLandlet) return "Hasn't claimed a lándlet yet";
  const { name, center } = friendship.otherLandlet;
  return `${name} (${center.x.toFixed(0)}, ${center.y.toFixed(0)})`;
}

function friendLabelByBuilderId(otherBuilderId, accepted) {
  return accepted.find((f) => f.otherBuilderId === otherBuilderId)?.otherLabel ?? otherBuilderId;
}

// #2781 (sub-issue of #2777): renders the caller's own current friend-
// voice-channel membership (at most one meaningfully distinct status this
// simple panel shows -- own channel takes priority if, unusually, the
// caller is somehow a member of more than one at once) above the ordinary
// friend-request sections. `channels` is whatever GET /voice/friend-
// channels just returned -- every channel the caller is currently a
// member of, including one they themselves own. Stays empty (CSS hides
// the element via :empty) when that list is empty.
function renderFriendVoiceChannelStatus(channels, accepted) {
  friendsVoiceChannelStatusEl.innerHTML = '';
  if (channels.length === 0) return;
  const active = channels.find((c) => c.ownerBuilderId === builderId) ?? channels[0];
  const isOwner = active.ownerBuilderId === builderId;
  const otherMembers = active.members.filter((memberBuilderId) => memberBuilderId !== builderId);

  const row = document.createElement('div');
  row.className = 'friend-row';
  const body = document.createElement('div');
  body.className = 'friend-row-body';
  const label = document.createElement('div');
  label.className = 'friend-row-label';
  if (isOwner) {
    label.textContent = otherMembers.length > 0
      ? `Your voice channel — ${otherMembers.map((m) => friendLabelByBuilderId(m, accepted)).join(', ')}`
      : 'Your voice channel (no one has joined yet)';
  } else {
    label.textContent = `In ${friendLabelByBuilderId(active.ownerBuilderId, accepted)}'s voice channel`;
  }
  body.appendChild(label);
  row.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'friend-row-actions';
  const leaveBtn = document.createElement('button');
  leaveBtn.type = 'button';
  leaveBtn.className = 'danger';
  // The owner leaving ends the channel for everyone -- see
  // worker/lib/social.js's handleFriendVoiceChannels for why, same reason
  // this says "End" rather than "Leave" for that case.
  leaveBtn.textContent = isOwner ? 'End' : 'Leave';
  leaveBtn.addEventListener('click', async () => {
    leaveBtn.disabled = true;
    try {
      await leaveFriendVoiceChannel(active.ownerBuilderId);
      await renderFriends();
    } catch (err) {
      friendsStatusEl.textContent = err.message || 'Could not leave the voice channel.';
      friendsStatusEl.classList.add('error');
      leaveBtn.disabled = false;
    }
  });
  actions.appendChild(leaveBtn);
  row.appendChild(actions);
  friendsVoiceChannelStatusEl.appendChild(row);
}

// #257: same missing-re-entrancy-guard shape as #244/#245 —
// renderFriends() is called from many places in quick succession (opening
// the panel, accepting/declining/cancelling a request, closing/reopening
// via friendsCloseBtn's own refreshFriendsBadge()), and each of those
// awaits fetchFriendships() before touching the DOM. An earlier call's
// now-stale response would otherwise append duplicate rows on top of a
// later call's fresh ones once it resolves. Same monotonic-token fix as
// axisPreviewLoadToken/notificationsLoadToken.
let friendsLoadToken = 0;

async function renderFriends() {
  const myLoadToken = ++friendsLoadToken;
  friendsIncomingListEl.innerHTML = '';
  friendsOutgoingListEl.innerHTML = '';
  friendsAcceptedListEl.innerHTML = '';
  if (!builderId) return;
  let friendships;
  try {
    friendships = await fetchFriendships();
  } catch (err) {
    if (myLoadToken !== friendsLoadToken) return; // superseded while loading — a newer call owns the panel now
    friendsStatusEl.textContent = err.message || 'Could not load friends.';
    friendsStatusEl.classList.add('error');
    return;
  }
  if (myLoadToken !== friendsLoadToken) return; // superseded while loading — a newer call owns the panel now
  const incoming = friendships.filter((f) => f.direction === 'incoming' && f.status === 'pending');
  const outgoing = friendships.filter((f) => f.direction === 'outgoing' && f.status === 'pending');
  const accepted = friendships.filter((f) => f.status === 'accepted');

  // #2781: voice-channel membership requires the same id_verified bar as
  // the signaling relay itself (worker/lib/social.js's
  // requireIdVerifiedSessionBuilder) -- skip the fetch entirely rather
  // than let it 403 for a caller who could never use this anyway.
  let friendVoiceChannels = [];
  if (currentAuthUser?.trustTier === 'id_verified') {
    try {
      friendVoiceChannels = await fetchFriendVoiceChannels();
    } catch {
      // Best-effort -- a failed fetch here only means no voice-channel
      // status/buttons this render, not a reason to fail the whole panel.
    }
  }
  if (myLoadToken !== friendsLoadToken) return; // superseded while loading — a newer call owns the panel now
  renderFriendVoiceChannelStatus(friendVoiceChannels, accepted);

  friendsIncomingEmptyEl.hidden = incoming.length > 0;
  for (const friendship of incoming) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const body = document.createElement('div');
    body.className = 'friend-row-body';
    const label = document.createElement('div');
    label.className = 'friend-row-label';
    label.textContent = friendship.otherLabel;
    body.appendChild(label);
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'friend-row-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      try {
        await acceptFriendRequest(friendship.friendshipId);
        await renderFriends();
        await refreshFriendsBadge();
      } catch (err) {
        friendsStatusEl.textContent = err.message || 'Could not accept this friend request.';
        friendsStatusEl.classList.add('error');
        acceptBtn.disabled = false;
      }
    });
    actions.appendChild(acceptBtn);
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'danger';
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', async () => {
      declineBtn.disabled = true;
      try {
        await removeFriendship(friendship.friendshipId);
        await renderFriends();
        await refreshFriendsBadge();
      } catch (err) {
        friendsStatusEl.textContent = err.message || 'Could not decline this friend request.';
        friendsStatusEl.classList.add('error');
        declineBtn.disabled = false;
      }
    });
    actions.appendChild(declineBtn);
    row.appendChild(actions);
    friendsIncomingListEl.appendChild(row);
  }

  friendsOutgoingEmptyEl.hidden = outgoing.length > 0;
  for (const friendship of outgoing) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const body = document.createElement('div');
    body.className = 'friend-row-body';
    const label = document.createElement('div');
    label.className = 'friend-row-label';
    label.textContent = friendship.otherLabel;
    body.appendChild(label);
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'friend-row-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'danger';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      try {
        await removeFriendship(friendship.friendshipId);
        await renderFriends();
      } catch (err) {
        friendsStatusEl.textContent = err.message || 'Could not cancel this friend request.';
        friendsStatusEl.classList.add('error');
        cancelBtn.disabled = false;
      }
    });
    actions.appendChild(cancelBtn);
    row.appendChild(actions);
    friendsOutgoingListEl.appendChild(row);
  }

  friendsAcceptedEmptyEl.hidden = accepted.length > 0;
  for (const friendship of accepted) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const body = document.createElement('div');
    body.className = 'friend-row-body';
    const label = document.createElement('div');
    label.className = 'friend-row-label';
    label.textContent = friendship.otherLabel;
    body.appendChild(label);
    const location = document.createElement('div');
    location.className = 'friend-row-location';
    location.textContent = friendLocationText(friendship);
    body.appendChild(location);
    row.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'friend-row-actions';
    // #1637: DM requires BOTH sides to be trust_tier === 'id_verified' —
    // only this viewer's own tier is known client-side, so the button is
    // gated on that alone; if the other side isn't id_verified, sending
    // still fails with the server's own clear error, shown in dmStatusEl.
    if (currentAuthUser?.trustTier === 'id_verified') {
      const messageBtn = document.createElement('button');
      messageBtn.type = 'button';
      messageBtn.textContent = 'Message';
      messageBtn.addEventListener('click', () => openDmModal(friendship.otherBuilderId, friendship.otherLabel));
      actions.appendChild(messageBtn);

      // #2781: same id_verified gate as Message just above (voice signaling
      // requires it too, worker/lib/social.js's requireIdVerifiedSessionBuilder).
      // Only one of the two buttons below ever shows for a given friend:
      // "Leave Voice" once already a member of THIS friend's channel
      // (friendsVoiceChannelStatusEl above already covers ending/leaving
      // whichever channel is active in general -- this is just the
      // same action, reachable from this friend's own row too), or
      // "Join Voice" only while the caller isn't a member of ANY channel
      // yet -- this simple one-row-per-friend UI doesn't attempt to show
      // "switch channels" or multi-channel membership at once.
      const myChannelWithThisFriend = friendVoiceChannels.find((c) => c.ownerBuilderId === friendship.otherBuilderId);
      if (myChannelWithThisFriend) {
        const leaveVoiceBtn = document.createElement('button');
        leaveVoiceBtn.type = 'button';
        leaveVoiceBtn.textContent = 'Leave Voice';
        leaveVoiceBtn.addEventListener('click', async () => {
          leaveVoiceBtn.disabled = true;
          try {
            await leaveFriendVoiceChannel(friendship.otherBuilderId);
            await renderFriends();
          } catch (err) {
            friendsStatusEl.textContent = err.message || 'Could not leave this voice channel.';
            friendsStatusEl.classList.add('error');
            leaveVoiceBtn.disabled = false;
          }
        });
        actions.appendChild(leaveVoiceBtn);
      } else if (friendVoiceChannels.length === 0) {
        const joinVoiceBtn = document.createElement('button');
        joinVoiceBtn.type = 'button';
        joinVoiceBtn.textContent = 'Join Voice';
        joinVoiceBtn.addEventListener('click', async () => {
          joinVoiceBtn.disabled = true;
          try {
            await joinFriendVoiceChannel(friendship.otherBuilderId);
            await renderFriends();
          } catch (err) {
            friendsStatusEl.textContent = err.message || 'Could not join this voice channel.';
            friendsStatusEl.classList.add('error');
            joinVoiceBtn.disabled = false;
          }
        });
        actions.appendChild(joinVoiceBtn);
      }
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      if (!confirm(`Remove ${friendship.otherLabel} as a friend?`)) return;
      removeBtn.disabled = true;
      try {
        await removeFriendship(friendship.friendshipId);
        await renderFriends();
      } catch (err) {
        friendsStatusEl.textContent = err.message || 'Could not remove this friend.';
        friendsStatusEl.classList.add('error');
        removeBtn.disabled = false;
      }
    });
    actions.appendChild(removeBtn);
    row.appendChild(actions);
    friendsAcceptedListEl.appendChild(row);
  }
}

// #1205: plots every accepted friend's claimed lándlet at once, rather
// than the per-friend inline text friendLocationText already shows.
// Deliberately a plain 2D canvas, not a three.js scene like the claim
// flyover's own world map (loadLandletMap) — that one needs a full WebGL
// renderer because it draws every landlet's real polygon with click-to-
// select/confirm wiring; this only needs to plot a handful of already-known
// (x, y) points with labels, which a 2D canvas context does directly with
// no scene/camera/renderer setup at all. World-radius-scaled the same way
// the claim flyover sizes itself, just via a linear 2D transform instead of
// a 3D camera. A friend with no claimed lándlet (otherLandlet null) is
// simply omitted, same as friendLocationText's own "hasn't claimed a
// lándlet yet" case — there's no position to plot for them.
//
// #1348: closing and quickly reopening the map modal fires a second
// drawFriendsMap() before the first's own fetch has resolved — the same
// stale-response-lands-after-a-fresher-one race renderFriends/renderSignPosts/
// renderCalendarEvents already guard against with their own load token. No
// guard existed here, so the earlier (slower) call's response could still
// clear the canvas and redraw with stale points on top of the later call's
// already-correct ones.
let friendsMapLoadToken = 0;
async function drawFriendsMap() {
  const myLoadToken = ++friendsMapLoadToken;
  let world;
  let friendships;
  try {
    [world, friendships] = await Promise.all([fetchWorld(), fetchFriendships()]);
  } catch (err) {
    if (myLoadToken !== friendsMapLoadToken) return; // superseded while loading — a newer call owns the map now
    console.warn('Could not load the friends map:', err);
    friendsMapEmptyEl.textContent = err.message || 'Could not load the friends map.';
    friendsMapEmptyEl.hidden = false;
    return;
  }
  if (myLoadToken !== friendsMapLoadToken) return; // superseded while loading — a newer call owns the map now
  const located = friendships.filter((f) => f.status === 'accepted' && f.otherLandlet);
  friendsMapEmptyEl.hidden = located.length > 0;
  // #1252: clear any stale canvas content/points from a previous render
  // before the early return below -- otherwise reopening the map after
  // going from "has located friends" back to zero left the last drawn
  // dots/labels on screen underneath the (now-shown) empty-state message,
  // and window.__friendsMapPoints kept pointing at friends who are no
  // longer located.
  friendsMapCanvas.getContext('2d').clearRect(0, 0, friendsMapCanvas.width, friendsMapCanvas.height);
  window.__friendsMapPoints = [];
  if (located.length === 0) return;

  // Matches the canvas's own CSS size (width: 100%, aspect-ratio: 1) in
  // real pixels, so the drawing isn't blurrily upscaled/downscaled from a
  // mismatched default 300x150 canvas backing size.
  const rect = friendsMapCanvas.getBoundingClientRect();
  friendsMapCanvas.width = rect.width;
  friendsMapCanvas.height = rect.height;
  const ctx = friendsMapCanvas.getContext('2d');
  const centerPx = { x: friendsMapCanvas.width / 2, y: friendsMapCanvas.height / 2 };
  // A little inset so a friend right at the world edge doesn't plot a dot
  // half-clipped by the canvas border.
  const pxPerMeter = (Math.min(centerPx.x, centerPx.y) * 0.9) / world.radiusM;
  // World +Y is "up"/North (see updateCompassNeedle's own comment on this
  // app's one existing map-orientation convention) — canvas +Y is down, so
  // the y axis is negated going from world meters to canvas pixels.
  function worldToCanvas(x, y) {
    return { x: centerPx.x + x * pxPerMeter, y: centerPx.y - y * pxPerMeter };
  }

  ctx.clearRect(0, 0, friendsMapCanvas.width, friendsMapCanvas.height);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(centerPx.x, centerPx.y, Math.min(centerPx.x, centerPx.y) * 0.9, 0, Math.PI * 2);
  ctx.stroke();

  // A canvas fillStyle has to be an actual resolved color, not a raw
  // `var(...)` reference the way a stylesheet declaration can use —
  // resolved once here via getComputedStyle rather than per-point below.
  const labelColor = getComputedStyle(document.documentElement).getPropertyValue('--pill-text').trim();

  // #1205's own test diagnostic (same "expose what a test needs to read
  // back" idiom as window.__shopAvatarOrientation/__shopOtherAvatars) —
  // canvas pixel content isn't otherwise inspectable from an e2e test
  // without reading back raw ImageData.
  window.__friendsMapPoints = [];
  for (const friendship of located) {
    const { x, y } = worldToCanvas(friendship.otherLandlet.center.x, friendship.otherLandlet.center.y);
    ctx.fillStyle = '#2f7de1';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = labelColor;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(friendship.otherLabel ?? '', x, y - 10);
    window.__friendsMapPoints.push({ builderId: friendship.otherBuilderId, label: friendship.otherLabel, x, y });
  }
}

function closeFriendsMapModal() {
  friendsMapModalEl.classList.remove('visible');
  closeModalA11y(friendsMapModalEl);
  friendsModalEl.classList.add('visible');
  openModalA11y(friendsModalEl, closeFriendsModal);
}
friendsMapBtn.addEventListener('click', () => {
  friendsModalEl.classList.remove('visible');
  closeModalA11y(friendsModalEl);
  friendsMapModalEl.classList.add('visible');
  openModalA11y(friendsMapModalEl, closeFriendsMapModal);
  drawFriendsMap();
});
friendsMapCloseBtn.addEventListener('click', closeFriendsMapModal);

// Account menu (docs/API.md's "Frontend-only account menu") — the
// Log In/Notices/Friends/Settings buttons above are unchanged in every
// other respect; this only adds the expand/collapse chrome around them.
// Each row's own click handler (accountAuthBtn/notificationsBtn/
// friendsBtn/settingsBtn, all defined elsewhere) already opens its own
// modal, so the only extra behavior needed here is closing the menu once
// a row is picked, and closing it on an outside tap the way every other
// transient popover in this app does.
const accountMenuToggle = document.getElementById('account-menu-toggle');
const accountMenuPanel = document.getElementById('account-menu-panel');
accountMenuToggle.addEventListener('click', () => {
  const expanding = !accountMenuPanel.classList.contains('expanded');
  accountMenuPanel.classList.toggle('expanded');
  accountMenuToggle.classList.toggle('active', accountMenuPanel.classList.contains('expanded'));
  accountMenuToggle.setAttribute('aria-expanded', String(expanding));
  if (expanding) {
    refreshAccountMenuLandCap();
    refreshAccountMenuTaxNotice();
    // #1167 (owner direction, 2026-10-01): My Lands only makes sense from
    // the Build tab, not Shop or Sell — it shipped visible in every mode
    // since nothing here ever gated it on currentMode. Recomputed on open
    // rather than at mode-switch time, same timing refreshAccountMenuLandCap
    // just above already uses for this same panel.
    myLandsBtn.hidden = currentMode !== 'build';
  }
});
for (const row of accountMenuPanel.querySelectorAll('button')) {
  row.addEventListener('click', () => {
    accountMenuPanel.classList.remove('expanded');
    accountMenuToggle.classList.remove('active');
    accountMenuToggle.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', (event) => {
  if (!accountMenuPanel.classList.contains('expanded')) return;
  if (event.target === accountMenuToggle || accountMenuPanel.contains(event.target)) return;
  accountMenuPanel.classList.remove('expanded');
  accountMenuToggle.classList.remove('active');
  accountMenuToggle.setAttribute('aria-expanded', 'false');
});

// #1150 (owner request, 2026-10-01, via a live Control Room conversation):
// a land's name/size were visible while standing on it in Shop mode
// (updateShopLandletInfo above) but nowhere in Build mode at all, and a
// builder who owns more than one claimed landlet (auctions can transfer
// extra ones in — see ownedLandletsByBuilderId's own comment in
// worker/index.js, and resolveLandletId's own comment above) had no way to
// see or switch between them. Same modal shell/row-reuse shape as the
// Settings > Build version-history list just above (.version-row/
// .version-action-btn), and the same plain prompt()-based rename flow as
// renameBuilder/renameSeller/updateCatalogTemplate's own UI call sites.
const myLandsBtn = document.getElementById('my-lands-btn');
const myLandsModalEl = document.getElementById('my-lands-modal');
const myLandsCloseBtn = document.getElementById('my-lands-close-btn');
const myLandsStatusEl = document.getElementById('my-lands-status');
const myLandsListEl = document.getElementById('my-lands-list');
const myLandsEmptyEl = document.getElementById('my-lands-empty');

// Monotonic-token guard, same idiom as friendsLoadToken/notificationsLoadToken
// above: myLandsBtn's click handler calls renderMyLands() directly on every
// click, including while a previous call's fetchAllLandlets() is still in
// flight (rapid double-click, or close-then-reopen before it resolves) — an
// earlier call's now-stale response would otherwise overwrite a later call's
// fresh render.
let myLandsLoadToken = 0;

async function renderMyLands() {
  const myToken = ++myLandsLoadToken;
  myLandsStatusEl.textContent = '';
  myLandsStatusEl.classList.remove('error');
  myLandsEmptyEl.hidden = true;
  myLandsListEl.innerHTML = '<div class="settings-empty-note">Loading…</div>';
  if (!builderId) {
    myLandsListEl.innerHTML = '';
    myLandsEmptyEl.hidden = false;
    return;
  }
  let owned;
  try {
    owned = await fetchAllLandlets({ status: 'claimed', ownerBuilderId: builderId });
  } catch (err) {
    if (myToken !== myLandsLoadToken) return; // superseded while loading — a newer call owns the panel now
    myLandsListEl.innerHTML = '';
    myLandsStatusEl.textContent = err.message || 'Could not load your lands.';
    myLandsStatusEl.classList.add('error');
    return;
  }
  if (myToken !== myLandsLoadToken) return; // superseded while loading — a newer call owns the panel now
  myLandsListEl.innerHTML = '';
  if (owned.length === 0) {
    myLandsEmptyEl.hidden = false;
    return;
  }
  for (const landlet of owned) {
    const row = document.createElement('div');
    row.className = 'version-row';

    const info = document.createElement('div');
    info.className = 'version-row-info';
    // A real <button>, not an <a> — this always goes through the same
    // reload-into-Build dance every mode switch in this file already uses
    // (START_MODE_KEY's own comment), never a same-page navigation.
    const openLink = document.createElement('button');
    openLink.type = 'button';
    openLink.className = 'my-lands-open-link';
    openLink.textContent = landlet.name;
    openLink.addEventListener('click', () => {
      sessionStorage.setItem(BUILD_TARGET_LANDLET_ID_KEY, landlet.landletId);
      sessionStorage.setItem(START_MODE_KEY, 'build');
      location.reload();
    });
    info.appendChild(openLink);
    info.append(` — ${formatArea(landlet.areaM2)}`);
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'version-row-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'version-action-btn';
    renameBtn.type = 'button';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const next = prompt('Rename this land', landlet.name);
      if (!next || !next.trim() || next.trim() === landlet.name) return;
      if (next.trim().length > 100) {
        alert('Keep it to 100 characters or fewer.');
        return;
      }
      myLandsStatusEl.textContent = '';
      myLandsStatusEl.classList.remove('error');
      renameBtn.disabled = true;
      try {
        // #1150: server enforces uniqueness across every landlet, not just
        // this builder's own — a collision surfaces here as the server's
        // own friendly message via requestJson's rejection.
        const updated = await renameLandlet(landlet.landletId, next.trim());
        landlet.name = updated.name;
        openLink.textContent = landlet.name;
      } catch (err) {
        myLandsStatusEl.textContent = err.message || 'Could not rename this land.';
        myLandsStatusEl.classList.add('error');
      } finally {
        renameBtn.disabled = false;
      }
    });
    actions.appendChild(renameBtn);
    row.appendChild(actions);
    myLandsListEl.appendChild(row);
  }
}

myLandsBtn.addEventListener('click', () => {
  myLandsModalEl.classList.add('visible');
  openModalA11y(myLandsModalEl, closeMyLandsModal);
  renderMyLands();
});
function closeMyLandsModal() {
  myLandsModalEl.classList.remove('visible');
  closeModalA11y(myLandsModalEl);
}
myLandsCloseBtn.addEventListener('click', closeMyLandsModal);

function closeFriendsModal() {
  friendsModalEl.classList.remove('visible');
  refreshFriendsBadge();
  // #1661: openDmModal is only reached from inside this panel, so this is
  // also a natural point to re-sync the DM badge for anyone who read a
  // thread and is now backing out to the top-level menu.
  refreshDmBadge();
  closeModalA11y(friendsModalEl);
}
friendsBtn.addEventListener('click', () => {
  friendsModalEl.classList.add('visible');
  openModalA11y(friendsModalEl, closeFriendsModal);
  friendsStatusEl.textContent = '';
  friendsStatusEl.classList.remove('error');
  renderFriends();
});
friendsCloseBtn.addEventListener('click', closeFriendsModal);
friendsAddBtn.addEventListener('click', async () => {
  const label = prompt("Friend's name (must match their identity exactly):", '');
  if (!label || !label.trim()) return;
  friendsStatusEl.textContent = '';
  friendsStatusEl.classList.remove('error');
  friendsAddBtn.disabled = true;
  try {
    const trimmed = label.trim();
    const matches = await fetchBuilders({ label: trimmed });
    if (matches.length === 0) {
      friendsStatusEl.textContent = `No builder named "${trimmed}" found.`;
      friendsStatusEl.classList.add('error');
      return;
    }
    // Builder labels have no uniqueness constraint (migrations/0054's own
    // comment: "a unique label was never even guaranteed") — docs/API.md's
    // "unmatched or ambiguous label surfaces as a status message rather
    // than a dead end" promise covers this case explicitly, so more than
    // one match must never silently resolve to whichever one happened to
    // sort first.
    if (matches.length > 1) {
      friendsStatusEl.textContent = `Multiple builders are named "${trimmed}" — ask them to rename to something unique before sending a request.`;
      friendsStatusEl.classList.add('error');
      return;
    }
    const match = matches[0];
    await sendFriendRequest(match.builderId);
    friendsStatusEl.textContent = `Friend request sent to ${match.label}.`;
    await renderFriends();
  } catch (err) {
    friendsStatusEl.textContent = err.message || 'Could not send friend request.';
    friendsStatusEl.classList.add('error');
  } finally {
    friendsAddBtn.disabled = false;
  }
});
