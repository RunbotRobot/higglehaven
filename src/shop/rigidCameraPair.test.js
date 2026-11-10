// #3385: the avatar and its follow camera are one rigid pair at the dome.
// The dome here is an independently written ellipsoid cap (not the clamp
// formula under test): below the wall's rim the world is a cylinder of radius
// R, above it the cross-section shrinks as R * sqrt(1 - (h / rise)^2).
import { describe, expect, it } from 'vitest';
import { keepPairInside } from './rigidCameraPair.js';

const R = 100;
const WALL_H = 20;
const RISE = 60;
const FOLLOW = 4.2;
const ANCHOR_H = 1.5;
const AVATAR_BODY_M = 0.4; // half-width reserved for the body
const CAMERA_MARGIN_M = 0.3;

function domeRadiusAt(z) {
  const h = z - WALL_H;
  return h <= 0 ? R : R * Math.sqrt(Math.max(0, 1 - (h / RISE) ** 2));
}

// Look direction from yaw (about +z) and pitch (positive looks up).
function look(yaw, pitch) {
  return { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
}

function resolve({ x, y, z }, dir) {
  const camZ = z + ANCHOR_H - dir.z * FOLLOW;
  const offsetX = -dir.x * FOLLOW;
  const offsetY = -dir.y * FOLLOW;
  const avatarLimitM = domeRadiusAt(z) - AVATAR_BODY_M;
  const cameraLimitM = domeRadiusAt(camZ) - CAMERA_MARGIN_M;
  const out = keepPairInside({ x, y, offsetX, offsetY, avatarLimitM, cameraLimitM });
  return { out, offsetX, offsetY, camZ, avatarLimitM, cameraLimitM };
}

function expectLegal({ out, offsetX, offsetY, avatarLimitM, cameraLimitM }) {
  expect(out).not.toBeNull();
  // (a) the avatar is inside, (b) the camera is inside its limit
  expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(avatarLimitM + 1e-6);
  expect(Math.hypot(out.x + offsetX, out.y + offsetY)).toBeLessThanOrEqual(cameraLimitM + 1e-6);
  // (c) the horizontal offset, hence the 3D distance, is unchanged: the camera
  // is derived from the resolved avatar by the same offset.
  const camX = out.x + offsetX;
  const camY = out.y + offsetY;
  expect(Math.hypot(camX - out.x, camY - out.y)).toBeCloseTo(Math.hypot(offsetX, offsetY), 9);
}

const heights = [2, 10, 19, 30, 55];
const yaws = [0, 0.7, Math.PI / 2, Math.PI, -2.1]; // 0 = toward +x (outward at +x)
const pitches = [0, 0.5, -0.4];

describe('keepPairInside: avatar on and beyond the boundary', () => {
  for (const z of heights) {
    for (const yaw of yaws) {
      for (const pitch of pitches) {
        it(`z=${z} yaw=${yaw.toFixed(2)} pitch=${pitch}: both ends inside, distance held`, () => {
          const dir = look(yaw, pitch);
          for (const beyond of [0, 0.5, 20]) {
            const edge = domeRadiusAt(z) - AVATAR_BODY_M + beyond;
            const r = resolve({ x: edge, y: 0, z }, dir);
            expectLegal(r);
          }
        });
      }
    }
  }

  it('leaves a pair that is already inside exactly where it is', () => {
    const r = resolve({ x: 10, y: 5, z: 3 }, look(0.3, 0.1));
    expect(r.out).toEqual({ x: 10, y: 5 });
  });

  it('flying out with the camera behind: the avatar reaches the dome first, camera free', () => {
    // Looking outward (+x): camera is on the inner side.
    const z = 5;
    const r = resolve({ x: 500, y: 0, z }, look(0, 0));
    expect(r.out.x).toBeCloseTo(domeRadiusAt(z) - AVATAR_BODY_M, 6);
  });

  it('backing out with the camera on the outer side: the avatar stops a follow distance short', () => {
    // Looking toward the centre (yaw = pi at +x): camera sits outward of the avatar.
    const z = 5;
    const r = resolve({ x: 500, y: 0, z }, look(Math.PI, 0));
    expect(r.out.x).toBeCloseTo(domeRadiusAt(z) - CAMERA_MARGIN_M - FOLLOW, 6);
    expect(r.out.x).toBeLessThan(domeRadiusAt(z) - AVATAR_BODY_M - 3);
  });

  it('the avatar gets closer to the dome facing it than facing the centre', () => {
    const z = 5;
    const facingOut = resolve({ x: 500, y: 0, z }, look(0, 0)).out.x;
    const facingIn = resolve({ x: 500, y: 0, z }, look(Math.PI, 0)).out.x;
    expect(facingOut).toBeGreaterThan(facingIn);
  });

  it('slides along the boundary: only the outward part of the motion is removed', () => {
    const z = 5;
    const dir = look(Math.PI, 0);
    const a = resolve({ x: 99, y: 0, z }, dir).out;
    const b = resolve({ x: 99, y: 30, z }, dir).out;
    expect(b.y).toBeGreaterThan(a.y + 20);
  });
});

describe('keepPairInside: orbiting the camera at the boundary never blocks the turn', () => {
  for (const z of [3, 25, 50]) {
    it(`a full 360 degree orbit at z=${z} keeps both ends inside at every step`, () => {
      // The avatar rests at the boundary; the camera swings round it. Each
      // frame the previous resolved position is the next frame's start.
      let pos = { x: domeRadiusAt(z) - AVATAR_BODY_M, y: 0 };
      let previous = pos;
      for (let step = 0; step <= 360; step += 3) {
        const dir = look((step * Math.PI) / 180, 0.2);
        const r = resolve({ x: pos.x, y: pos.y, z }, dir);
        expectLegal(r);
        // The avatar slides, it does not jump across the world.
        expect(Math.hypot(r.out.x - previous.x, r.out.y - previous.y)).toBeLessThan(2 * FOLLOW);
        previous = r.out;
        pos = r.out;
      }
    });
  }
});

describe('keepPairInside: degenerate geometry', () => {
  it('looking straight down (zero horizontal offset) is just the tighter of the two discs', () => {
    const out = keepPairInside({ x: 500, y: 0, offsetX: 0, offsetY: 0, avatarLimitM: 50, cameraLimitM: 40 });
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(40, 9);
  });

  it('returns null when no avatar position can keep the camera inside', () => {
    expect(keepPairInside({ x: 0, y: 0, offsetX: 10, offsetY: 0, avatarLimitM: 2, cameraLimitM: 2 })).toBeNull();
  });

  it('picks the nearer corner when both discs bind', () => {
    // Discs: avatar radius 10 at the origin; camera disc radius 10 centred at (-8, 0).
    const out = keepPairInside({ x: 5, y: 40, offsetX: 8, offsetY: 0, avatarLimitM: 10, cameraLimitM: 10 });
    expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(10 + 1e-9);
    expect(Math.hypot(out.x - 8 * -1, out.y)).toBeLessThanOrEqual(10 + 1e-9);
    expect(out.y).toBeGreaterThan(0); // the corner on the avatar's own side
  });
});
