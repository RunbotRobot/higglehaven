import { describe, expect, it } from 'vitest';

// #2716: pure-JS mirror of SHOP_SKY_FRAGMENT_SHADER's fbm() footprint
// formula (src/shop/sky.js) -- not imported from the shader string itself,
// since GLSL isn't executable here, so this must be kept in sync BY HAND
// with that function's own `footprint` line if it ever changes. See that
// line's own #2716 comment for the full derivation these tests exercise:
// the old (buggy) L1 combination oscillated with swirlAngle's own rotation,
// and the fix replaces it with a rotation-invariant Frobenius norm.

// The old formula: fwidth(p.x) + fwidth(p.y), i.e.
// (|dpxdX|+|dpxdY|) + (|dpydX|+|dpydY|).
function oldL1Footprint(dpxdX, dpxdY, dpydX, dpydY) {
  return Math.abs(dpxdX) + Math.abs(dpxdY) + Math.abs(dpydX) + Math.abs(dpydY);
}

// The fixed formula: sqrt(2) * the Frobenius norm of the same four entries.
function newFootprint(dpxdX, dpxdY, dpydX, dpydY) {
  return Math.sqrt(2) * Math.sqrt(dpxdX ** 2 + dpxdY ** 2 + dpydX ** 2 + dpydY ** 2);
}

// Applies swirlAngle's own mat2(c,-s,s,c) rotation to a fixed camera
// Jacobian J ([a,b,c,d] for [[a,b],[c,d]]) by left-multiplying by R(phi) --
// mirrors how the chain rule carries `swirled = mat2(c,-s,s,c) *
// normalizedXY`'s rotation straight through to p's own screen-space
// derivatives unchanged in form.
function rotateJacobian([a, b, c, d], phi) {
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  return [
    cosP * a - sinP * c, cosP * b - sinP * d,
    sinP * a + cosP * c, sinP * b + cosP * d,
  ];
}

const SOME_ANGLES = [0, 0.001, Math.PI / 8, Math.PI / 4, 1.2345, Math.PI / 2, 2.1, Math.PI, 5.9];

// A Jacobian is "unsheared" here if it's diagonal, i.e. [a, 0, 0, d] -- its
// singular vectors already line up with the screen's own x/y axes, exactly
// the case the shader comment's closed-form (s1+s2)*(|cos phi|+|sin phi|)
// derivation assumes.
const UNSHEARED_JACOBIANS = [
  [0.01, 0, 0, 0.01], // isotropic
  [0.02, 0, 0, 0.005], // anisotropic
  [0.015, 0, 0, 0], // degenerate (one zero singular value)
];

// A sheared Jacobian (singular vectors not axis-aligned) breaks that clean
// closed form -- see the shader comment's own acknowledgment of this.
const SHEARED_JACOBIANS = [
  [0.01, 0.004, -0.002, 0.013],
  [0.03, -0.01, 0.02, -0.025],
];

describe('shop sky fbm footprint rotation-invariance (#2716)', () => {
  it('the fixed footprint stays exactly constant across every swirlAngle rotation, for any camera Jacobian (sheared or not)', () => {
    for (const J of [...UNSHEARED_JACOBIANS, ...SHEARED_JACOBIANS]) {
      const values = SOME_ANGLES.map((phi) => newFootprint(...rotateJacobian(J, phi)));
      for (const v of values) expect(v).toBeCloseTo(values[0], 9);
    }
  });

  it('the old L1 footprint swings by exactly sqrt(2)x between its own min and max, for any unsheared (axis-aligned) camera Jacobian', () => {
    for (const J of UNSHEARED_JACOBIANS) {
      const values = SOME_ANGLES.map((phi) => oldL1Footprint(...rotateJacobian(J, phi)));
      expect(Math.max(...values) / Math.min(...values)).toBeCloseTo(Math.sqrt(2), 6);
    }
  });

  it('the fixed footprint coincides exactly with the old formula\'s own minimum when the camera Jacobian is locally isotropic', () => {
    const J = [0.018, 0, 0, 0.018];
    const oldValues = SOME_ANGLES.map((phi) => oldL1Footprint(...rotateJacobian(J, phi)));
    expect(newFootprint(...J)).toBeCloseTo(Math.min(...oldValues), 9);
  });

  it('the fixed footprint lands within the old formula\'s own already-tested [min, max] range for any unsheared camera Jacobian', () => {
    for (const J of UNSHEARED_JACOBIANS) {
      const oldValues = SOME_ANGLES.map((phi) => oldL1Footprint(...rotateJacobian(J, phi)));
      const fixedValue = newFootprint(...J); // rotation-invariant, so any phi gives the same value
      expect(fixedValue).toBeGreaterThanOrEqual(Math.min(...oldValues) - 1e-9);
      expect(fixedValue).toBeLessThanOrEqual(Math.max(...oldValues) + 1e-9);
    }
  });

  it('for a sheared camera Jacobian, the fixed footprint can land outside the old formula\'s own [min, max] range -- but never outside the universal Frobenius <= L1 <= 2*Frobenius bound that holds for any matrix', () => {
    for (const J of SHEARED_JACOBIANS) {
      const frobenius = Math.sqrt(J.reduce((sum, x) => sum + x * x, 0));
      const fixedValue = newFootprint(...J);
      // sqrt(2) sits strictly between the universal 1x/2x entrywise-norm
      // bound, so this always holds by construction -- documents the
      // weaker guarantee the shader comment falls back on for a sheared
      // Jacobian, where the stronger "exact match" claim above doesn't.
      expect(fixedValue).toBeGreaterThanOrEqual(frobenius - 1e-9);
      expect(fixedValue).toBeLessThanOrEqual(2 * frobenius + 1e-9);
    }
  });
});
