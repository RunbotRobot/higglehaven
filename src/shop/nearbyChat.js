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
import { confirmAndBlockPerson } from '../blocks.js';
import { createPersistentMuteSet } from './mutePersistence.js';
import { assistantNameFrom, assistantSpeakerLabel } from './assistantLabel.js';
import { promptReportReason } from '../ui/reportReasonModal.js';
import { showNotice } from '../ui/noticeModal.js';
import { showInlineActionStatus } from '../ui/inlineActionStatus.js';
import { addBudPetals, openLeaf, setBudWord, clearBudWord } from '../ui/bud.js';

const NEARBY_CHAT_POLL_INTERVAL_MS = 2000;

const chatPanelEl = document.getElementById('shop-nearby-chat-panel');
const chatLogEl = document.getElementById('shop-nearby-chat-log');
const chatEmptyEl = document.getElementById('shop-nearby-chat-empty');
// #3875: with nobody having spoken, the panel says what it is for instead of showing an empty box.
function syncChatEmpty() {
  if (chatEmptyEl) chatEmptyEl.hidden = chatLogEl.querySelector('.shop-nearby-chat-message') !== null;
}
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
// carry no sender name (this chat is deliberately unlabeled, except that an
// assistant's lines say "<name> · assistant", #3445), so the list
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
  // #3445: an assistant's lines say so ("Juniper · assistant"); every other
  // sender stays unlabeled, as this chat has always been. The server derives
  // the flag; a client cannot claim it.
  const assistantName = assistantNameFrom(message.assistant);
  if (assistantName) {
    const speakerEl = document.createElement('span');
    speakerEl.className = 'shop-nearby-chat-message-speaker';
    speakerEl.textContent = assistantSpeakerLabel(assistantName);
    line.appendChild(speakerEl);
  }
  const textEl = document.createElement('span');
  textEl.className = 'shop-nearby-chat-message-text';
  textEl.textContent = message.text;
  line.appendChild(textEl);
  // #2956: parity with proximity voice chat's own per-peer mute+report
  // pair (#2819) -- can't mute or report yourself.
  if (!isOwn) {
    const actionsEl = document.createElement('span');
    actionsEl.className = 'shop-nearby-chat-message-actions';
    // #3551: the actions stay out of the way until the line is tapped, so the
    // text gets the panel's full width. The text is the control that reveals
    // them (keyboard and screen reader reach it as a button that says whether
    // the actions are shown); the buttons themselves are unchanged.
    actionsEl.hidden = true;
    textEl.tabIndex = 0;
    textEl.setAttribute('role', 'button');
    textEl.setAttribute('aria-expanded', 'false');
    actionsEl.innerHTML = '<button type="button" data-action="mute" title="Mute this sender">Mute</button>'
      + '<button type="button" data-action="report" title="Report this sender">Report</button>'
      + '<button type="button" data-action="block" title="Block this person">Block</button>';
    line.appendChild(actionsEl);
  }
  chatLogEl.appendChild(line);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  syncChatEmpty();
}

// #3551: one line shows its actions at a time. Tapping the line again, or
// another line, hides them. Ignored while the person is selecting text, so
// copying part of a message (#3303) never pops the actions open.
function setLineActionsOpen(line, open) {
  const actionsEl = line.querySelector('.shop-nearby-chat-message-actions');
  const textEl = line.querySelector('.shop-nearby-chat-message-text');
  if (!actionsEl || !textEl) return;
  actionsEl.hidden = !open;
  textEl.setAttribute('aria-expanded', String(open));
  line.classList.toggle('actions-open', open);
}
function toggleLineActions(line) {
  const open = !line.classList.contains('actions-open');
  chatLogEl.querySelectorAll('.shop-nearby-chat-message.actions-open').forEach((other) => {
    if (other !== line) setLineActionsOpen(other, false);
  });
  setLineActionsOpen(line, open);
}

// #2956: removes any of this builder's messages already rendered in the
// log -- muting should take effect on what's already visible, not just
// future messages, same as voice's own gainNode.gain.value=0 applies
// immediately to an already-connected peer.
function removeMessagesFromBuilder(builderId) {
  chatLogEl.querySelectorAll(`.shop-nearby-chat-message[data-builder-id="${builderId}"]`)
    .forEach((el) => el.remove());
  syncChatEmpty();
}

// Same report flow voiceChat.js's reportVoicePeer uses for this action.
async function reportNearbyChatSender(builderId, lineEl) {
  // #3359: in-app modal and notices, not window.prompt()/alert() -- a browser
  // that suppresses native dialogs made reporting impossible and dropped the
  // outcome. A cancelled modal (null) submits nothing.
  const answer = await promptReportReason({ title: 'Report this nearby chat sender for inappropriate conduct?' });
  if (answer === null) return;
  try {
    await sendNearbyChatReport({ reportedBuilderId: builderId, reason: answer.reason || undefined });
    // #3889: said on the message that was reported, in the chat leaf, not a
    // pill over the world.
    if (lineEl?.isConnected) showInlineActionStatus(lineEl, 'Report sent. Thank you.', { error: false });
  } catch (err) {
    await showNotice({ title: 'Couldn\'t submit the report', message: err?.message || 'Try again.' });
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
  syncChatEmpty();
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
  chatLogEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const textEl = event.target.closest?.('.shop-nearby-chat-message-text[role="button"]');
    const line = textEl?.closest('.shop-nearby-chat-message');
    if (!line) return;
    event.preventDefault();
    toggleLineActions(line);
  });
  chatLogEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('[data-builder-id]');
    if (!button && row && event.target.closest('.shop-nearby-chat-message-text[role="button"]')) {
      if (String(window.getSelection?.() ?? '') === '') toggleLineActions(row);
      return;
    }
    if (!button || !row) return;
    const builderId = row.dataset.builderId;
    if (button.dataset.action === 'mute') {
      mutedBuilderIds.add(builderId);
      removeMessagesFromBuilder(builderId);
      renderMutedList();
    } else if (button.dataset.action === 'report') {
      setLineActionsOpen(row, false);
      reportNearbyChatSender(builderId, row);
    } else if (button.dataset.action === 'block') {
      // #3140: what makes a block take effect everywhere is #3143; here the
      // blocker simply stops seeing what is already on screen from them.
      confirmAndBlockPerson(builderId).then((blocked) => {
        if (blocked) removeMessagesFromBuilder(builderId);
      });
    }
  });
}

// #3556 (part of #3539): the way in is the Chat petal of the flower, not a pill on the world. The
// panel waits, hidden, in the page; the leaf borrows it while it is open and hands it back as it
// closes (the same lending the Build leaves use), so every element and handler here is unchanged.
// The microphone and the list of voices nearby (src/shop/voiceChat.js owns them) are lent the same
// way, so the leaf is the one place for talking to people nearby, in text or by voice. While the
// microphone is on the head says so and is a door back to the leaf, one tap from muting. A person
// who is not ID-verified is told so in the leaf instead of being shown controls that can only
// refuse them.
const homeOf = (el) => (el ? { el, parent: el.parentNode, next: el.nextSibling } : null);
const voiceBtnEl = document.getElementById('shop-voice-btn');
const voicePanelEl = document.getElementById('shop-voice-peers-panel');
const lentHomes = [homeOf(chatPanelEl), homeOf(voiceBtnEl), homeOf(voicePanelEl)].filter(Boolean);

function openChatLeaf() {
  openLeaf({
    id: 'chat',
    title: 'Chat',
    render: (body) => {
      if (!hasIdVerifiedSession()) {
        const note = document.createElement('p');
        note.className = 'bud-chat-note';
        note.textContent = 'Chatting with people nearby, by text or by voice, opens once your ID is verified.';
        body.append(note);
        return;
      }
      chatOpen = true;
      chatLastPollAt = 0; // the first poll is not made to wait for the interval
      chatPanelEl.classList.add('open');
      body.append(chatPanelEl);
      if (voiceBtnEl) {
        const row = document.createElement('div');
        row.className = 'bud-voice-row';
        const words = document.createElement('span');
        words.className = 'bud-voice-words';
        const sync = () => { words.textContent = voiceBtnEl.getAttribute('aria-label') || 'Microphone'; };
        sync();
        new MutationObserver(sync).observe(voiceBtnEl, { attributes: true, attributeFilter: ['aria-label'] });
        row.append(voiceBtnEl, words);
        body.append(row);
      }
      if (voicePanelEl) body.append(voicePanelEl);
    },
    onClose: () => {
      chatOpen = false;
      chatPanelEl.classList.remove('open');
      for (const home of lentHomes) home.parent.insertBefore(home.el, home.next); // back where the page keeps them
    },
  });
}

// While the microphone is on the head says so, and tapping it opens the leaf to mute.
if (voiceBtnEl) {
  new MutationObserver(() => {
    const on = voiceBtnEl.classList.contains('unmuted') || voiceBtnEl.classList.contains('speaking');
    if (on) setBudWord('voice', 'Mic on', { open: openChatLeaf, label: 'Microphone is on. Open chat to mute it.' });
    else clearBudWord('voice');
  }).observe(voiceBtnEl, { attributes: true, attributeFilter: ['class'] });
}

if (chatPanelEl) {
  addBudPetals('shop', [{ id: 'chat', label: 'Chat', run: openChatLeaf }]);
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
      chatStatusEl.textContent = err.message || 'Couldn\'t send this message.';
      chatStatusEl.classList.add('error');
    });
  });
}

// Called every Shop-mode render tick (see updateShopMovement in
// src/shop/flightMovement.js), same unawaited "never stall the render loop
// on a slow/failed request" shape pollNearbyPresenceIfNeeded already uses.
// Polls only while the Chat leaf is open and the account is ID-verified, read live off
// currentAuthUser's trust tier, so it starts working the instant a shopper finishes
// verification mid-session, with no extra wiring.
export function pollNearbyChatIfNeeded(now) {
  if (!chatPanelEl) return;
  if (!hasIdVerifiedSession()) return;
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
      syncChatEmpty();
    }
    if (result.nextCursor) chatCursor = result.nextCursor;
    result.messages.forEach(appendMessage);
    // #3128: the signed-in account isn't known at module load, so the persisted
    // list is (re)drawn here, once a poll proves the account is live.
    renderMutedList();
  }).catch(() => {});
}
