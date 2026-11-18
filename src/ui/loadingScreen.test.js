import { describe, expect, it } from 'vitest';
import { hideLoadingScreen } from './loadingScreen.js';
import { failLoadingStage, resetLoadingStagesForTest } from './loadingStages.js';

function fakeDocument() {
  const classes = new Set();
  const listeners = {};
  const el = {
    style: { setProperty: () => {} },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    removeAttribute: () => {},
    addEventListener: (type, fn) => { listeners[type] = fn; },
    removeEventListener: (type) => { delete listeners[type]; },
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

  it('lets the old top controls show only once the splash lifts (first-open class)', () => {
    const { doc } = fakeDocument();
    const rootClasses = new Set(['first-open']);
    doc.documentElement = { classList: { remove: (name) => rootClasses.delete(name) } };
    hideLoadingScreen(doc);
    expect(rootClasses.has('first-open')).toBe(false);
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

  it('keeps the splash while a transition of something inside it ends', () => {
    resetLoadingStagesForTest();
    const { doc, el, listeners } = fakeDocument();
    hideLoadingScreen(doc);
    listeners.transitionend({ target: {} });
    expect(el.style.display).toBeUndefined();
    listeners.transitionend({ target: el });
    expect(el.style.display).toBe('none');
  });

  it('leaves a splash that is showing a failed stage where it is', () => {
    resetLoadingStagesForTest();
    const { doc, classes } = fakeDocument();
    failLoadingStage('The world did not load.', doc);
    hideLoadingScreen(doc);
    expect(classes.has('loading-screen-hidden')).toBe(false);
    resetLoadingStagesForTest();
  });
});
