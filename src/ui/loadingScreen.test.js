import { describe, expect, it } from 'vitest';
import { hideLoadingScreen } from './loadingScreen.js';

function fakeDocument() {
  const classes = new Set();
  const listeners = {};
  const el = {
    style: {},
    classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  return { doc: { getElementById: (id) => (id === 'loading-screen' ? el : null) }, el, classes, listeners };
}

describe('hideLoadingScreen', () => {
  it('fades the splash out and removes it once the fade ends', () => {
    const { doc, el, classes, listeners } = fakeDocument();
    hideLoadingScreen(doc);
    expect(classes.has('loading-screen-hidden')).toBe(true);
    expect(el.style.display).toBeUndefined();
    listeners.transitionend();
    expect(el.style.display).toBe('none');
  });

  it('does nothing a second time, or when there is no splash', () => {
    const { doc, listeners } = fakeDocument();
    hideLoadingScreen(doc);
    const first = listeners.transitionend;
    hideLoadingScreen(doc);
    expect(listeners.transitionend).toBe(first);
    expect(() => hideLoadingScreen({ getElementById: () => null })).not.toThrow();
    expect(() => hideLoadingScreen(null)).not.toThrow();
  });
});
