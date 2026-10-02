import { describe, expect, it } from 'vitest';
import { skeletonSignatureFromBones } from './skeletonSignature.js';

function makeBone(name, parent = null) {
  return { name, parent, isBone: true };
}

describe('skeletonSignatureFromBones', () => {
  it('returns a 64-character lowercase hex digest', async () => {
    const hips = makeBone('hips');
    const spine = makeBone('spine', hips);
    const signature = await skeletonSignatureFromBones([hips, spine]);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of the order bones appear in the array', async () => {
    const hips = makeBone('hips');
    const spine = makeBone('spine', hips);
    const head = makeBone('head', spine);
    const leftLeg = makeBone('leftLeg', hips);
    const rightLeg = makeBone('rightLeg', hips);
    const bones = [hips, spine, head, leftLeg, rightLeg];

    const signature = await skeletonSignatureFromBones(bones);
    const shuffled = [rightLeg, head, hips, leftLeg, spine];
    const shuffledSignature = await skeletonSignatureFromBones(shuffled);

    expect(shuffledSignature).toBe(signature);
  });

  it('produces the same signature across independently-built but structurally identical rigs', async () => {
    function buildRig() {
      const hips = makeBone('hips');
      const spine = makeBone('spine', hips);
      const leftLeg = makeBone('leftLeg', hips);
      return [hips, spine, leftLeg];
    }

    const signatureA = await skeletonSignatureFromBones(buildRig());
    const signatureB = await skeletonSignatureFromBones(buildRig());

    expect(signatureA).toBe(signatureB);
  });

  it('produces a different signature for a different bone name', async () => {
    const hips = makeBone('hips');
    const spine = makeBone('spine', hips);

    const original = await skeletonSignatureFromBones([hips, spine]);

    const hips2 = makeBone('hips');
    const neck = makeBone('neck', hips2);
    const renamed = await skeletonSignatureFromBones([hips2, neck]);

    expect(renamed).not.toBe(original);
  });

  it('produces a different signature for a different hierarchy with the same bone names', async () => {
    // hips -> spine -> head
    const hips = makeBone('hips');
    const spine = makeBone('spine', hips);
    const head = makeBone('head', spine);
    const chain = await skeletonSignatureFromBones([hips, spine, head]);

    // hips -> spine, hips -> head (same names, different parent for "head")
    const hips2 = makeBone('hips');
    const spine2 = makeBone('spine', hips2);
    const head2 = makeBone('head', hips2);
    const fork = await skeletonSignatureFromBones([hips2, spine2, head2]);

    expect(fork).not.toBe(chain);
  });

  it('supports multiple root bones, sorted independently of array order', async () => {
    const rootA = makeBone('rootA');
    const rootB = makeBone('rootB');
    const child = makeBone('child', rootA);

    const signature = await skeletonSignatureFromBones([rootA, rootB, child]);
    const reordered = await skeletonSignatureFromBones([rootB, child, rootA]);

    expect(reordered).toBe(signature);
  });

  it('returns a digest for an empty bones array', async () => {
    const signature = await skeletonSignatureFromBones([]);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
