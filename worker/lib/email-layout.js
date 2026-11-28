// #3877 (interface week, #3539): the emails a person receives look and sound like higglehaven.
// One small layout for all of them: the wordmark as lettering (no image has to load for the email
// to make sense), the pale green and yellow of src/tokens.css as inline values (mail clients do
// not load stylesheets), one sans family with safe fallbacks, generous space, and a plain-text part
// that reads well on its own. The first line says what happened and what, if anything, to do.
// Words: "lándlet" with the accent (never "land", "plot" or "lot"), no internals, no issue numbers.
// Only the look and the words live here: every link, token, amount and recipient stays with the
// code that sends the email.
const INK = '#16240a';
const INK_SOFT = '#566249'; // ink at about 70% over the panel, as a flat colour
const PALE_GREEN = '#d6e8be';
const PANEL = '#faf0c7';
const BRAND_GREEN = '#6ca42e';
const YELLOW = '#f6d65c';
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeEmailHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// `heading`: the first line, what happened. `paragraphs`: plain strings (escaped here).
// `action`: { label, url } for the one thing to do, shown as a button and again as a plain
// link under it (so it can be copied). `footnote`: the small print (expiry, "ignore this").
export function renderEmail({ heading, paragraphs = [], action = null, footnote = '' }) {
  const paras = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:${INK};">${escapeEmailHtml(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:22px 0 10px;"><a href="${escapeEmailHtml(action.url)}" style="display:inline-block;padding:12px 26px;border-radius:22px 4px 22px 4px;background:${YELLOW};color:${INK};font-size:16px;font-weight:600;text-decoration:none;">${escapeEmailHtml(action.label)}</a></p>`
      + `<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:${INK_SOFT};word-break:break-all;">Or open this link: <a href="${escapeEmailHtml(action.url)}" style="color:${BRAND_GREEN};">${escapeEmailHtml(action.url)}</a></p>`
    : '';
  const small = footnote
    ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:${INK_SOFT};">${escapeEmailHtml(footnote)}</p>`
    : '';
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${PALE_GREEN};">`
    + `<div style="padding:24px 12px;background:${PALE_GREEN};font-family:${FONT};">`
    + `<div style="max-width:520px;margin:0 auto;padding:28px 26px;border-radius:30px 6px 30px 6px;background:${PANEL};">`
    + `<p style="margin:0 0 20px;font-size:22px;font-weight:700;letter-spacing:0.3px;color:${BRAND_GREEN};">higglehaven</p>`
    + `<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;font-weight:600;color:${INK};">${escapeEmailHtml(heading)}</h1>`
    + `${paras}${button}${small}`
    + `</div></div></body></html>`;
  const text = [
    heading,
    ...paragraphs,
    ...(action ? [`${action.label}: ${action.url}`] : []),
    ...(footnote ? [footnote] : []),
    '— higglehaven',
  ].join('\n\n');
  return { html, text };
}

// The three emails a person can receive. Each returns { subject, html, text }.
export function verifyEmailMessage(verifyUrl) {
  return {
    subject: 'Confirm your higglehaven email',
    ...renderEmail({
      heading: 'Confirm your email to finish setting up your account',
      paragraphs: ['Welcome to higglehaven! One tap confirms this is your email address.'],
      action: { label: 'Confirm my email', url: verifyUrl },
      footnote: "This link works for 24 hours. If you didn't sign up, you can ignore this email.",
    }),
  };
}

export function passwordResetMessage(resetUrl) {
  return {
    subject: 'Choose a new higglehaven password',
    ...renderEmail({
      heading: 'Someone asked to reset the password for this higglehaven account',
      paragraphs: ['If that was you, choose a new password here.'],
      action: { label: 'Choose a new password', url: resetUrl },
      footnote: "This link works for 1 hour. If you didn't ask for this, ignore this email and your password stays as it is.",
    }),
  };
}

export function soldOutMessage(productName, count) {
  const plural = count === 1 ? 'instance has' : 'instances have';
  const line = `"${productName}" just sold out — ${count} placed ${plural} been removed from your lándlet.`;
  const rendered = renderEmail({
    heading: `"${productName}" just sold out`,
    paragraphs: [`${count} placed ${plural} been removed from your lándlet.`],
  });
  return { subject: `"${productName}" just sold out`, html: rendered.html, text: rendered.text, line };
}

const emailMoney = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// #4617: one receipt for a basket that held products from several sellers: a line per seller naming what was bought
// from them, then the total. `sections`: [{ sellerName, lines: [{ name, quantity, totalCents }] }].
export function basketReceiptMessage(sections, totalCents) {
  const count = sections.reduce((n, section) => n + section.lines.length, 0);
  const paragraphs = sections.map((section) => {
    const items = section.lines.map((l) => `${l.name} × ${l.quantity} (${emailMoney(l.totalCents)})`).join(', ');
    return `From ${section.sellerName}: ${items}.`;
  });
  paragraphs.push(`Total paid: ${emailMoney(totalCents)}.`);
  const heading = `Your order: ${count} ${count === 1 ? 'product' : 'products'} from ${sections.length} ${sections.length === 1 ? 'seller' : 'sellers'}`;
  return {
    subject: 'Your higglehaven order',
    ...renderEmail({
      heading,
      paragraphs,
      footnote: 'Each seller sends their own part. Find every order under My purchases.',
    }),
  };
}
