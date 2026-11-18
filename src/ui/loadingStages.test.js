import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOADING_STAGES, completeLoadingBar, failLoadingStage, loadingFailed,
  markLoadingStage, resetLoadingStagesForTest, startLoadingTips, stopLoadingTips,
} from './loadingStages.js';
import { LOADING_TIPS, tipReadingMs } from './loadingTips.js';
import { TIPS_NEXT_KEY, TIPS_OFF_KEY } from './loadingTipPrefs.js';

// A page with the opening screen's elements, enough for the module to drive.
function fakePage() {
  const els = {};
  const make = (id) => {
    const classes = new Set();
    els[id] = {
      id, textContent: '', hidden: false, style: { vars: {}, setProperty(name, value) { this.vars[name] = value; } },
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      removeAttribute(name) { this.removed = name; }, offsetWidth: 0,
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    };
  };
  ['loading-screen', 'loading-stage', 'loading-tip', 'loading-problem', 'loading-problem-text'].forEach(make);
  return { doc: { getElementById: (id) => els[id] || null }, els };
}

describe('the opening screen\'s stages', () => {
  beforeEach(() => resetLoadingStagesForTest());

  it('moves the bar only when a stage is reached, and only forward', () => {
    const { doc, els } = fakePage();
    const progress = () => Number(els['loading-screen'].style.vars['--loading-progress']);
    markLoadingStage('scripts', doc);
    expect(progress()).toBe(0.35);
    markLoadingStage('world', doc);
    expect(progress()).toBe(0.85);
    markLoadingStage('signedin', doc); // reported late: the bar does not go back
    expect(progress()).toBe(0.85);
    markLoadingStage('nonsense', doc);
    expect(progress()).toBe(0.85);
    markLoadingStage('frame', doc);
    expect(progress()).toBe(1);
  });

  it('names what it is waiting on after the furthest stage reached', () => {
    const { doc, els } = fakePage();
    markLoadingStage('scripts', doc);
    expect(els['loading-stage'].textContent).toBe('Signing you in');
    markLoadingStage('signedin', doc);
    expect(els['loading-stage'].textContent).toBe('Loading the world');
    markLoadingStage('world', doc);
    expect(els['loading-stage'].textContent).toBe('Almost there');
  });

  it('fills the bar when the screen is about to lift for any reason', () => {
    const { doc, els } = fakePage();
    completeLoadingBar(doc);
    expect(els['loading-screen'].style.vars['--loading-progress']).toBe('1');
  });

  it('says what failed in a sentence, shows Try again, and stops moving', () => {
    const { doc, els } = fakePage();
    failLoadingStage('The world did not load. Check your connection, then tap Try again.', doc);
    expect(loadingFailed()).toBe(true);
    expect(els['loading-screen'].classList.contains('loading-screen-failed')).toBe(true);
    expect(els['loading-problem'].hidden).toBe(false);
    expect(els['loading-problem-text'].textContent).toContain('did not load');
    markLoadingStage('frame', doc); // a failed screen does not carry on as if it were fine
    expect(els['loading-screen'].style.vars['--loading-progress']).toBeUndefined();
  });

  // A page's storage and clock, so the tip's timing can be driven by hand.
  function fakeWin() {
    const timers = [];
    let selection = '';
    return {
      timers, setSelection(value) { selection = value; },
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => { timers.length = 0; },
      getSelection: () => selection,
    };
  }
  function fakeStorage(initial = {}) {
    const data = { ...initial };
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
  }

  it('shows one tip, holds it for its reading time, and only then changes it', () => {
    const { doc, els } = fakePage();
    const win = fakeWin();
    startLoadingTips(doc, win, fakeStorage());
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[0].text); // the first open ever: moving
    expect(win.timers).toHaveLength(1);
    expect(win.timers[0].ms).toBe(tipReadingMs(LOADING_TIPS[0].text));
    expect(win.timers[0].ms).toBeGreaterThanOrEqual(6000);
    win.timers[0].fn(); // the load is still going after the reading time
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[1].text);
    stopLoadingTips(win);
    expect(win.timers).toHaveLength(0); // the world arrived: nothing is left running
  });

  it('shows the next tip when the tip is tapped, but not when text is being selected', () => {
    const { doc, els } = fakePage();
    const win = fakeWin();
    startLoadingTips(doc, win, fakeStorage());
    win.setSelection('Push the pad');
    els['loading-tip'].listeners.click();
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[0].text);
    win.setSelection('');
    els['loading-tip'].listeners.click();
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[1].text);
    expect(win.timers).toHaveLength(1); // the clock restarts for the new tip
    stopLoadingTips(win);
    els['loading-tip'].listeners.click(); // the screen is lifting: a late tap does nothing
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[1].text);
  });

  it('takes turns across opens, and starts with the tip about moving on the first', () => {
    const storage = fakeStorage();
    const seen = [];
    for (let open = 0; open < LOADING_TIPS.length + 1; open += 1) {
      resetLoadingStagesForTest();
      const { doc, els } = fakePage();
      startLoadingTips(doc, fakeWin(), storage);
      seen.push(els['loading-tip'].textContent);
    }
    expect(seen[0]).toBe(LOADING_TIPS[0].text);
    expect(seen[1]).toBe(LOADING_TIPS[1].text);
    expect(new Set(seen.slice(0, LOADING_TIPS.length)).size).toBe(LOADING_TIPS.length);
    expect(seen[LOADING_TIPS.length]).toBe(LOADING_TIPS[0].text);
    expect(storage.data[TIPS_NEXT_KEY]).toBe('1');
  });

  it('shows no tip at all when the Settings switch is off, and still runs the bar', () => {
    const { doc, els } = fakePage();
    const win = fakeWin();
    startLoadingTips(doc, win, fakeStorage({ [TIPS_OFF_KEY]: '1' }));
    expect(els['loading-tip'].hidden).toBe(true);
    expect(els['loading-tip'].textContent).toBe('');
    expect(win.timers).toHaveLength(0);
    markLoadingStage('scripts', doc);
    expect(els['loading-stage'].textContent).toBe('Signing you in');
  });

  it('still shows tips when storage cannot be read', () => {
    const { doc, els } = fakePage();
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    startLoadingTips(doc, fakeWin(), broken);
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[0].text);
  });

  it('knows every stage index.html and the loader report', () => {
    expect(LOADING_STAGES.map((stage) => stage.id)).toEqual(['painted', 'scripts', 'signedin', 'world', 'frame']);
  });
});
