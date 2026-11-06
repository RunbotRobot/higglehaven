// #1360: Content-Security-Policy. It shipped report-only first (#3165, owner
// decision on the issue) and is now the enforcing header (owner un-gated the
// switch on 2026-11-06: production has no real traffic to wait on, and a
// real-browser pass over every page under the enforcing header found 0
// violations). `report-uri` stays on it, so a violation a real user ever hits
// still surfaces in the Worker log.
//
// Every entry below is a source this app actually uses today:
//   - script-src: its own Vite bundle and the classic scripts under public/
//     (the viewport fix and the admin pages' scripts); Stripe.js and
//     Cloudflare Turnstile, both injected as <script> tags at runtime
//     (src/main.js loadStripeJs / loadTurnstileJs). No 'unsafe-inline': every
//     page's script blocks live in files, and scripts/check-no-inline-blocks.mjs
//     (a pretest step) fails the build if one comes back, because a browser
//     would just ignore it and the page would silently stop working.
//   - style-src: 'self' only, so <style> elements are gone too (index.html's
//     CSS is src/app.css, the admin pages' are public/admin-*.css). CSSOM
//     writes (el.style.x = ...) are not governed by it.
//   - style-src-attr: 'unsafe-inline' stays, narrowly, for style="" attributes
//     (a few static ones on the admin pages and one computed bar width). An
//     attribute cannot run script or add rules, so it is a far smaller hole
//     than a style element, and it is kept as a hedge: Stripe.js and Turnstile
//     build iframes and widgets in our page, and neither vendor's published
//     guidance says whether they set inline style attributes. The e2e sandbox
//     has no keys for either, so this is the one part not proven in a browser
//     here; dropping it is the follow-up once a real-keys pass (or the
//     csp-report log) shows no style-src-attr violation.
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
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com https://challenges.cloudflare.com",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
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
