// #1360: Content-Security-Policy, in report-only mode first (owner decision
// on the issue: ship `Content-Security-Policy-Report-Only` with a reasoned
// starting allow-list, prove it in a real browser, then switch to the
// enforcing header in a follow-up once nothing legitimate is reported).
//
// Every entry below is a source this app actually uses today:
//   - script-src: its own Vite bundle; Stripe.js and Cloudflare Turnstile,
//     both injected as <script> tags at runtime (src/main.js loadStripeJs /
//     loadTurnstileJs). 'unsafe-inline' is a known gap, not a choice:
//     index.html and the admin pages (public/admin-*.html) carry inline
//     <script> blocks, so the enforcing version needs those moved to files
//     or hashed first (the report-only phase tells us nothing else is
//     inline).
//   - style-src: 'unsafe-inline' for the same reason (large inline <style>
//     blocks and style="" attributes in index.html and the admin pages).
//   - img-src / media-src / connect-src: 'self' (built-in /models and R2
//     /uploads are same-origin) plus data: and blob: -- Three.js's GLTF
//     loader turns embedded textures into blob: URLs, and thumbnails are
//     data: URLs.
//   - frame-src / connect-src for Stripe follow Stripe's own published CSP
//     guidance (js.stripe.com + hooks.stripe.com + m.stripe.network frames,
//     api.stripe.com requests). The e2e sandbox has no Stripe keys, so these
//     are the one part not exercised in a browser here; the report endpoint
//     below is how a real run would surface a missing one.
//   - frame-ancestors 'none' repeats X-Frame-Options: DENY in CSP form.
// WebRTC peer connections (voice chat) are not governed by any fetch
// directive, so they need no entry.
export const CSP_REPORT_ONLY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data: https://api.stripe.com https://challenges.cloudflare.com",
  'frame-src https://js.stripe.com https://hooks.stripe.com https://m.stripe.network https://challenges.cloudflare.com',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'report-uri /api/csp-report',
].join('; ');

// Only documents render a CSP; attaching it to every JSON response would
// just be noise on the wire.
export function isHtmlResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

const CSP_REPORT_MAX_BYTES = 8 * 1024;
const CSP_REPORT_FIELD_MAX_CHARS = 200;
// A page that violates the policy on every resource can fire dozens of
// reports per load. They are only logged (never stored: D1 writes are the
// free tier's scarce resource), and this per-isolate budget keeps a broken or
// hostile client from flooding the Worker log.
const CSP_REPORT_LOGS_PER_MINUTE = 100;
let cspReportWindowStartMs = 0;
let cspReportsLoggedInWindow = 0;

function clip(value) {
  return typeof value === 'string' ? value.slice(0, CSP_REPORT_FIELD_MAX_CHARS) : null;
}

// POST /api/csp-report -- the report-uri target. Always 204 (a browser never
// retries, and the sender learns nothing), never authenticated (browsers send
// it without credentials), and log-only.
export async function handleCspReport(request, now = Date.now()) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength <= CSP_REPORT_MAX_BYTES) {
    let report = null;
    try {
      const text = (await request.text()).slice(0, CSP_REPORT_MAX_BYTES);
      report = JSON.parse(text)?.['csp-report'] ?? null;
    } catch {
      report = null;
    }
    if (report && typeof report === 'object') {
      if (now - cspReportWindowStartMs > 60_000) {
        cspReportWindowStartMs = now;
        cspReportsLoggedInWindow = 0;
      }
      if (cspReportsLoggedInWindow < CSP_REPORT_LOGS_PER_MINUTE) {
        cspReportsLoggedInWindow += 1;
        console.warn('csp-report', JSON.stringify({
          directive: clip(report['effective-directive'] || report['violated-directive']),
          blocked: clip(report['blocked-uri']),
          document: clip(report['document-uri']),
          source: clip(report['source-file']),
          line: Number.isFinite(report['line-number']) ? report['line-number'] : null,
        }));
      }
    }
  }
  return new Response(null, { status: 204 });
}
