// #3328 (leaf 5/7 of #3323): who may open a bundle for editing, and whether
// they are asked first. Pure, so the rules are testable without a scene.
//
// - An unsaved (unlinked) bundle is the builder's own; Edit opens at once.
// - A linked bundle is a live template. Only the builder who saved it may
//   edit it, and they are asked once per session (per bundle) because the
//   change reaches every other copy.
// - Anyone else gets Edit disabled with a reason; Unbundle is their path.
//
// `isCreator` is true/false once known, or null/undefined while the
// builder's own bundle list is still loading.

export const NOT_CREATOR_REASON =
  'Only the builder who saved this bundle can change it. Unbundle it to make your own copy.';
export const CHECKING_CREATOR_REASON = 'Checking who saved this bundle…';

export function bundleEditDecision({ linked, isCreator, acknowledged = false } = {}) {
  if (!linked) return { canEdit: true, needsConfirm: false, reason: '' };
  if (isCreator === true) return { canEdit: true, needsConfirm: !acknowledged, reason: '' };
  if (isCreator === false) return { canEdit: false, needsConfirm: false, reason: NOT_CREATOR_REASON };
  return { canEdit: false, needsConfirm: false, reason: CHECKING_CREATOR_REASON };
}
