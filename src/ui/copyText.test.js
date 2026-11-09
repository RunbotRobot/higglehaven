import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextWithFeedback } from './copyText.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('copyTextWithFeedback (#3303)', () => {
  it('writes the text, flips the label to Copied!, then restores it', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const button = { textContent: 'Copy' };
    expect(await copyTextWithFeedback(button, 'hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(button.textContent).toBe('Copied!');
    vi.advanceTimersByTime(1300);
    expect(button.textContent).toBe('Copy');
  });

  it("says Couldn't copy when the clipboard is unavailable, then restores the label", async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    const button = { textContent: 'Copy' };
    expect(await copyTextWithFeedback(button, 'hello')).toBe(false);
    expect(button.textContent).toBe("Couldn't copy");
    vi.advanceTimersByTime(1300);
    expect(button.textContent).toBe('Copy');
  });

  it('restores a custom label', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.resolve() } });
    const button = { textContent: 'Copy error' };
    await copyTextWithFeedback(button, 'x', { label: 'Copy error' });
    vi.advanceTimersByTime(1300);
    expect(button.textContent).toBe('Copy error');
  });
});
