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
import { fetchNearbyChatMessages, sendNearbyChatMessage } from '../api.js';

const NEARBY_CHAT_POLL_INTERVAL_MS = 2000;

const chatBtnEl = document.getElementById('shop-nearby-chat-btn');
const chatPanelEl = document.getElementById('shop-nearby-chat-panel');
const chatLogEl = document.getElementById('shop-nearby-chat-log');
const chatFormEl = document.getElementById('shop-nearby-chat-form');
const chatInputEl = document.getElementById('shop-nearby-chat-input');

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
  const line = document.createElement('div');
  line.className = 'shop-nearby-chat-message';
  line.classList.toggle('own', ownMessageIds.has(message.messageId));
  line.textContent = message.text;
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
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
    chatInputEl.value = '';
    sendNearbyChatMessage(text).then((message) => {
      ownMessageIds.add(message.messageId);
      appendMessage(message);
    }).catch(() => {});
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
  }).catch(() => {});
}
