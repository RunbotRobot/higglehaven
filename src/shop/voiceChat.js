// #2818 (sub-issue of #2780, itself sub-issue of #2777, proximity voice
// chat): the client-side WebRTC core — RTCPeerConnection management, mic
// permission UX, and the distance-based gain curve. Consumes #2817's
// backend signaling relay (POST/GET /api/voice/signal) and #2818's own
// ICE-config endpoint (GET /api/voice/ice-config).
//
// A fully self-contained leaf, same shape src/shop/nearbyChat.js already
// established (see that module's own comment on why) — brand-new markup
// with no main.js legacy to respect.
//
// Who to connect to, and flying-avatar exclusion: this module never polls
// positions itself — it reuses shopOtherAvatars (src/shop/
// presenceAndContent.js), the exact same Map pollNearbyPresenceIfNeeded
// already maintains for rendering other avatars. GET /api/presence already
// excludes flying avatars server-side (#2043), so an avatar that's
// currently flying simply never appears in shopOtherAvatars at all —
// voice connections are only ever opened against entries already present
// there, so flying-avatar exclusion comes for free with no separate check.
//
// Negotiation: the "perfect negotiation" pattern (MDN's own reference
// implementation) — each side independently decides whether it's "polite"
// by comparing builder ids (the side with the lexicographically smaller
// id is polite), and the polite side rolls back its own in-flight offer on
// a glare collision instead of ignoring the incoming one. This avoids
// needing an explicit "who initiates" handshake message of its own; both
// sides can call addTrack/addTransceiver independently and let
// onnegotiationneeded sort it out.
import { currentAuthUser } from '../account/auth.js';
import {
  fetchMyBuilder, sendVoiceSignal, fetchVoiceSignals, fetchVoiceIceConfig, sendVoiceReport,
  fetchFriendVoiceChannels, joinFriendVoiceChannel as apiJoinFriendVoiceChannel,
  leaveFriendVoiceChannel as apiLeaveFriendVoiceChannel,
} from '../api.js';
import { shopOtherAvatars } from './presenceAndContent.js';
import { shopAvatarPosition } from '../main.js';

// docs/SPEC.md §2: "100 feet (~30m) of complete silence as the outer
// range, with volume ramping up gradually as avatars get closer — not a
// hard cutoff, and not full volume at max range either." 100ft = 30.48m.
const VOICE_RANGE_M = 30.48;
// Full volume only within real conversational distance, not the entire
// range — per the SPEC quote above ("not full volume at max range
// either"); the ramp covers everything between this and VOICE_RANGE_M.
const VOICE_FULL_VOLUME_RADIUS_M = 3;
// Hysteresis gap between opening a connection (at VOICE_RANGE_M) and
// tearing it down (past this) — same enter-at-one-distance/exit-at-a-
// farther-one shape SHOP_MIDDLE_LOD_ENTER_RADIUS_M/EXIT_RADIUS_M
// (presenceAndContent.js) already use, so a peer hovering right at the
// range boundary doesn't thrash connections open/closed every frame.
const VOICE_DISCONNECT_RADIUS_M = 36;
// Comparable cadence to the other Shop-mode poll loops (SHOP_PRESENCE_
// POLL_INTERVAL_MS-shaped) — signaling only needs to be timely enough for
// a connection setup (a few seconds), not frame-rate fast.
const VOICE_POLL_INTERVAL_MS = 1200;
// Rough volume-activity heuristic for the "speaking" indicator — an RMS
// deviation from silence on the local mic's own time-domain samples, not
// real voice-activity detection. Tuned loosely; this only drives a cosmetic
// icon state, not anything the connection/gain logic depends on.
const VOICE_SPEAKING_RMS_THRESHOLD = 0.03;
// A connection that hasn't reached 'connected' within this long of its own
// creation gets torn down (and, since the peer is presumably still nearby,
// freshly recreated on the very next updateVoicePeersForRange call) rather
// than left to sit stuck forever. Covers any stall, on either side of the
// handshake, for any reason -- including a native RTCPeerConnection call
// (setRemoteDescription, observed directly) that simply never resolves or
// rejects, confirmed via explicit tracing while validating this feature's
// own e2e test (see createPeer's own comment on the transceiver-timing
// hypothesis this ruled out). Comfortably above how long a real handshake
// normally takes (a couple of VOICE_POLL_INTERVAL_MS round trips), with
// enough margin below this module's own e2e test's 20s per-connection wait
// for a fresh retry to still succeed within that same test run.
const VOICE_NEGOTIATION_TIMEOUT_MS = 8000;

// #2781 (sub-issue of #2777): "Group voice channels for friends regardless
// of proximity" (docs/SPEC.md §2) -- extends this module's own
// proximity-gated peers (above) with a second, independent kind of peer:
// one joined by shared membership in a friend voice channel (worker/lib/
// social.js's handleFriendVoiceChannels/sharedActiveFriendVoiceChannelExists),
// not by live distance. A peer entry's own `channelOwnerBuilderId` (set at
// creation, never cleared while the connection lives) is what tells every
// other function in this file which kind it's looking at: set means "never
// torn down or gain-ramped by distance, full volume always" (no
// distance-based volume ramp here, per SPEC's own "regardless of
// proximity" wording); unset means the ordinary proximity peer logic
// above still applies in full.
//
// Reconciliation (reconcileFriendVoiceChannels below) runs on its own
// setInterval, not gated behind updateShopVoiceChatIfNeeded's per-frame
// Shop-mode tick -- a friend group call should keep receiving/relaying
// signals even while the caller isn't actively moving around Shop mode at
// all (or even necessarily rendering it), since "regardless of proximity"
// extends to not needing to be nearby in the same render loop either.
const FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS = VOICE_POLL_INTERVAL_MS;

const voiceBtnEl = document.getElementById('shop-voice-btn');
const voiceBtnIconEl = document.getElementById('shop-voice-btn-icon');
const voicePeersPanelEl = document.getElementById('shop-voice-peers-panel');
const voicePeersListEl = document.getElementById('shop-voice-peers-list');

// 'muted' (default every session, per #2778's resolution — no auto-
// activate-on-proximity) | 'unmuted' | 'denied' (getUserMedia failed/was
// refused) | 'requesting' (getUserMedia prompt in flight).
let micState = 'muted';
let localStream = null;
let micAnalyser = null;
let micAnalyserData = null;
let isSpeaking = false;

let myBuilderId = null;
let myBuilderIdPromise = null;
let iceServersPromise = null;
let audioCtx = null;

// builderId -> { pc, polite, makingOffer, ignoreOffer, sourceNode, gainNode,
// createdAt, displaySeq, channelOwnerBuilderId }. `channelOwnerBuilderId` is
// null for an ordinary proximity peer, or the owning builderId of the
// friend voice channel (#2781) this peer connection belongs to -- see this
// module's own FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS comment above.
const peers = new Map();
// builderId -> in-flight Promise<entry>, while getOrCreatePeer's own async
// setup (ensureMyBuilderId/ensureIceServers) hasn't resolved yet -- see
// that function's own comment for the race this guards against.
const pendingPeers = new Map();
let voiceSignalCursor = null;
let voiceLastPollAt = 0;
let voicePollToken = 0;
// #2819: a stable, ever-increasing label for each connection's own
// lifetime (createPeer assigns the next one) -- shopOtherAvatars/presence
// carries no display name at all (nearby chat's own deliberately
// "unlabeled" precedent, src/shop/nearbyChat.js), so this is the only
// thing distinguishing one connected peer from another in the mute/report
// panel below; re-using builderId itself there would leak an otherwise
// anonymous identifier into the UI for no benefit.
let voicePeerSeq = 0;
// builderId -> locally muted (#2819's per-shopper mute) -- purely
// client-side, never reaches the server, and scoped to one connection's
// own lifetime (cleared in teardownPeer): reconnecting to the same
// builder after they leave and come back starts unmuted again, same as a
// fresh RTCPeerConnection would. Applies uniformly to a proximity peer or
// a friend-channel peer (#2781) alike -- see desiredGainFor below.
const mutedPeers = new Set();
// #2781: last-known result of GET /voice/friend-channels, refreshed by
// reconcileFriendVoiceChannels below -- src/account/menu.js's friends
// panel reads this (via getActiveFriendVoiceChannels) to render current
// channel membership without polling the endpoint a second time itself.
let myFriendVoiceChannels = [];

function hasIdVerifiedSession() {
  return currentAuthUser?.trustTier === 'id_verified';
}

function ensureMyBuilderId() {
  if (myBuilderIdPromise) return myBuilderIdPromise;
  myBuilderIdPromise = fetchMyBuilder().then((builder) => {
    myBuilderId = builder.builderId;
    return myBuilderId;
  }).catch((err) => {
    myBuilderIdPromise = null; // allow a retry on the next call
    throw err;
  });
  return myBuilderIdPromise;
}

function ensureIceServers() {
  if (iceServersPromise) return iceServersPromise;
  iceServersPromise = fetchVoiceIceConfig().catch((err) => {
    iceServersPromise = null; // allow a retry on the next call
    throw err;
  });
  return iceServersPromise;
}

function ensureAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Browsers suspend a freshly-created (or backgrounded) AudioContext until
  // a user gesture resumes it — best-effort; a rejected resume() here just
  // means remote audio stays silent until the next gesture-driven call
  // (e.g. the mic button click) retries it.
  audioCtx.resume().catch(() => {});
  return audioCtx;
}

function refreshVoicePeersDiagnostic() {
  // Read-only diagnostic for e2e tests, same shape window.__shopOtherAvatars
  // (presenceAndContent.js) already establishes — a real two-peer WebRTC
  // connection needs two separate browser sessions to observe, so a test
  // can't just read local in-memory state the way a single-session feature
  // would.
  window.__shopVoicePeers = [...peers.entries()].map(([builderId, entry]) => ({
    builderId, connectionState: entry.pc.connectionState, signalingState: entry.pc.signalingState,
    iceConnectionState: entry.pc.iceConnectionState, polite: entry.polite,
    // #2819: this module's own mute toggle state for the same reason the
    // rest of this diagnostic exists -- a real two-peer connection can't be
    // observed from the test's own in-page state.
    muted: mutedPeers.has(builderId),
    // #2781: present only for a friend-voice-channel peer -- lets an e2e
    // test (or this module's own future debugging) tell one apart from an
    // ordinary proximity peer without reaching into internals.
    channelOwnerBuilderId: entry.channelOwnerBuilderId || null,
    // #2834: the actual applied gain -- null until attachRemoteStream has
    // run (no remote track received yet). Lets an e2e test confirm a
    // friend-channel peer really does get full volume immediately with no
    // distance-based ramp, same as channelOwnerBuilderId's own reasoning.
    gainValue: entry.gainNode ? entry.gainNode.gain.value : null,
  }));
}

function setMicState(state) {
  micState = state;
  voiceBtnEl?.classList.remove('muted', 'unmuted', 'denied', 'requesting', 'speaking');
  voiceBtnEl?.classList.add(state);
  if (voiceBtnIconEl) {
    voiceBtnIconEl.textContent = state === 'denied' ? '🚫' : '🎤';
  }
  if (voiceBtnEl) {
    voiceBtnEl.setAttribute('aria-label', state === 'muted' ? 'Unmute microphone'
      : state === 'denied' ? 'Microphone access denied' : 'Mute microphone');
  }
}

function startMicAnalyser(stream) {
  const ctx = ensureAudioContext();
  // Deliberately NOT connected to ctx.destination — this is a local
  // monitoring tap for the "speaking" indicator, not playback; connecting
  // it to the destination would echo the user's own mic back to themselves.
  const source = ctx.createMediaStreamSource(stream);
  micAnalyser = ctx.createAnalyser();
  micAnalyser.fftSize = 512;
  source.connect(micAnalyser);
  micAnalyserData = new Uint8Array(micAnalyser.fftSize);
}

function readMicRms() {
  if (!micAnalyser || !micAnalyserData) return 0;
  micAnalyser.getByteTimeDomainData(micAnalyserData);
  let sumSquares = 0;
  for (let i = 0; i < micAnalyserData.length; i++) {
    const v = (micAnalyserData[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / micAnalyserData.length);
}

// Only ever runs once per page load — the first time getUserMedia
// succeeds (requestMicUnmute only calls this on that first grant; every
// later mute/unmute toggle just flips the existing track's own `.enabled`
// instead, which already does the right thing over an established
// connection with no renegotiation needed). Each existing peer's own
// connection started out recvonly (getOrCreatePeer, before any mic was
// granted) -- addTrack (not a manual replaceTrack + direction flip) is
// what correctly reuses that same transceiver: per spec it looks for a
// transceiver whose sender has no track and was never used to send
// before (exactly our recvonly one), flips its direction to sendrecv,
// *and* associates the given stream with it for signaling -- a bare
// replaceTrack() only swaps the track, leaving the receiving side's own
// ontrack event with an empty `streams` array since no stream was ever
// associated at transceiver-creation time. Still schedules
// onnegotiationneeded either way, same as a manual direction flip would.
async function addLocalTrackToAllPeers() {
  const track = localStream.getAudioTracks()[0];
  for (const entry of peers.values()) {
    if (entry.pc.getSenders().some((s) => s.track === track)) continue; // already added
    entry.pc.addTrack(track, localStream);
  }
}

async function requestMicUnmute() {
  if (micState === 'requesting') return;
  if (localStream) {
    // Permission already granted this session — just re-enable the
    // existing track rather than re-prompting.
    localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    setMicState('unmuted');
    return;
  }
  setMicState('requesting');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setMicState('denied');
    return;
  }
  startMicAnalyser(localStream);
  await addLocalTrackToAllPeers();
  setMicState('unmuted');
}

function muteMic() {
  localStream?.getAudioTracks().forEach((t) => { t.enabled = false; });
  isSpeaking = false;
  setMicState('muted');
}

if (voiceBtnEl) {
  voiceBtnEl.addEventListener('click', () => {
    ensureAudioContext(); // the click itself is a reliable user gesture
    if (micState === 'muted' || micState === 'denied') {
      requestMicUnmute();
    } else if (micState === 'unmuted') {
      muteMic();
    }
  });
}

function attachRemoteStream(builderId, entry, stream) {
  const ctx = ensureAudioContext();
  entry.sourceNode = ctx.createMediaStreamSource(stream);
  entry.gainNode = ctx.createGain();
  // #2781: a friend-channel peer gets full volume immediately and keeps
  // it forever -- no distance-based ramp (SPEC's "regardless of
  // proximity"), so there's nothing for updateVoicePeersForRange to ramp
  // up later the way it does for an ordinary proximity peer (gain 0 until
  // distance is known).
  // #2905: ontrack (this function's only caller) can fire again later --
  // e.g. a friend who joined muted-by-default (#2778) only sends their
  // first real track once they grant their mic, well after their row (and
  // mute button) already exist in the panel -- so this must respect an
  // already-recorded mute rather than hardcoding full volume, the same as
  // reconcileFriendVoiceChannels's own gain-sync already does.
  entry.gainNode.gain.value = entry.channelOwnerBuilderId ? (mutedPeers.has(builderId) ? 0 : 1) : 0;
  entry.sourceNode.connect(entry.gainNode).connect(ctx.destination);
}

// Smoothstep falloff from full volume at VOICE_FULL_VOLUME_RADIUS_M to
// silence at VOICE_RANGE_M — "ramping up gradually... not a hard cutoff,"
// per the SPEC quote at this module's own top comment.
function voiceGainForDistance(distanceM) {
  if (distanceM <= VOICE_FULL_VOLUME_RADIUS_M) return 1;
  if (distanceM >= VOICE_RANGE_M) return 0;
  const t = (distanceM - VOICE_FULL_VOLUME_RADIUS_M) / (VOICE_RANGE_M - VOICE_FULL_VOLUME_RADIUS_M);
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth;
}

// #2818: updateVoicePeersForRange calls this on every frame for any nearby
// avatar not yet in `peers` -- without the pendingPeers guard below, several
// frames can all see "not created yet" before the first call's own
// ensureMyBuilderId/ensureIceServers awaits resolve, each racing to create
// its own separate RTCPeerConnection for the same builderId. Only the last
// one to finish would end up in `peers`, leaving the earlier ones orphaned
// (never torn down, still live, still sending their own ICE
// candidates/offers under the same fromBuilderId) -- confirmed as the real
// cause of this module's own intermittent "stuck at connectionState 'new'"
// failures while validating this feature's own e2e test.
// `channelOwnerBuilderId` (#2781) is passed only when this peer is being
// created (or needs tagging) for a friend voice channel -- null/omitted
// for an ordinary proximity peer, unchanged from before #2781.
async function getOrCreatePeer(builderId, channelOwnerBuilderId = null) {
  const existing = peers.get(builderId);
  if (existing) {
    // A peer created first as a proximity connection can later turn out to
    // also be a friend-channel member (reconcileFriendVoiceChannels calling
    // in after updateVoicePeersForRange already connected them because
    // they're nearby, or vice versa) -- tag it in place rather than
    // tearing down and recreating a connection that's already working.
    if (channelOwnerBuilderId && !existing.channelOwnerBuilderId) {
      existing.channelOwnerBuilderId = channelOwnerBuilderId;
      // #2905: respect an already-recorded mute rather than hardcoding
      // full volume -- see attachRemoteStream's own comment for why.
      if (existing.gainNode) existing.gainNode.gain.value = mutedPeers.has(builderId) ? 0 : 1;
    }
    return existing;
  }
  const pending = pendingPeers.get(builderId);
  if (pending) return pending;
  const creation = createPeer(builderId, channelOwnerBuilderId).finally(() => pendingPeers.delete(builderId));
  pendingPeers.set(builderId, creation);
  return creation;
}

async function createPeer(builderId, channelOwnerBuilderId = null) {
  await ensureMyBuilderId();
  const iceServers = await ensureIceServers();
  // Re-check now that the awaits above have resolved -- another call could
  // have raced ahead and already landed an entry in `peers` (e.g. a direct
  // offer/answer/ice-candidate from handleIncomingSignal, which also goes
  // through this same function) while this one was still waiting.
  const existing = peers.get(builderId);
  if (existing) {
    if (channelOwnerBuilderId && !existing.channelOwnerBuilderId) {
      existing.channelOwnerBuilderId = channelOwnerBuilderId;
      // #2905: respect an already-recorded mute rather than hardcoding
      // full volume -- see attachRemoteStream's own comment for why.
      if (existing.gainNode) existing.gainNode.gain.value = mutedPeers.has(builderId) ? 0 : 1;
    }
    return existing;
  }
  const pc = new RTCPeerConnection({ iceServers });
  // performance.now() (same monotonic clock updateShopMovement's own `now`
  // parameter already uses -- see updateVoicePeersForRange's own watchdog
  // check below), not Date.now()'s wall-clock epoch -- the two aren't
  // comparable, and mixing them here left an earlier version of this
  // watchdog comparing against a number that could never cross its own
  // threshold, found live while validating this feature's own e2e test.
  const entry = {
    pc, polite: myBuilderId < builderId, makingOffer: false, ignoreOffer: false, sourceNode: null,
    gainNode: null, createdAt: performance.now(), displaySeq: ++voicePeerSeq, channelOwnerBuilderId,
  };
  peers.set(builderId, entry);

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendVoiceSignal({
      toBuilderId: builderId, kind: 'ice-candidate', payload: event.candidate.toJSON(),
      channelOwnerBuilderId: entry.channelOwnerBuilderId || undefined,
    }).catch(() => {});
  };
  pc.ontrack = (event) => {
    if (event.streams[0]) attachRemoteStream(builderId, entry, event.streams[0]);
    // #2834: attachRemoteStream sets entry.gainNode, which window.__shopVoicePeers'
    // own gainValue field reads -- refresh here so that diagnostic reflects
    // it right away, rather than staying stale (null) until some other
    // state-change event happens to fire afterward.
    refreshVoicePeersDiagnostic();
  };
  pc.onnegotiationneeded = async () => {
    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();
      // RTCSessionDescription's type/sdp are getters inherited from the
      // prototype, not own enumerable properties -- JSON.stringify (inside
      // sendVoiceSignal) silently drops them unless explicitly copied into
      // a plain object first, the same reason RTCIceCandidate's own
      // .toJSON() is called explicitly above rather than passed as-is.
      await sendVoiceSignal({
        toBuilderId: builderId, kind: 'offer', payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        channelOwnerBuilderId: entry.channelOwnerBuilderId || undefined,
      }).catch(() => {});
    } catch {
      // best-effort — onnegotiationneeded fires again if something still
      // needs renegotiating
    } finally {
      entry.makingOffer = false;
    }
  };
  pc.onconnectionstatechange = () => {
    refreshVoicePeersDiagnostic();
    renderVoicePeersList(); // #2819: connectionState is this panel's own "connected" filter
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') teardownPeer(builderId);
  };
  pc.onsignalingstatechange = refreshVoicePeersDiagnostic;
  pc.oniceconnectionstatechange = refreshVoicePeersDiagnostic;

  // Deliberately NOT symmetric: only the impolite side proactively creates
  // a transceiver here (recvonly, or sendrecv via addTrack if it already
  // has a mic) -- the polite side waits passively for the impolite side's
  // offer to arrive instead of also racing to create its own. Both sides
  // independently calling addTransceiver at connection-setup time (the
  // original, symmetric version of this code) meant onnegotiationneeded
  // fired on both sides at nearly the same real-world moment for every
  // single new connection -- true glare on *every* first contact, not just
  // an occasional edge case. Perfect negotiation's polite/impolite
  // collision handling resolves that correctly, but at the cost of extra
  // round trips every single time -- unnecessary for the common case
  // (every avatar starts muted, #2778's resolution, so the vast majority of
  // first contacts have neither side holding a mic yet). addLocalTrackToAllPeers
  // below still covers the rarer case where this side already has a mic by
  // the time a brand-new avatar comes into range, which can still glare
  // against that avatar's own first offer, but perfect negotiation's
  // existing handling is enough for that much less common case.
  //
  // NOT the fix for this module's own intermittent "stuck at signalingState
  // have-local-offer/stable forever" e2e failures, confirmed via explicit
  // setRemoteDescription tracing while validating this feature: that hang
  // reproduces identically whether only the impolite side offers (this
  // version) or both sides do (the original, symmetric version) -- it's a
  // native RTCPeerConnection.setRemoteDescription(offer) call that simply
  // never resolves or rejects, under this CI container's own two-concurrent-
  // headless-Chromium-plus-fake-media-device resource constraints, not an
  // application-level race either version of this code could cause or fix.
  // VOICE_NEGOTIATION_TIMEOUT_MS below is the actual fix -- a bounded
  // watchdog that tears down and lets a connection stuck short of
  // 'connected' retry fresh, regardless of which step it's stuck on.
  if (!entry.polite || localStream) {
    if (localStream) {
      pc.addTrack(localStream.getAudioTracks()[0], localStream);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
  }
  refreshVoicePeersDiagnostic();
  return entry;
}

function teardownPeer(builderId) {
  const entry = peers.get(builderId);
  if (!entry) return;
  entry.sourceNode?.disconnect();
  entry.gainNode?.disconnect();
  entry.pc.close();
  peers.delete(builderId);
  mutedPeers.delete(builderId); // #2819: mute is scoped to this connection's own lifetime
  refreshVoicePeersDiagnostic();
  renderVoicePeersList();
}

// #2819: one row per currently-connected (not still-negotiating) peer, each
// with a local mute toggle and a report action -- see this module's own
// VOICE_RANGE_M-area comment block and index.html's own markup comment for
// why there's no display name. Re-rendered from scratch on every call
// (connect/disconnect/mute toggle) rather than diffed -- the list is tiny
// (bounded by how many avatars can realistically be in voice range at
// once) and event handling is delegated at the panel level below, so a
// full rebuild never loses or duplicates a listener.
function renderVoicePeersList() {
  if (!voicePeersPanelEl || !voicePeersListEl) return;
  const connected = [...peers.entries()]
    .filter(([, entry]) => entry.pc.connectionState === 'connected')
    .sort(([, a], [, b]) => a.displaySeq - b.displaySeq);
  voicePeersPanelEl.classList.toggle('open', connected.length > 0);
  voicePeersListEl.innerHTML = connected.map(([builderId, entry]) => {
    const muted = mutedPeers.has(builderId);
    return `<div class="shop-voice-peer-row" data-builder-id="${builderId}">`
      + `<span class="shop-voice-peer-label">Nearby voice ${entry.displaySeq}</span>`
      + `<button type="button" data-action="mute" class="${muted ? 'shop-voice-peer-muted' : ''}">${muted ? 'Unmute' : 'Mute'}</button>`
      + '<button type="button" data-action="report">Report</button>'
      + '</div>';
  }).join('');
}

if (voicePeersListEl) {
  voicePeersListEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    const row = event.target.closest('[data-builder-id]');
    if (!button || !row) return;
    const builderId = row.dataset.builderId;
    if (button.dataset.action === 'mute') {
      if (mutedPeers.has(builderId)) mutedPeers.delete(builderId);
      else mutedPeers.add(builderId);
      renderVoicePeersList();
      refreshVoicePeersDiagnostic(); // keeps window.__shopVoicePeers' own muted field current
    } else if (button.dataset.action === 'report') {
      reportVoicePeer(builderId);
    }
  });
}

// Same prompt()-based lightweight text-input convention this codebase
// already uses for every other short, optional free-text capture (product/
// seller reviews, land/friend renames -- src/shop/productCheckout.js,
// src/account/menu.js) rather than a bespoke modal. A cancelled prompt
// (null) submits nothing -- #1212's own product-flag reporting is
// "zero-cost/consequence-free for the flagger by design," and an accidental
// click shouldn't be able to fire a report with no way to back out.
async function reportVoicePeer(builderId) {
  const reason = window.prompt(
    'Report this nearby voice for inappropriate conduct? Optionally describe why (up to 280 characters), or leave blank:', '',
  );
  if (reason === null) return; // cancelled
  try {
    await sendVoiceReport({ reportedBuilderId: builderId, reason: reason.trim() || undefined });
    window.alert('Report submitted. Thank you.');
  } catch {
    window.alert('Could not submit the report -- please try again.');
  }
}

// `channelOwnerBuilderId` (#2781) comes straight from the inbound signal
// message itself (set server-side, see worker/lib/social.js's
// voiceSignalMessageFromRow) -- an incoming offer can be the very first
// this side hears of a brand-new friend-channel peer if its own
// reconcileFriendVoiceChannels poll hasn't landed yet, so getOrCreatePeer
// needs this to tag the entry correctly even on that reactive path, not
// just the proactive one.
async function handleIncomingSignal(fromBuilderId, kind, payload, channelOwnerBuilderId) {
  const entry = await getOrCreatePeer(fromBuilderId, channelOwnerBuilderId);
  if (kind === 'offer' || kind === 'answer') {
    const description = payload;
    const offerCollision = description.type === 'offer' && (entry.makingOffer || entry.pc.signalingState !== 'stable');
    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;
    try {
      await entry.pc.setRemoteDescription(description);
    } catch {
      return; // best-effort
    }
    if (description.type === 'offer') {
      await entry.pc.setLocalDescription();
      // Same explicit-copy reasoning as the offer send in onnegotiationneeded
      // above.
      await sendVoiceSignal({
        toBuilderId: fromBuilderId, kind: 'answer',
        payload: { type: entry.pc.localDescription.type, sdp: entry.pc.localDescription.sdp },
        channelOwnerBuilderId: entry.channelOwnerBuilderId || undefined,
      }).catch(() => {});
    }
  } else if (kind === 'ice-candidate') {
    try {
      await entry.pc.addIceCandidate(payload);
    } catch {
      // A genuine failure, not the expected glare-collision drop above —
      // nothing more to do about one bad candidate; ICE keeps trying with
      // whatever other candidates still arrive.
    }
  }
}

// Mirrors pollNearbyChatIfNeeded's own throttle/monotonic-token shape
// (src/shop/nearbyChat.js) — never awaited by its caller, same "don't
// stall the render loop on a slow/failed request" reasoning.
function pollVoiceSignalsIfNeeded(now) {
  if (now - voiceLastPollAt < VOICE_POLL_INTERVAL_MS) return;
  voiceLastPollAt = now;
  const myToken = ++voicePollToken;
  fetchVoiceSignals({ cursor: voiceSignalCursor }).then(async (result) => {
    if (myToken !== voicePollToken) return;
    if (result.nextCursor) voiceSignalCursor = result.nextCursor;
    for (const message of result.messages) {
      if (myToken !== voicePollToken) return; // a newer poll superseded this one mid-batch
      await handleIncomingSignal(message.fromBuilderId, message.kind, message.payload, message.channelOwnerBuilderId);
    }
  }).catch(() => {});
}

// Opens/closes peer connections based on live distance to each nearby
// avatar (shopOtherAvatars, already landlet-scoped and flying-exclusive —
// see this module's own header comment), and ramps each connected peer's
// gain for the ones already open.
function updateVoicePeersForRange(now) {
  const seenBuilderIds = new Set();
  for (const [builderId, avatarEntry] of shopOtherAvatars) {
    seenBuilderIds.add(builderId);
    const dx = avatarEntry.group.position.x - shopAvatarPosition.x;
    const dy = avatarEntry.group.position.y - shopAvatarPosition.y;
    const distanceM = Math.hypot(dx, dy);
    const peerEntry = peers.get(builderId);
    if (!peerEntry) {
      if (distanceM <= VOICE_RANGE_M) getOrCreatePeer(builderId).catch(() => {});
      continue;
    }
    // #2781: a friend-channel peer is governed entirely by
    // reconcileFriendVoiceChannels (its own watchdog retry included), never
    // by live distance -- even when they also happen to be nearby right
    // now. Skipping straight to the next avatar here, rather than falling
    // through to the distance-teardown/gain-ramp below, is what keeps a
    // friend's connection (and its full volume) alive exactly when they
    // walk out of VOICE_DISCONNECT_RADIUS_M, which would otherwise tear it
    // down as if it were an ordinary proximity peer.
    if (peerEntry.channelOwnerBuilderId) continue;
    if (distanceM > VOICE_DISCONNECT_RADIUS_M) {
      teardownPeer(builderId);
      continue;
    }
    if (peerEntry.pc.connectionState !== 'connected' && now - peerEntry.createdAt > VOICE_NEGOTIATION_TIMEOUT_MS) {
      // Stuck negotiation -- see VOICE_NEGOTIATION_TIMEOUT_MS's own comment.
      // Still within range and still in shopOtherAvatars, so the next call
      // to this same function (getOrCreatePeer, above) retries fresh.
      teardownPeer(builderId);
      continue;
    }
    if (peerEntry.gainNode) {
      // #2819: a locally-muted peer stays silent regardless of distance --
      // overrides the ramp rather than replacing it, so un-muting later
      // immediately reflects wherever they actually are by then.
      peerEntry.gainNode.gain.value = mutedPeers.has(builderId) ? 0 : voiceGainForDistance(distanceM);
    }
  }
  // Anyone we still hold a connection for but who's no longer nearby at
  // all (despawned, left the landlet) — same cleanup shape as the
  // distance-based teardown above, just triggered by absence instead. A
  // friend-channel peer is explicitly exempt, same reasoning as the skip
  // above -- they're frequently not in shopOtherAvatars at all (a friend
  // elsewhere in the world, the whole point of "regardless of proximity"),
  // so absence from this Shop-mode-local Map says nothing about whether
  // reconcileFriendVoiceChannels still wants them connected.
  for (const [builderId, entry] of peers) {
    if (entry.channelOwnerBuilderId) continue;
    if (!seenBuilderIds.has(builderId)) teardownPeer(builderId);
  }
}

function teardownAllPeers() {
  for (const builderId of [...peers.keys()]) teardownPeer(builderId);
}

// #2781: which OTHER builderIds the caller should currently hold a
// friend-channel peer connection open with, derived from
// myFriendVoiceChannels (every channel the caller is a member of,
// including one they themselves own) -- a flat merge across channels
// since a peer either should or shouldn't be connected, regardless of
// which shared channel justifies it (relevant once a caller could be
// in more than one channel, e.g. mid-switch between two friends').
function desiredFriendChannelPeers() {
  const desired = new Map(); // builderId -> ownerBuilderId (first one wins, arbitrary but stable)
  for (const channel of myFriendVoiceChannels) {
    for (const memberBuilderId of channel.members) {
      if (memberBuilderId === myBuilderId) continue;
      if (!desired.has(memberBuilderId)) desired.set(memberBuilderId, channel.ownerBuilderId);
    }
  }
  return desired;
}

// Polled on its own interval (see FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS's
// own comment) rather than the Shop-mode render tick: fetches current
// channel membership, opens a peer for every member newly in it, tears
// down a friend-channel peer for anyone no longer in any shared channel,
// and retries a friend-channel connection that's been stuck negotiating
// too long -- the same VOICE_NEGOTIATION_TIMEOUT_MS watchdog
// updateVoicePeersForRange runs for proximity peers, just not keyed off
// shopOtherAvatars (a far-away friend may never appear there at all).
async function reconcileFriendVoiceChannels() {
  try {
    myFriendVoiceChannels = await fetchFriendVoiceChannels();
  } catch {
    return; // best-effort; the next poll retries
  }
  await ensureMyBuilderId().catch(() => {});
  const desired = desiredFriendChannelPeers();
  const now = performance.now();
  for (const [builderId, ownerBuilderId] of desired) {
    const existing = peers.get(builderId);
    if (!existing) {
      getOrCreatePeer(builderId, ownerBuilderId).catch(() => {});
      continue;
    }
    if (existing.pc.connectionState !== 'connected' && now - existing.createdAt > VOICE_NEGOTIATION_TIMEOUT_MS) {
      teardownPeer(builderId);
      getOrCreatePeer(builderId, ownerBuilderId).catch(() => {});
      continue;
    }
    // #2819: a friend-channel peer's gain is otherwise only ever set once
    // (attachRemoteStream, at connection time) and never revisited --
    // unlike an ordinary proximity peer, which updateVoicePeersForRange
    // already re-ramps every frame. Without this, muting a currently
    // connected friend has no effect: mutedPeers would record the toggle,
    // but nothing would ever push it onto this peer's own GainNode.
    if (existing.gainNode) existing.gainNode.gain.value = mutedPeers.has(builderId) ? 0 : 1;
  }
  for (const [builderId, entry] of peers) {
    if (entry.channelOwnerBuilderId && !desired.has(builderId)) teardownPeer(builderId);
  }
}

// #2781: src/account/menu.js's friends-panel UI calls these to start/join
// (the same action -- see worker/lib/social.js's handleFriendVoiceChannels
// for why there's no separate "start") and leave a friend voice channel.
// Each resolves once the membership write has landed AND this module's own
// peers have been reconciled against it, so the UI can safely re-render
// from getActiveFriendVoiceChannels() right after awaiting either.
export async function joinFriendVoiceChannel(ownerBuilderId) {
  await apiJoinFriendVoiceChannel(ownerBuilderId);
  await reconcileFriendVoiceChannels();
}

export async function leaveFriendVoiceChannel(ownerBuilderId) {
  await apiLeaveFriendVoiceChannel(ownerBuilderId);
  await reconcileFriendVoiceChannels();
}

// Synchronous read of the last poll's result -- src/account/menu.js uses
// this to render without triggering its own extra network request. May be
// stale by up to FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS; callers that just
// mutated membership themselves (join/leave above) always get a
// just-reconciled result instead, since those await a fresh poll already.
export function getActiveFriendVoiceChannels() {
  return myFriendVoiceChannels;
}

// Runs independently of updateShopVoiceChatIfNeeded's per-frame Shop-mode
// tick -- see FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS's own comment on why a
// friend group call shouldn't depend on that render loop at all. Gated on
// id-verification the same way updateShopVoiceChatIfNeeded is; mic
// availability itself is unaffected by mode (Shop or otherwise).
setInterval(() => {
  if (!hasIdVerifiedSession()) {
    // Mirrors updateShopVoiceChatIfNeeded's own `!available` branch --
    // without this, losing id_verified status while never having entered
    // Shop mode this session (so that function's own teardownAllPeers call
    // never runs) would leave a friend-channel peer connected indefinitely.
    for (const [builderId, entry] of peers) {
      if (entry.channelOwnerBuilderId) teardownPeer(builderId);
    }
    return;
  }
  // #2868: unlike updateShopVoiceChatIfNeeded (driven by Shop mode's own
  // requestAnimationFrame loop, which already stops on its own once the
  // tab is backgrounded), this is a plain always-on setInterval with no
  // such natural pause -- a forgotten-open, backgrounded tab for any
  // id_verified account kept polling both endpoints below indefinitely,
  // which is what actually drove the D1 free-tier daily row-read cap to
  // zero. Skipping the network work while hidden and resuming on the very
  // next tick once visible again (no separate visibilitychange listener
  // needed -- document.hidden is just read fresh each tick) is the fix.
  if (document.hidden) return;
  pollVoiceSignalsIfNeeded(performance.now());
  reconcileFriendVoiceChannels();
}, FRIEND_VOICE_CHANNEL_POLL_INTERVAL_MS);

// Called every Shop-mode render tick (see updateShopMovement in
// src/shop/flightMovement.js), after updateOtherShopAvatars has refreshed
// shopOtherAvatars' own rendered positions for this frame so the distance
// check above reads current, smoothed positions rather than last frame's.
export function updateShopVoiceChatIfNeeded(now) {
  const available = hasIdVerifiedSession();
  voiceBtnEl?.classList.toggle('visible', available);
  if (!available) {
    teardownAllPeers();
    localStream?.getAudioTracks().forEach((t) => t.stop());
    localStream = null;
    if (micState !== 'muted') setMicState('muted');
    return;
  }
  pollVoiceSignalsIfNeeded(now);
  updateVoicePeersForRange(now);
  if (micState === 'unmuted') {
    const speakingNow = readMicRms() >= VOICE_SPEAKING_RMS_THRESHOLD;
    if (speakingNow !== isSpeaking) {
      isSpeaking = speakingNow;
      voiceBtnEl?.classList.toggle('speaking', isSpeaking);
    }
  }
}
