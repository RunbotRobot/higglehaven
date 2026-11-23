// #3556 (who is speaking in nearby chat): a soft mark above the head of the avatar whose line just
// arrived in nearby chat, so a person can tell which of the people around them spoke without any name
// being shown. Nearby chat is anonymous on purpose (docs/API.md "Assistant presence": it "stays
// unlabeled for every sender"), so the cue carries no name, no alias and no id: three dots in a soft
// bubble that thins in, stays a moment and thins away (AGENTS.md "Things arrive in the world through
// fog; nothing pops in", "something about a thing in the world is said at the thing").
//
// It follows the shape of assistantTapRing.js: a pure function for the levels, and a small function
// that hangs the mark off the avatar's stable outer group (so a body swap never loses it).
export const SPEECH_CUE_IN_S = 0.3; // thins in
export const SPEECH_CUE_HOLD_S = 2.6; // stays after the latest line
export const SPEECH_CUE_OUT_S = 0.9; // thins away
export const SPEECH_CUE_RISE_M = 0.1; // drifts up a little while it thins in
export const SPEECH_CUE_HEIGHT_ABOVE_HEAD_M = 0.32;
const SPEECH_CUE_WORLD_UNITS_PER_PX = 0.004;

const clamp01 = (n) => (n <= 0 ? 0 : n >= 1 ? 1 : n);

// { opacity, rise, done } at `ageS` seconds after the latest line. `reducedMotion`: no drifting and no
// thinning, the mark simply shows for the hold and goes.
export function speechCueLevels(ageS, { reducedMotion = false } = {}) {
  const age = Math.max(0, Number.isFinite(ageS) ? ageS : 0);
  const outStart = SPEECH_CUE_IN_S + SPEECH_CUE_HOLD_S;
  if (reducedMotion) return { opacity: age < outStart ? 0.9 : 0, rise: 0, done: age >= outStart };
  const fadeIn = clamp01(age / SPEECH_CUE_IN_S);
  const fadeOut = clamp01((age - outStart) / SPEECH_CUE_OUT_S);
  const eased = fadeIn * fadeIn * (3 - 2 * fadeIn);
  return { opacity: 0.9 * eased * (1 - fadeOut), rise: SPEECH_CUE_RISE_M * eased, done: age >= outStart + SPEECH_CUE_OUT_S - 1e-9 };
}

// Hands a nearby-chat line's sender to whoever draws the avatars. nearbyChat.js (which has the line)
// and presenceAndContent.js (which owns the avatars) do not import each other, so they meet here.
let speechHandler = null;
export function setNearbySpeechHandler(handler) {
  speechHandler = handler;
}
export function announceNearbySpeech(builderId) {
  if (speechHandler) speechHandler(builderId);
}

function drawBubble(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(244, 248, 232, 0.92)'; // the brand's pale green-white
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 20, 22);
  ctx.fill();
  ctx.beginPath(); // the tail, pointing down at the speaker
  ctx.moveTo(w / 2 - 10, h - 17);
  ctx.lineTo(w / 2, h - 3);
  ctx.lineTo(w / 2 + 10, h - 17);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#3f8f5a'; // the brand's green
  for (const x of [w / 2 - 24, w / 2, w / 2 + 24]) {
    ctx.beginPath();
    ctx.arc(x, (h - 16) / 2 + 2, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Puts the mark on `group` at `headTopZ` (the top of the head, in the group's own units). Returns
// { refresh(), dispose() }: refresh() on every new line keeps it standing; dispose() removes it at once
// (the avatar is leaving); `onGone` is told when the mark is gone either way. `three` is the THREE namespace (passed in so a test needs none).
export function showSpeechCue(three, group, headTopZ, { now = () => performance.now(), reducedMotion = false, onGone = null } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 80;
  drawBubble(canvas);
  const texture = new three.CanvasTexture(canvas);
  const material = new three.SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0 });
  const sprite = new three.Sprite(material);
  sprite.name = 'speech-cue';
  sprite.scale.set(canvas.width * SPEECH_CUE_WORLD_UNITS_PER_PX, canvas.height * SPEECH_CUE_WORLD_UNITS_PER_PX, 1);
  const baseZ = headTopZ + SPEECH_CUE_HEIGHT_ABOVE_HEAD_M;
  sprite.position.z = baseZ;
  sprite.renderOrder = 6;
  group.add(sprite);
  let lineAt = now();
  let frame = 0;
  let gone = false;
  function dispose() {
    if (gone) return;
    gone = true;
    cancelAnimationFrame(frame);
    group.remove(sprite);
    texture.dispose();
    material.dispose();
    if (onGone) onGone();
  }
  function tick() {
    if (gone) return;
    const level = speechCueLevels((now() - lineAt) / 1000, { reducedMotion });
    material.opacity = level.opacity;
    sprite.position.z = baseZ + level.rise;
    if (level.done) dispose();
    else frame = requestAnimationFrame(tick);
  }
  tick();
  return {
    // A new line while it is standing keeps it standing, from the moment it is full again; it does not
    // restart the thin-in, so a quick exchange does not make it blink.
    refresh() {
      const age = (now() - lineAt) / 1000;
      lineAt = age >= SPEECH_CUE_IN_S ? now() - SPEECH_CUE_IN_S * 1000 : lineAt;
    },
    dispose,
    get gone() { return gone; },
  };
}
