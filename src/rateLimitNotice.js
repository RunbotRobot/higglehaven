// #3258 (owner decision: a message that refuses or limits an action says how
// much and until when). Builds the player-facing sentence from the numbers a
// rate-limit 429 carries ({ limit, windowSeconds, retryAfterSeconds }, see
// worker/lib/rate-limit.js), so no client hard-codes a limit the server owns.
// DOM-free so it can be unit tested. Returns null when the response carried
// no numbers, so the caller keeps its static fallback text.
export function rateLimitNoticeText(noun, rateLimit) {
  if (!rateLimit) return null;
  const windowMinutes = Math.max(1, Math.round(rateLimit.windowSeconds / 60));
  const waitMinutes = Math.ceil(rateLimit.retryAfterSeconds / 60);
  const wait = rateLimit.retryAfterSeconds < 60
    ? 'in under a minute'
    : `in about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}`;
  return `You can collect up to ${rateLimit.limit} ${noun} every ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'}. Try again ${wait}.`;
}
