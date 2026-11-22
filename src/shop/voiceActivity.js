// #3556 (who is speaking nearby, the voice half): decides from a remote voice stream's loudness whether
// that person is speaking right now, so the same soft three-dot mark nearby chat puts over a speaker
// (speechCue.js) can stand over a voice peer too. No name, alias or id is shown: voice stays
// anonymous like text. Pure functions plus one small poller, so a unit test needs no audio.

export const VOICE_ACTIVITY_POLL_MS = 120;
// Loudness (root mean square of samples centred on 0, range 0..1). Speech into a phone mic is well
// above 0.02; room hiss and a quiet fan sit below 0.01. Two thresholds (hysteresis) so a pause between
// words does not make the mark flicker, and a short hold keeps it through the gap.
export const VOICE_ON_LEVEL = 0.02;
export const VOICE_OFF_LEVEL = 0.012;
export const VOICE_HOLD_MS = 350;
// A peer heard at less than this fraction of full volume (far away, or muted: gain 0) is not marked:
// the mark says "this is who you are hearing".
export const VOICE_AUDIBLE_GAIN = 0.05;

// Root mean square of a time-domain byte buffer from an AnalyserNode (128 = silence).
export function rmsOfByteSamples(bytes) {
  if (!bytes || !bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}

// A speaking/not-speaking decision over time. update(level, nowMs) returns true while speaking.
export function createSpeakingDetector({ onLevel = VOICE_ON_LEVEL, offLevel = VOICE_OFF_LEVEL, holdMs = VOICE_HOLD_MS } = {}) {
  let speaking = false;
  let lastLoudAt = -Infinity;
  return {
    update(level, nowMs) {
      if (level >= onLevel || (speaking && level >= offLevel)) lastLoudAt = nowMs;
      speaking = nowMs - lastLoudAt <= holdMs;
      return speaking;
    },
    get speaking() { return speaking; },
  };
}

// Polls `analyser` every VOICE_ACTIVITY_POLL_MS and calls `onSpeaking()` for as long as the person is
// speaking and `isAudible()` holds. Returns stop().
export function watchVoiceActivity(analyser, { isAudible = () => true, onSpeaking, now = () => performance.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const buffer = new Uint8Array(analyser.fftSize);
  const detector = createSpeakingDetector();
  const timer = setIntervalFn(() => {
    analyser.getByteTimeDomainData(buffer);
    const speaking = detector.update(rmsOfByteSamples(buffer), now());
    if (speaking && isAudible()) onSpeaking();
  }, VOICE_ACTIVITY_POLL_MS);
  return () => clearIntervalFn(timer);
}
