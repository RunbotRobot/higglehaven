import { describe, expect, it } from 'vitest';
import { renderEmail, verifyEmailMessage, passwordResetMessage, soldOutMessage } from './lib/email-layout.js';

// #3877: every customer email shares one layout and says what happened first.
const URL_A = 'https://higglehaven.com/?verifyEmail=abc123';
const messages = {
  verify: verifyEmailMessage(URL_A),
  reset: passwordResetMessage('https://higglehaven.com/?resetPassword=def456'),
  soldOut: soldOutMessage('Oak "Table"', 2),
};

describe('customer emails', () => {
  it('carry the wordmark and the brand colours in the html, with no image to load', () => {
    for (const { html } of Object.values(messages)) {
      expect(html).toContain('higglehaven');
      expect(html).toContain('#faf0c7');
      expect(html).toContain('#d6e8be');
      expect(html).not.toMatch(/<img\b/i);
      expect(html).not.toMatch(/<link\b|<style\b|<script\b/i);
    }
  });

  it('read well as plain text alone: the first line says what happened, and it signs off', () => {
    expect(messages.verify.text.split('\n')[0]).toBe('Confirm your email to finish setting up your account.');
    expect(messages.reset.text.split('\n')[0]).toMatch(/^Someone asked to reset the password/);
    expect(messages.soldOut.text.split('\n')[0]).toBe('"Oak "Table"" just sold out.');
    for (const { text } of Object.values(messages)) expect(text.trimEnd().endsWith('higglehaven')).toBe(true);
  });

  it('never change the link: it is in the button, written out, and in the text, byte for byte', () => {
    expect(messages.verify.html.split(URL_A).length - 1).toBe(3); // href, the copy line's href, and its visible text
    expect(messages.verify.text).toContain(`Confirm my email: ${URL_A}`);
  });

  it('escape seller-supplied words in the html part', () => {
    expect(messages.soldOut.html).toContain('Oak &quot;Table&quot;');
    expect(renderEmail({ heading: '<b>x</b>' }).html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('keep to the words: lándlet with its accent, no land, plot or lot, no internals', () => {
    for (const { text } of Object.values(messages)) {
      expect(text).not.toMatch(/\b(land|lánd|plot|lot)\b/i);
      expect(text).not.toMatch(/#\d{2,}|docs\/|\.md\b|seller identity/i);
    }
    expect(messages.soldOut.text).toContain('lándlet');
    expect(soldOutMessage('Chair', 1).text).toContain('1 placed instance has been removed');
  });

  it('say how long a link works and what happens if it was not the person', () => {
    expect(messages.verify.text).toMatch(/24 hours/);
    expect(messages.reset.text).toMatch(/1 hour/);
    expect(messages.reset.text).toMatch(/password has not changed/);
  });
});
