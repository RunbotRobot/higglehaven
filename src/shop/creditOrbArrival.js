// #4174: credit orbs arrive and leave through fog like everything else in the world ("Things arrive in the
// world through fog; nothing pops in"). It reuses the arrival code the lándlet loader and the avatar use
// (arrivalEffect.js: a puff of fog, and the dissolve that keeps or discards fragments by a noise threshold)
// instead of a second effect. Pure of the page: the fog and dissolve makers are passed in, so it runs in the
// plain unit-test pool.
//
// - arrive(orb): the orb is hidden until a slot is free, then resolves out of fog over ORB_FADE_S. At most
//   ORB_FADE_MAX_ACTIVE fade at once (a fast flight over a field of orbs must not build dozens of fogs in one
//   frame, #3396); the rest wait their turn in the order they came.
// - depart(orb, onDone): an orb that leaves range dissolves into fog, then onDone releases it. With no free
//   slot it simply goes (onDone at once).
// - finish(orb): cuts the fade short and leaves the orb plain, fully shown. The orb the person collects
//   themselves is finished first, so it keeps its instant collect effect (#3392: felt on contact).
// Under prefers-reduced-motion nothing animates: orbs appear and go as before.
export const ORB_FADE_S = 0.9;
export const ORB_FADE_MAX_ACTIVE = 12;
const ORB_FOG_EXTENT_M = { width: 0.9, depth: 0.9, height: 0.9 };

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 0 = not there, 1 = fully there. The fog swells and thins around the middle; the body is kept by the dither
// from a quarter of the way in, so the orb is never seen without fog on it.
export function orbFadeLevels(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return { fog: Math.sin(Math.PI * clamped), body: smoothstep(0.25, 0.85, clamped) };
}

export function createCreditOrbFades({
  createFog, createDissolve, reducedMotion = () => false,
  maxActive = ORB_FADE_MAX_ACTIVE, durationS = ORB_FADE_S,
}) {
  const waiting = []; // entries not started yet (arrivals only), oldest first
  const active = new Set();
  const byOrb = new Map();
  let seed = 0;

  function start(entry) {
    const { orb } = entry;
    entry.dissolve = createDissolve(orb.mesh);
    entry.fog = createFog({ center: orb.mesh.position, extent: ORB_FOG_EXTENT_M, seed: seed += 1 });
    orb.group.add(entry.fog.object);
    active.add(entry);
    apply(entry);
    orb.mesh.visible = true;
  }

  function apply(entry) {
    const levels = orbFadeLevels(entry.t);
    entry.dissolve.setLevel(levels.body);
    entry.fog.setLevel(levels.fog);
  }

  function release(entry) {
    active.delete(entry);
    const index = waiting.indexOf(entry);
    if (index >= 0) waiting.splice(index, 1);
    byOrb.delete(entry.orb);
    entry.dissolve?.restore();
    entry.fog?.dispose();
    entry.orb.mesh.visible = true;
  }

  function fill() {
    while (waiting.length > 0 && active.size < maxActive) start(waiting.shift());
  }

  return {
    arrive(orb) {
      if (reducedMotion()) return;
      orb.mesh.visible = false;
      const entry = { orb, dir: 1, t: 0, onDone: null, dissolve: null, fog: null };
      byOrb.set(orb, entry);
      waiting.push(entry);
      fill();
    },
    depart(orb, onDone) {
      if (reducedMotion()) { onDone(); return; }
      const existing = byOrb.get(orb);
      if (existing && !existing.dissolve) { release(existing); onDone(); return; } // never shown: nothing to dissolve
      if (existing) { existing.dir = -1; existing.onDone = onDone; return; } // turn an arrival around where it is
      if (active.size >= maxActive) { onDone(); return; }
      const entry = { orb, dir: -1, t: 1, onDone, dissolve: null, fog: null };
      byOrb.set(orb, entry);
      start(entry);
    },
    finish(orb) {
      const entry = byOrb.get(orb);
      if (entry) release(entry);
    },
    update(dt) {
      for (const entry of [...active]) {
        entry.t += entry.dir * dt / durationS;
        if (entry.dir > 0 && entry.t >= 1) { release(entry); continue; }
        if (entry.dir < 0 && entry.t <= 0) {
          const { onDone } = entry;
          release(entry);
          onDone?.();
          continue;
        }
        apply(entry);
      }
      fill();
    },
    // How many are fading or waiting; the e2e and the stats read it.
    stats: () => ({ active: active.size, waiting: waiting.length }),
  };
}
