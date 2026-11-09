// #2045 (client half): which custom avatar model each nearby builder's body
// should show, decided purely from data so it is unit-testable without
// three.js (same duck-typed, dependency-free approach as
// src/sharedModelResources.js). presenceAndContent.js owns the actual
// loading, caching and scene-graph swapping; this file only answers "which
// template id may be drawn right now".
//
// GET /api/presence resolves each builder's equipped avatar server-side
// (equippedAvatar: { templateId, modelUrl } | null), so a client can never
// claim someone else's model. null means "draw the default body": nothing
// equipped, a deleted template, a template with no model, or a suspended
// seller's template (**Nothing that isn't actively for sale is visible to
// shoppers or builders**).

// Distinct custom models drawn at once. Each is a full GLB held in memory and
// uploaded to the GPU, so a crowded landlet must not load one per avatar --
// beyond the cap an avatar simply keeps the default body (the issue's own
// suggested ~6).
import { normalizeClipRoles } from '../avatarClipNames.js';

export const MAX_DISTINCT_CUSTOM_AVATAR_MODELS = 6;

// Fail open: how long a model that failed to load is left alone before the
// next poll may try it again. The default body is shown meanwhile, never an
// error. Long enough that a permanently broken file is not re-fetched every
// poll tick, short enough that a transient network blip heals itself.
export const CUSTOM_AVATAR_RETRY_AFTER_MS = 60_000;

// Normalizes whatever a poll carried for one builder to { templateId, modelUrl }
// or null. Anything malformed (an older server without the field, a missing
// url) is the default body.
export function normalizeEquippedAvatar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { templateId, modelUrl } = raw;
  if (typeof templateId !== 'string' || !templateId) return null;
  if (typeof modelUrl !== 'string' || !modelUrl) return null;
  // #3230: skeletonSignature rides along (null from an older server, or a
  // model with no skeleton) so animationForAvatar can run the compatibility
  // check without another request.
  // #3314: the seller's chosen idle/walk/fly clips (null when nobody chose, or
  // from an older server), so this body plays the same clips its owner's does.
  return { templateId, modelUrl, skeletonSignature: normalizeSignature(raw.skeletonSignature), clipRoles: normalizeClipRoles(raw.clipRoles) };
}

function normalizeSignature(raw) {
  return typeof raw === 'string' && raw ? raw : null;
}

// #3230: same shape as normalizeEquippedAvatar -- { templateId, modelUrl,
// skeletonSignature } or null (nothing applied, an older server without the
// field, or anything malformed).
export function normalizeEquippedAnimation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { templateId, modelUrl } = raw;
  if (typeof templateId !== 'string' || !templateId) return null;
  if (typeof modelUrl !== 'string' || !modelUrl) return null;
  return { templateId, modelUrl, skeletonSignature: normalizeSignature(raw.skeletonSignature) };
}

// #3230: the applied animation to play on this avatar's body, or null for
// "use the avatar's own clips". Same rule the shopper's own avatar uses
// (createCustomShopAvatar / animationCompatibility, #1162): exact signature
// equality, and both signatures must actually be present -- a missing one can
// never match. Incompatible or absent: fail open to the avatar's own clips.
export function animationForAvatar(equippedAvatar, equippedAnimation) {
  if (!equippedAvatar || !equippedAnimation) return null;
  if (!equippedAvatar.skeletonSignature || !equippedAnimation.skeletonSignature) return null;
  return equippedAvatar.skeletonSignature === equippedAnimation.skeletonSignature ? equippedAnimation : null;
}

// #3230: horizontal speed (m/s) above which another player's avatar plays its
// walk clip. Presence only carries positions, so locomotion is inferred from
// how far the avatar travelled between its last two snapshots; a stationary
// avatar's jitter is far below this, a real walk (several m/s) far above.
export const OTHER_AVATAR_WALK_SPEED_MPS = 0.4;

// Which named clip ('idle' | 'walk') an observed movement calls for. Flying
// avatars are never drawn for other users (#2043), so 'fly' never applies.
// An avatar that stops reports a snapshot at the same spot, which reads as
// idle by distance alone. t (lerp progress toward the latest snapshot) only
// matters when snapshots stop arriving altogether: it is measured from when the
// poll *started*, so ordinary response latency already puts it past 1 while the
// avatar is still walking, which is why the cutoff is a whole extra interval of
// staleness (t >= 2) rather than t >= 1.
export const OTHER_AVATAR_STALE_LERP_T = 2;

export function locomotionStateFor(fromX, fromY, toX, toY, lerpDurationMs, t) {
  if (t >= OTHER_AVATAR_STALE_LERP_T) return 'idle';
  const seconds = Math.max(lerpDurationMs, 1) / 1000;
  return Math.hypot(toX - fromX, toY - fromY) / seconds > OTHER_AVATAR_WALK_SPEED_MPS ? 'walk' : 'idle';
}

// failedAt: Map<templateId, timestampMs> of recent load failures.
export function isTemporarilyFailed(failedAt, templateId, now) {
  const at = failedAt.get(templateId);
  return at !== undefined && now - at < CUSTOM_AVATAR_RETRY_AFTER_MS;
}

// wanted:   Map<builderId, { templateId, modelUrl } | null>, in the order the
//           poll listed the builders (the server's order, stable per poll).
// shown:    Set<templateId> already on screen -- these keep their slot first,
//           so a new arrival can never bump an avatar that is already drawn
//           (no flicker of custom -> default -> custom as people come and go).
// failedAt: see isTemporarilyFailed.
// Returns the Set of templateIds that may be drawn this frame, size <= cap.
export function chooseAllowedTemplateIds(wanted, shown, failedAt, now, cap = MAX_DISTINCT_CUSTOM_AVATAR_MODELS) {
  const wantedIds = new Set();
  for (const equipped of wanted.values()) {
    if (equipped && !isTemporarilyFailed(failedAt, equipped.templateId, now)) wantedIds.add(equipped.templateId);
  }
  const allowed = new Set();
  for (const templateId of shown) {
    if (allowed.size >= cap) break;
    if (wantedIds.has(templateId)) allowed.add(templateId);
  }
  for (const templateId of wantedIds) {
    if (allowed.size >= cap) break;
    allowed.add(templateId);
  }
  return allowed;
}

// The model one builder should currently be drawn with, or null for the
// default body.
export function desiredAvatarFor(equipped, allowed) {
  return equipped && allowed.has(equipped.templateId) ? equipped : null;
}
