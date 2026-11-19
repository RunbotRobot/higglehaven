// #3773 (the last piece): tapping an assistant in the world is answered on the assistant herself, not only
// on the head of the flower. A soft ring of the brand's green opens on the ground around her feet, breathes
// while the conversation is being brought in, and fades once the window is up. It is shown for at least
// TAP_RING_MIN_S so a window that opens at once (a thread already fetched) still gets a visible answer, and
// is removed after TAP_RING_MAX_S whatever happens, so a stalled request never leaves it standing.
export const TAP_RING_MIN_S = 0.7;
export const TAP_RING_MAX_S = 10;
export const TAP_RING_OPEN_S = 0.25; // grows out from nothing
export const TAP_RING_FADE_S = 0.35; // thins away once the window is up
export const TAP_RING_RADIUS_M = 0.8;

const clamp01 = (n) => (n <= 0 ? 0 : n >= 1 ? 1 : n);

// { scale, opacity, done } at `ageS` seconds after the tap. `releasedAtS` is when the window came up
// (null while it has not); the ring waits for TAP_RING_MIN_S, then fades. `reducedMotion`: no growing and
// no breathing, a still ring that simply appears and goes.
export function tapRingLevels(ageS, releasedAtS = null, { reducedMotion = false } = {}) {
  const age = Math.max(0, Number.isFinite(ageS) ? ageS : 0);
  const fadeStart = releasedAtS === null ? TAP_RING_MAX_S : Math.max(releasedAtS, TAP_RING_MIN_S);
  const fade = clamp01((age - fadeStart) / TAP_RING_FADE_S);
  const grow = reducedMotion ? 1 : clamp01(age / TAP_RING_OPEN_S);
  const breath = reducedMotion ? 0 : 0.06 * Math.sin(age * 5);
  const eased = grow * grow * (3 - 2 * grow);
  return { scale: Math.max(0.01, eased + breath * eased), opacity: 0.55 * eased * (1 - fade), done: age >= fadeStart + TAP_RING_FADE_S - 1e-9 };
}

// Puts the ring on `group` (the assistant's avatar group, so it follows her). Returns release(): call it
// when the window is up. `three` is the THREE namespace (passed in so a test needs none).
export function showAssistantTapRing(three, group, { now = () => performance.now(), reducedMotion = false } = {}) {
  const geometry = new three.RingGeometry(TAP_RING_RADIUS_M * 0.82, TAP_RING_RADIUS_M, 48);
  geometry.rotateX(-Math.PI / 2);
  const material = new three.MeshBasicMaterial({ color: 0x8fd18a, transparent: true, opacity: 0, depthWrite: false, side: three.DoubleSide });
  const ring = new three.Mesh(geometry, material);
  ring.position.y = 0.04;
  ring.renderOrder = 5;
  group.add(ring);
  const startedAt = now();
  let releasedAtS = null;
  let frame = 0;
  function finish() {
    cancelAnimationFrame(frame);
    group.remove(ring);
    geometry.dispose();
    material.dispose();
  }
  function tick() {
    const age = (now() - startedAt) / 1000;
    const level = tapRingLevels(age, releasedAtS, { reducedMotion });
    ring.scale.setScalar(level.scale);
    material.opacity = level.opacity;
    if (level.done) finish();
    else frame = requestAnimationFrame(tick);
  }
  tick();
  return function release() {
    if (releasedAtS === null) releasedAtS = (now() - startedAt) / 1000;
  };
}
