// #3258 (owner decision: a message that refuses or limits an action says how
// much and until when). Builds player-facing sentences from the numbers a
// rate-limit 429 carries ({ limit, windowSeconds, retryAfterSeconds }, see
// worker/lib/rate-limit.js), so no client hard-codes a limit the server owns.
// DOM-free so it can be unit tested. Each builder returns null when the
// response carried no numbers, so the caller keeps its static fallback text.
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function windowText(rateLimit) {
  return plural(Math.max(1, Math.round(rateLimit.windowSeconds / 60)), 'minute');
}

function waitText(rateLimit) {
  if (rateLimit.retryAfterSeconds < 60) return 'in under a minute';
  return `in about ${plural(Math.ceil(rateLimit.retryAfterSeconds / 60), 'minute')}`;
}

// A notice about one specific thing, e.g. "orbs".
export function rateLimitNoticeText(noun, rateLimit) {
  if (!rateLimit) return null;
  return `You can collect up to ${rateLimit.limit} ${noun} every ${windowText(rateLimit)}. Try again ${waitText(rateLimit)}.`;
}

// #3275: the same decision for every other place a player can hit a limit.
// apiError (src/api.js) uses this as the message of any 429 that carries the
// numbers, so each caller that shows `err.message` already reads right without
// a hard-coded sentence of its own.
export function rateLimitMessage(rateLimit) {
  if (!rateLimit) return null;
  return `You've reached the limit for this (${rateLimit.limit} every ${windowText(rateLimit)}). Try again ${waitText(rateLimit)}.`;
}
