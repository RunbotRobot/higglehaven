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

// builderId -> { pc, polite, makingOffer, ignoreOffer, sourceNode, gainNode, displaySeq }
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
// fresh RTCPeerConnection would.
const mutedPeers = new Set();

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

function attachRemoteStream(entry, stream) {
  const ctx = ensureAudioContext();
  entry.sourceNode = ctx.createMediaStreamSource(stream);
  entry.gainNode = ctx.createGain();
  entry.gainNode.gain.value = 0; // ramped up by updateVoicePeersForRange once distance is known
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
async function getOrCreatePeer(builderId) {
  const existing = peers.get(builderId);
  if (existing) return existing;
  const pending = pendingPeers.get(builderId);
  if (pending) return pending;
  const creation = createPeer(builderId).finally(() => pendingPeers.delete(builderId));
  pendingPeers.set(builderId, creation);
  return creation;
}

async function createPeer(builderId) {
  await ensureMyBuilderId();
  const iceServers = await ensureIceServers();
  // Re-check now that the awaits above have resolved -- another call could
  // have raced ahead and already landed an entry in `peers` (e.g. a direct
  // offer/answer/ice-candidate from handleIncomingSignal, which also goes
  // through this same function) while this one was still waiting.
  const existing = peers.get(builderId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers });
  // performance.now() (same monotonic clock updateShopMovement's own `now`
  // parameter already uses -- see updateVoicePeersForRange's own watchdog
  // check below), not Date.now()'s wall-clock epoch -- the two aren't
  // comparable, and mixing them here left an earlier version of this
  // watchdog comparing against a number that could never cross its own
  // threshold, found live while validating this feature's own e2e test.
  const entry = {
    pc, polite: myBuilderId < builderId, makingOffer: false, ignoreOffer: false, sourceNode: null,
    gainNode: null, createdAt: performance.now(), displaySeq: ++voicePeerSeq,
  };
  peers.set(builderId, entry);

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendVoiceSignal({ toBuilderId: builderId, kind: 'ice-candidate', payload: event.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (event) => {
    if (event.streams[0]) attachRemoteStream(entry, event.streams[0]);
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
      await sendVoiceSignal({ toBuilderId: builderId, kind: 'offer', payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }).catch(() => {});
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

async function handleIncomingSignal(fromBuilderId, kind, payload) {
  const entry = await getOrCreatePeer(fromBuilderId);
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
      await handleIncomingSignal(message.fromBuilderId, message.kind, message.payload);
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
  // distance-based teardown above, just triggered by absence instead.
  for (const builderId of peers.keys()) {
    if (!seenBuilderIds.has(builderId)) teardownPeer(builderId);
  }
}

function teardownAllPeers() {
  for (const builderId of [...peers.keys()]) teardownPeer(builderId);
}

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
