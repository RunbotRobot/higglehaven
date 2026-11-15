import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeDocument() {
  const classes = new Set();
  const node = {
    id: '', textContent: '', isConnected: true,
    setAttribute() {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
  return { node, doc: { createElement: () => node, body: { appendChild() {} } } };
}

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('showFadingNote (#3552)', () => {
  it('shows the text, then fades it by itself', async () => {
    const { node, doc } = fakeDocument();
    vi.stubGlobal('document', doc);
    const { showFadingNote } = await import('./fadingNote.js');
    showFadingNote('Report sent. Thank you.');
    expect(node.textContent).toBe('Report sent. Thank you.');
    expect(node.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(3600);
    expect(node.classList.contains('visible')).toBe(false);
  });

  it('a second note restarts the timer instead of cutting itself short', async () => {
    const { node, doc } = fakeDocument();
    vi.stubGlobal('document', doc);
    const { showFadingNote } = await import('./fadingNote.js');
    showFadingNote('one');
    vi.advanceTimersByTime(3000);
    showFadingNote('two');
    vi.advanceTimersByTime(1000);
    expect(node.classList.contains('visible')).toBe(true);
    expect(node.textContent).toBe('two');
    vi.advanceTimersByTime(3000);
    expect(node.classList.contains('visible')).toBe(false);
  });
});
