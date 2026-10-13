// Pure logic behind #1816's spawn-location fix. main.js's own
// pickShopSpawnLocation supplies the live Math.random() draw and the
// current shopMaxRadiusM(); this file only does the plain-number
// uniform-disk-sampling correction, so it can be tested directly instead
// of only through a live three.js scene.

// #1816: Math.random() * maxRadiusM alone samples the spawn *radius*
// uniformly over [0, maxRadiusM) -- for a disk, that's biased toward the
// center, since area scales with r and sampling r itself over-represents
// small radii (50% of draws would land within the inner half of the
// radius, when a true uniform-area spawn should only put 25% that
// close). Math.sqrt on the uniform draw before scaling is the standard
// correction: it compensates for area scaling with r so the result is
// uniform over the disk's *area*, not its radius.
export function sampleUniformDiskRadiusM(maxRadiusM, randomValue) {
  return maxRadiusM * Math.sqrt(randomValue);
}
