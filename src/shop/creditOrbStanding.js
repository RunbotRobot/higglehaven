// #3441: bookkeeping for where the person stands against the orb collect
// limit, from the numbers the server sends ({ limit, windowSeconds, remaining,
// retryAfterSeconds }, worker/lib/rate-limit.js's rateLimitStanding, or the
// same fields a 429 carries). DOM-free so it can be unit tested. The client
// never holds a limit of its own: it only remembers the server's last answer
// and when that answer says the next collect is allowed.

// A state for "the server says you are at the limit until limitedUntilMs", or
// one with limitedUntilMs null for "you still have collects left". Returns
// null for a reply with no usable numbers.
export function creditOrbStandingState(reply, nowMs) {
  if (!reply || typeof reply.limit !== 'number' || typeof reply.windowSeconds !== 'number') return null;
  const remaining = typeof reply.remaining === 'number' ? reply.remaining : null;
  const retryAfterSeconds = typeof reply.retryAfterSeconds === 'number' ? reply.retryAfterSeconds : 0;
  return {
    limit: reply.limit,
    windowSeconds: reply.windowSeconds,
    remaining,
    limitedUntilMs: remaining === 0 ? nowMs + retryAfterSeconds * 1000 : null,
  };
}

// The rate-limit numbers a notice needs while the person is still limited
// ({ limit, windowSeconds, retryAfterSeconds } with the wait counted down from
// now), or null once the limit has lifted or none is known.
export function creditOrbLimitNow(state, nowMs) {
  if (!state || state.limitedUntilMs === null || nowMs >= state.limitedUntilMs) return null;
  return {
    limit: state.limit,
    windowSeconds: state.windowSeconds,
    retryAfterSeconds: Math.max(1, Math.ceil((state.limitedUntilMs - nowMs) / 1000)),
  };
}
