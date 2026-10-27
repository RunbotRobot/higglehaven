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
import { fetchMyBuilder, sendVoiceSignal, fetchVoiceSignals, fetchVoiceIceConfig } from '../api.js';
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

const voiceBtnEl = document.getElementById('shop-voice-btn');
const voiceBtnIconEl = document.getElementById('shop-voice-btn-icon');

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

// builderId -> { pc, polite, makingOffer, ignoreOffer, sourceNode, gainNode }
const peers = new Map();
let voiceSignalCursor = null;
let voiceLastPollAt = 0;
let voicePollToken = 0;

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
    builderId, connectionState: entry.pc.connectionState, polite: entry.polite,
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

async function getOrCreatePeer(builderId) {
  const existing = peers.get(builderId);
  if (existing) return existing;
  await ensureMyBuilderId();
  const iceServers = await ensureIceServers();
  const pc = new RTCPeerConnection({ iceServers });
  const entry = { pc, polite: myBuilderId < builderId, makingOffer: false, ignoreOffer: false, sourceNode: null, gainNode: null };
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
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') teardownPeer(builderId);
  };

  if (localStream) {
    pc.addTrack(localStream.getAudioTracks()[0], localStream);
  } else {
    pc.addTransceiver('audio', { direction: 'recvonly' });
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
  refreshVoicePeersDiagnostic();
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
function updateVoicePeersForRange() {
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
    if (peerEntry.gainNode) peerEntry.gainNode.gain.value = voiceGainForDistance(distanceM);
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
  updateVoicePeersForRange();
  if (micState === 'unmuted') {
    const speakingNow = readMicRms() >= VOICE_SPEAKING_RMS_THRESHOLD;
    if (speakingNow !== isSpeaking) {
      isSpeaking = speakingNow;
      voiceBtnEl?.classList.toggle('speaking', isSpeaking);
    }
  }
}
