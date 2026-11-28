import { describe, expect, it } from 'vitest';
import { renderEmail, verifyEmailMessage, passwordResetMessage, soldOutMessage, basketReceiptMessage } from './email-layout.js';

// #3877: every email a person can receive, rendered and read the way a person reads it.
const URL_A = 'https://higglehaven.com/?verifyEmail=abc123';
const messages = {
  verify: verifyEmailMessage(URL_A),
  reset: passwordResetMessage('https://higglehaven.com/?resetPassword=xyz789'),
  soldOut: soldOutMessage('Oak Door', 3),
};
// Words a person must never read (#3613 the word is "lándlet"; #3017 no internals).
const BANNED = [/\bland\b/i, /\blánd\b/i, /\bplot\b/i, /\blot\b/i, /(^|\s)#\d{2,}\b/, /docs\//i, /\bAPI\b/, /seller identity/i];

describe('the emails', () => {
  for (const [name, message] of Object.entries(messages)) {
    it(`${name}: has the wordmark, a subject, a plain-text part that reads alone, and no banned words`, () => {
      expect(message.subject.length).toBeGreaterThan(5);
      expect(message.html).toContain('higglehaven');
      expect(message.html).toContain('#faf0c7'); // the panel's yellow, inline
      expect(message.text).not.toMatch(/<[a-z]/i); // no markup in the plain part
      expect(message.text.startsWith(message.text.split('\n\n')[0])).toBe(true);
      for (const banned of BANNED) {
        expect(message.html, String(banned)).not.toMatch(banned);
        expect(message.text, String(banned)).not.toMatch(banned);
        expect(message.subject, String(banned)).not.toMatch(banned);
      }
    });
  }

  it('the verify and reset emails carry their link both as a button and as plain text, unchanged', () => {
    expect(messages.verify.html).toContain(`href="${URL_A}"`);
    expect(messages.verify.text).toContain(URL_A);
    expect(messages.reset.text).toContain('https://higglehaven.com/?resetPassword=xyz789');
    expect(messages.reset.text).toMatch(/1 hour/);
    expect(messages.verify.text).toMatch(/24 hours/);
  });

  it('the first line says what happened', () => {
    expect(messages.verify.text.split('\n\n')[0]).toMatch(/confirm your email/i);
    expect(messages.reset.text.split('\n\n')[0]).toMatch(/reset the password/i);
    expect(messages.soldOut.text.split('\n\n')[0]).toBe('"Oak Door" just sold out');
  });

  it('the sold-out email says "lándlet" with the accent and agrees with the count', () => {
    expect(messages.soldOut.text).toContain('3 placed instances have been removed from your lándlet.');
    expect(soldOutMessage('Oak Door', 1).text).toContain('1 placed instance has been removed from your lándlet.');
  });

  it('free text a seller wrote cannot become markup', () => {
    const hostile = soldOutMessage('<script>alert(1)</script> "x"', 1);
    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).toContain('&lt;script&gt;');
  });

  it('renderEmail escapes every string it puts in the html', () => {
    const { html } = renderEmail({ heading: 'a<b', paragraphs: ['<i>'], action: { label: '<x>', url: 'https://e.com/?a=1&b=2' }, footnote: '"' });
    expect(html).not.toMatch(/<b[ >]|<i>|<x>/);
    expect(html).toContain('a=1&amp;b=2');
  });
});

describe('basketReceiptMessage (#4617)', () => {
  it('names each seller with what was bought from them, then the total, and escapes names', () => {
    const m = basketReceiptMessage([
      { sellerName: 'Shop A', lines: [{ name: 'Lamp', quantity: 1, totalCents: 1000 }] },
      { sellerName: 'Shop <B>', lines: [{ name: 'Rug', quantity: 2, totalCents: 2500 }] },
    ], 3500);
    expect(m.subject).toBe('Your higglehaven order');
    expect(m.text).toContain('From Shop A: Lamp × 1 ($10.00).');
    expect(m.text).toContain('From Shop <B>: Rug × 2 ($25.00).');
    expect(m.text).toContain('Total paid: $35.00.');
    expect(m.text).toContain('2 products from 2 sellers');
    expect(m.html).toContain('Shop &lt;B&gt;');
    expect(m.html).not.toContain('Shop <B>');
  });
});
