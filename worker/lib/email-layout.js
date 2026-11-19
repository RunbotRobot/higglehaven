// #3877 (interface week, #3539): every email a person receives from higglehaven
// shares one small layout -- the wordmark as lettering (no image has to load for
// the email to make sense), the pale green and yellow of src/tokens.css written
// as inline values (mail clients do not load stylesheets), one sans family with
// safe fallbacks, generous space, and a plain-text part that reads well alone.
//
// Look and words only: callers pass the link and the sentences; this file never
// builds, changes or reads a link, token, amount or recipient. Operator alerts
// (schema drift) are not customer mail and stay plain.

// Local on purpose: worker/index.js owns the other escapeHtml and imports this
// layer's callers, so importing it back would be a cycle for three characters.
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const INK = '#16240a';
const INK_SOFT = '#16240aa6';
const PALE_GREEN = '#d6e8be';
const PALE_YELLOW = '#faf0c7';
const BUTTON_YELLOW = '#f6d65c';
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// heading: what happened, in one sentence (also the first line of the text part).
// paragraphs: plain sentences after it. button: { label, url } for the one thing
// to do, if any; the address is also written out so it can be copied. footnote:
// one quiet closing sentence (what happens if it was not them, when a link ends).
export function renderEmail({ heading, paragraphs = [], button = null, footnote = '' }) {
  const e = escapeHtml;
  const paras = paragraphs.map((p) => `<p style="margin:0 0 14px;font:16px/1.5 ${FONT};color:${INK};">${e(p)}</p>`).join('');
  const action = button ? `
      <p style="margin:22px 0 14px;"><a href="${e(button.url)}" style="display:inline-block;padding:12px 26px;border-radius:22px 4px 22px 4px;background:${BUTTON_YELLOW};color:${INK};font:600 16px/1.2 ${FONT};text-decoration:none;">${e(button.label)}</a></p>
      <p style="margin:0 0 14px;font:13px/1.5 ${FONT};color:${INK_SOFT};word-break:break-all;">Or copy this address into your browser: <a href="${e(button.url)}" style="color:${INK};">${e(button.url)}</a></p>` : '';
  const note = footnote ? `<p style="margin:18px 0 0;font:13px/1.5 ${FONT};color:${INK_SOFT};">${e(footnote)}</p>` : '';
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px 12px;background:${PALE_GREEN};">
  <div style="max-width:480px;margin:0 auto;padding:28px 26px;border-radius:30px 6px 30px 6px;background:${PALE_YELLOW};">
    <p style="margin:0 0 18px;font:600 24px/1 ${FONT};letter-spacing:0.5px;color:${INK};">higglehaven</p>
    <h1 style="margin:0 0 14px;font:600 20px/1.3 ${FONT};color:${INK};">${e(heading)}</h1>
    ${paras}${action}${note}
  </div>
</body></html>`;
  const text = [
    heading,
    ...paragraphs,
    ...(button ? [`${button.label}: ${button.url}`] : []),
    ...(footnote ? [footnote] : []),
    'higglehaven',
  ].join('\n\n');
  return { html, text };
}

// The customer emails, written once here so the words are kept in one place and
// a test can read every one. Each says in its first line what happened and what,
// if anything, to do; "lándlet" with its accent, never "land", "plot" or "lot".
export function verifyEmailMessage(verifyUrl) {
  return renderEmail({
    heading: 'Confirm your email to finish setting up your account.',
    paragraphs: ['Welcome to higglehaven. One tap and your account is ready.'],
    button: { label: 'Confirm my email', url: verifyUrl },
    footnote: 'This link works for 24 hours. If you did not sign up, you can ignore this email.',
  });
}

export function passwordResetMessage(resetUrl) {
  return renderEmail({
    heading: 'Someone asked to reset the password for this higglehaven account.',
    paragraphs: ['If that was you, choose a new password here.'],
    button: { label: 'Choose a new password', url: resetUrl },
    footnote: 'This link works for 1 hour. If it was not you, ignore this email; your password has not changed.',
  });
}

export function soldOutMessage(templateName, count) {
  const plural = count === 1 ? 'instance has' : 'instances have';
  return renderEmail({
    heading: `"${templateName}" just sold out.`,
    paragraphs: [`${count} placed ${plural} been removed from your lándlet.`],
    footnote: 'You get this email because you asked for sold-out emails in your settings.',
  });
}
