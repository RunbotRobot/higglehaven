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
  return { templateId, modelUrl };
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
