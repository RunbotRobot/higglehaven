// #2941 (owner decision, 2026-10-31): Cloudflare Turnstile, invisible/
// managed mode, on signup only. Two hard rules from the owner, both
// encoded here rather than left to callers: (1) fail open -- a verify
// error, timeout, or missing token (e.g. the widget itself failed to
// load, a real failure mode the owner has personally hit on privacy-
// hardened browsers/in-app webviews/some VPN setups) must never block a
// real signup; (2) no visible consequence, ever -- this module only ever
// returns a plain boolean for handleSignup to log, never throws, so
// there's no HttpError path here for a caller to accidentally surface to
// the user.
//
// Same guarded-secret shape as RESEND_API_KEY/DIDIT_API_KEY (docs/API.md):
// with TURNSTILE_SECRET_KEY unset -- true for local dev and the entire
// automated test suite, neither of which ever configures it --
// turnstileConfigured(env) is false and handleSignup skips calling this
// module's verify function entirely, so this file's own fetch is never
// reached there and needs no test-only mock.
export function turnstileConfigured(env) {
  return !!env.TURNSTILE_SECRET_KEY;
}

// Returns true only on an explicit, clean Cloudflare-confirmed success.
// Everything else -- a missing/empty token, a network-level fetch
// rejection, a non-2xx response, a malformed response body, or an
// explicit { success: false } -- returns false. Never throws: the one
// thing every caller needs is a plain yes/no, same shape as
// worker/index.js's own sendEmail (the one other "fail open on a
// third-party HTTP call" example in this codebase).
export async function verifyTurnstileToken(env, token, remoteIp) {
  if (!token) return false;
  let response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(remoteIp && remoteIp !== 'unknown' ? { remoteip: remoteIp } : {}),
      }),
    });
  } catch (error) {
    console.error('Turnstile verify request failed', error);
    return false;
  }
  if (!response.ok) {
    console.error('Turnstile verify request failed', response.status, await response.text().catch(() => ''));
    return false;
  }
  const data = await response.json().catch(() => null);
  return data?.success === true;
}
