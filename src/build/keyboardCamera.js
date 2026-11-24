// #4159 (leaf 1 of #4158): Build's camera from a keyboard. Build was mouse and touch only. The keys are
// Shop's (src/shop/keyboardInput.js) so one set of keys means the same thing in both modes: W, A, S, D
// or the arrows move the view over the ground, Q and E turn it around what it looks at, R and F tip it
// down and up, Page Up zooms in and Page Down zooms out (as in Build's wheel and pinch: the camera and
// what it looks at fly forward or back together along the way the view points, not a dolly that stops at
// a wall). Pure maths on plain numbers (z is up, as in
// the scene), so it is unit-tested (keyboardCamera.test.js); src/build/scene.js applies the result once
// a frame and does the wiring.

// How fast, per second. Panning scales with how far out the view is, so it feels the same up close and
// from far away.
export const PAN_BASE_M_S = 8;
export const PAN_PER_DISTANCE_PER_S = 0.8;
export const ORBIT_RAD_S = 1.4;
export const TILT_RAD_S = 1.0;
export const MIN_CAMERA_Z_M = 0.5;
const MIN_POLAR_RAD = 0.1;

// `view`: { camera: {x,y,z}, target: {x,y,z} }. `axes`: keyboardAxes() (moveX positive right, moveY
// negative forward, lookX positive turns right, lookY positive looks down). `zoom`: keyboardRise()
// (positive zooms in). `limits`: { maxPolarRad, maxTargetRadius }. Returns
// the new { camera, target }; nothing is changed when no key is held.
export function stepBuildCamera(view, axes, zoom, dt, limits) {
  const { camera, target } = view;
  if (!axes.moveX && !axes.moveY && !axes.lookX && !axes.lookY && !zoom) return view;
  let ox = camera.x - target.x;
  let oy = camera.y - target.y;
  let oz = camera.z - target.z;
  let radius = Math.hypot(ox, oy, oz) || 1;
  let theta = Math.atan2(oy, ox);
  let phi = Math.acos(Math.max(-1, Math.min(1, oz / radius)));

  // Turn around the target: positive moves the camera to its own right, so the scene swings left and
  // the view reads as turning right.
  theta += axes.lookX * ORBIT_RAD_S * dt;
  // Tip: looking down brings the camera over the target.
  phi = Math.max(MIN_POLAR_RAD, Math.min(limits.maxPolarRad, phi - axes.lookY * TILT_RAD_S * dt));
  // Pan over the ground along the way the view faces (before the turn above, so a held turn and move
  // together curve the way they read).
  let tx = target.x;
  let ty = target.y;
  if (axes.moveX || axes.moveY) {
    const horizontal = Math.hypot(ox, oy) || 1;
    const fx = -ox / horizontal;
    const fy = -oy / horizontal;
    const rx = fy;
    const ry = -fx;
    const speed = Math.max(PAN_BASE_M_S, radius * PAN_PER_DISTANCE_PER_S) * dt;
    const forward = -axes.moveY;
    tx += (fx * forward + rx * axes.moveX) * speed;
    ty += (fy * forward + ry * axes.moveX) * speed;
    const from = Math.hypot(tx, ty);
    if (from > limits.maxTargetRadius) {
      tx *= limits.maxTargetRadius / from;
      ty *= limits.maxTargetRadius / from;
    }
  }

  ox = radius * Math.sin(phi) * Math.cos(theta);
  oy = radius * Math.sin(phi) * Math.sin(theta);
  oz = radius * Math.cos(phi);
  let result = {
    camera: { x: tx + ox, y: ty + oy, z: target.z + oz },
    target: { x: tx, y: ty, z: target.z },
  };

  // Zoom: fly both ends forward (in) or back (out) along the way the view points. It never takes the
  // camera under the ground, and the target stays inside the radius it may wander to.
  if (zoom) {
    const dx = -ox / radius;
    const dy = -oy / radius;
    const dz = -oz / radius;
    let move = zoom * Math.max(PAN_BASE_M_S, radius * PAN_PER_DISTANCE_PER_S) * dt;
    if (dz * move < 0 && result.camera.z + dz * move < MIN_CAMERA_Z_M) {
      move = Math.max(0, (MIN_CAMERA_Z_M - result.camera.z) / dz) * Math.sign(move);
    }
    const nextX = result.target.x + dx * move;
    const nextY = result.target.y + dy * move;
    const from = Math.hypot(nextX, nextY);
    if (from > limits.maxTargetRadius) {
      const now = Math.hypot(result.target.x, result.target.y);
      move *= Math.max(0, (limits.maxTargetRadius - now) / (from - now));
    }
    result = {
      camera: { x: result.camera.x + dx * move, y: result.camera.y + dy * move, z: result.camera.z + dz * move },
      target: { x: result.target.x + dx * move, y: result.target.y + dy * move, z: result.target.z + dz * move },
    };
  }
  return result;
}
