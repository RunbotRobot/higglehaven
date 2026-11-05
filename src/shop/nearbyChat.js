// #2779 (sub-issue of #2777, proximity voice chat + general text chat):
// docs/SPEC.md §2's "Text chat available as an alternative [to voice]" --
// a nearby-avatars-only (not friend-only, not DM) chat log + input in Shop
// mode. Landlet scoping happens entirely server-side
// (worker/lib/social.js's handleNearbyChat derives it from the caller's
// own last-reported avatar_presence row, same #2269 anti-spoof pattern
// GET /api/presence already uses) -- this module never needs to know or
// send a landletId itself.
//
// A fully self-contained leaf, same shape src/feedback/submitFeedbackUI.js
// already established (see that module's own comment on why): brand-new
// markup with no main.js legacy to respect, so it looks its own elements
// up and wires its own listeners here at module scope, rather than
// routing through main.js/mode.js the way the older shop/*.js leaves do.
import { currentAuthUser } from '../account/auth.js';
import { fetchNearbyChatMessages, sendNearbyChatMessage, sendNearbyChatReport } from '../api.js';
import { createPersistentMuteSet } from './mutePersistence.js';

const NEARBY_CHAT_POLL_INTERVAL_MS = 2000;

const chatBtnEl = document.getElementById('shop-nearby-chat-btn');
const chatPanelEl = document.getElementById('shop-nearby-chat-panel');
const chatLogEl = document.getElementById('shop-nearby-chat-log');
const chatStatusEl = document.getElementById('shop-nearby-chat-status');
const chatFormEl = document.getElementById('shop-nearby-chat-form');
const chatInputEl = document.getElementById('shop-nearby-chat-input');
const mutedWrapEl = document.getElementById('shop-nearby-chat-muted');
const mutedToggleEl = document.getElementById('shop-nearby-chat-muted-toggle');
const mutedListEl = document.getElementById('shop-nearby-chat-muted-list');

let chatOpen = false;
let chatLastPollAt = 0;
let chatCursor = null;
// #2802: undefined (not null) so the very first poll's response -- whose
// landletId may legitimately already be null ("no nearby landlet") -- is
// never mistaken for a landlet change against this placeholder.
let chatLastKnownLandletId;
// Same monotonic-guard idiom presencePollToken (presenceAndContent.js)/
// friendsLoadToken/dmLoadToken (src/account/menu.js) already use elsewhere
// in this codebase -- discards a slower, earlier poll's response landing
// after a newer one already updated the log.
let chatPollToken = 0;
const seenMessageIds = new Set();
const ownMessageIds = new Set();
// #2956: parity with proximity voice chat's own mutedPeers (voiceChat.js).
// A muted sender's messages are fully removed from the flat chat log (not
// just silenced). #3128: the mute is kept per signed-in account in
// localStorage (src/shop/mutePersistence.js) so a reload no longer brings the
// sender back, and a "Muted (N)" list in the panel offers Unmute -- messages
// carry no sender name (this chat is deliberately unlabeled), so the list
// numbers the muted senders instead. Never sent to the server.
const mutedBuilderIds = createPersistentMuteSet('nearby-chat', () => currentAuthUser?.userId ?? null);

// #1637's own DM gate requires trust_tier === 'id_verified' specifically --
// docs/SPEC.md §6: "Full social features (voice, messaging, direct
// communication) require government-ID verification specifically."
// Stricter than most other Shop-mode features' own "logged in and any
// non-'none' tier" bar (hasVerifiedSession in presenceAndContent.js).
function hasIdVerifiedSession() {
  return currentAuthUser?.trustTier === 'id_verified';
}

function appendMessage(message) {
  if (seenMessageIds.has(message.messageId)) return;
  seenMessageIds.add(message.messageId);
  if (mutedBuilderIds.has(message.builderId)) return; // #2956: suppress a muted sender's messages
  const isOwn = ownMessageIds.has(message.messageId);
  const line = document.createElement('div');
  line.className = 'shop-nearby-chat-message';
  line.classList.toggle('own', isOwn);
  line.dataset.builderId = message.builderId;
  const textEl = document.createElement('span');
  textEl.className = 'shop-nearby-chat-message-text';
  textEl.textContent = message.text;
  line.appendChild(textEl);
  // #2956: parity with proximity voice chat's own per-peer mute+report
  // pair (#2819) -- can't mute or report yourself.
  if (!isOwn) {
    const actionsEl = document.createElement('span');
    actionsEl.className = 'shop-nearby-chat-message-actions';
    actionsEl.innerHTML = '<button type="button" data-action="mute" title="Mute this sender">Mute</button>'
      + '<button type="button" data-action="report" title="Report this sender">Report</button>';
    line.appendChild(actionsEl);
  }
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

// #2956: removes any of this builder's messages already rendered in the
// log -- muting should take effect on what's already visible, not just
// future messages, same as voice's own gainNode.gain.value=0 applies
// immediately to an already-connected peer.
function removeMessagesFromBuilder(builderId) {
  chatLogEl.querySelectorAll(`.shop-nearby-chat-message[data-builder-id="${builderId}"]`)
    .forEach((el) => el.remove());
}

// Same prompt()-based lightweight text-input convention voiceChat.js's own
// reportVoicePeer already uses for this exact action -- see that module's
// comment for why a bespoke modal isn't used here either.
async function reportNearbyChatSender(builderId) {
  const reason = window.prompt(
    'Report this nearby chat sender for inappropriate conduct? Optionally describe why (up to 280 characters), or leave blank:', '',
  );
  if (reason === null) return; // cancelled
  try {
    await sendNearbyChatReport({ reportedBuilderId: builderId, reason: reason.trim() || undefined });
    window.alert('Report submitted. Thank you.');
  } catch {
    window.alert('Could not submit the report -- please try again.');
  }
}

// #3128: the "Muted (N)" control. Hidden entirely while nothing is muted.
// Called on every poll, so it only touches the DOM when the set changed (a
// redraw mid-click would swap the Unmute button out from under the pointer).
let renderedMutedSignature = '';
function renderMutedList() {
  if (!mutedWrapEl) return;
  const ids = mutedBuilderIds.values();
  const signature = ids.join('|');
  if (signature === renderedMutedSignature) return;
  renderedMutedSignature = signature;
  mutedWrapEl.hidden = ids.length === 0;
  if (ids.length === 0) {
    mutedListEl.hidden = true;
    mutedToggleEl.setAttribute('aria-expanded', 'false');
    return;
  }
  mutedToggleEl.textContent = `Muted (${ids.length})`;
  mutedListEl.replaceChildren(...ids.map((builderId, index) => {
    const row = document.createElement('div');
    row.className = 'shop-nearby-chat-muted-row';
    row.dataset.builderId = builderId;
    const label = document.createElement('span');
    label.textContent = `Muted sender ${index + 1}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'unmute';
    button.textContent = 'Unmute';
    row.append(label, button);
    return row;
  }));
}

// Messages from a sender muted earlier were skipped (but marked seen), so
// after an unmute the log is rebuilt from the server's recent history.
function resetChatLog() {
  chatCursor = null;
  seenMessageIds.clear();
  chatLogEl.replaceChildren();
}

if (mutedToggleEl) {
  mutedToggleEl.addEventListener('click', () => {
    mutedListEl.hidden = !mutedListEl.hidden;
    mutedToggleEl.setAttribute('aria-expanded', String(!mutedListEl.hidden));
  });
  mutedListEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="unmute"]');
    const row = event.target.closest('[data-builder-id]');
    if (!button || !row) return;
    mutedBuilderIds.delete(row.dataset.builderId);
    renderMutedList();
    resetChatLog();
  });
}

if (chatLogEl) {
  chatLogEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('[data-builder-id]');
    if (!button || !row) return;
    const builderId = row.dataset.builderId;
    if (button.dataset.action === 'mute') {
      mutedBuilderIds.add(builderId);
      removeMessagesFromBuilder(builderId);
      renderMutedList();
    } else if (button.dataset.action === 'report') {
      reportNearbyChatSender(builderId);
    }
  });
}

if (chatBtnEl) {
  chatBtnEl.addEventListener('click', () => {
    chatOpen = !chatOpen;
    chatPanelEl.classList.toggle('open', chatOpen);
  });
  chatFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = chatInputEl.value.trim();
    if (!text) return;
    chatStatusEl.textContent = '';
    chatStatusEl.classList.remove('error');
    // #2796: the input is no longer cleared until the send actually
    // resolves -- previously cleared optimistically, so a rejection (rate
    // limit, stale presence, network) silently dropped the typed message
    // with no trace and no way to retry it, same failure shape the
    // credit-orb rate-limit bug (#2774) had. Mirrors dmComposeForm's own
    // submit handler (src/account/menu.js), the structurally identical
    // DM-send case, which already gets this right.
    sendNearbyChatMessage(text).then((message) => {
      chatInputEl.value = '';
      ownMessageIds.add(message.messageId);
      appendMessage(message);
    }).catch((err) => {
      chatStatusEl.textContent = err.message || 'Could not send this message.';
      chatStatusEl.classList.add('error');
    });
  });
}

// Called every Shop-mode render tick (see updateShopMovement in
// src/shop/flightMovement.js), same unawaited "never stall the render loop
// on a slow/failed request" shape pollNearbyPresenceIfNeeded already uses.
// Drives the toggle button's own visibility live off currentAuthUser's
// trust tier (rather than a one-time reveal from src/shop/mode.js like the
// fly button/feedback button), so it starts working the instant a shopper
// finishes ID verification mid-session, with no extra wiring.
export function pollNearbyChatIfNeeded(now) {
  if (!chatBtnEl) return;
  const available = hasIdVerifiedSession();
  chatBtnEl.classList.toggle('visible', available);
  if (!available) {
    if (chatOpen) {
      chatOpen = false;
      chatPanelEl.classList.remove('open');
    }
    return;
  }
  if (!chatOpen) return;
  if (now - chatLastPollAt < NEARBY_CHAT_POLL_INTERVAL_MS) return;
  chatLastPollAt = now;
  const myToken = ++chatPollToken;
  fetchNearbyChatMessages({ cursor: chatCursor }).then((result) => {
    if (myToken !== chatPollToken) return;
    // #2802: the cursor/seen-message/log state above is only ever
    // meaningful scoped to one landlet -- the server's own cursor query is
    // bound to whichever landlet it computed the response for (worker/lib/
    // social.js's handleNearbyChat), so applying a cursor left over from a
    // landlet the shopper has since left against a new one silently skips
    // that new landlet's own already-older messages and mixes both
    // conversations into one unlabeled log. Reset everything the moment
    // the reported landlet changes, including from/to null (no nearby
    // landlet), before appending this response's own messages.
    if (result.landletId !== chatLastKnownLandletId) {
      chatLastKnownLandletId = result.landletId;
      chatCursor = null;
      seenMessageIds.clear();
      chatLogEl.replaceChildren();
    }
    if (result.nextCursor) chatCursor = result.nextCursor;
    result.messages.forEach(appendMessage);
    // #3128: the signed-in account isn't known at module load, so the persisted
    // list is (re)drawn here, once a poll proves the account is live.
    renderMutedList();
  }).catch(() => {});
}
