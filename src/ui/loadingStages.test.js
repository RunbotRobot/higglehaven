import { beforeEach, describe, expect, it } from 'vitest';
import {
  LOADING_STAGES, TIP_INTERVAL_MS, completeLoadingBar, failLoadingStage, loadingFailed,
  markLoadingStage, resetLoadingStagesForTest, startLoadingTips, stopLoadingTips,
} from './loadingStages.js';
import { LOADING_TIPS } from './loadingTips.js';

// A page with the opening screen's elements, enough for the module to drive.
function fakePage() {
  const els = {};
  const make = (id) => {
    const classes = new Set();
    els[id] = {
      id, textContent: '', hidden: false, style: { vars: {}, setProperty(name, value) { this.vars[name] = value; } },
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      removeAttribute(name) { this.removed = name; }, offsetWidth: 0,
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

  it('shows one tip at a time, changes it on a timer, and stops', () => {
    const { doc, els } = fakePage();
    const ticks = [];
    const win = { setInterval: (fn, ms) => { ticks.push({ fn, ms }); return 7; }, clearInterval: () => { ticks.length = 0; } };
    startLoadingTips(doc, win, 0);
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[0].text);
    expect(ticks[0].ms).toBe(TIP_INTERVAL_MS);
    ticks[0].fn();
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[1].text);
    for (let i = 0; i < LOADING_TIPS.length; i += 1) ticks[0].fn();
    expect(els['loading-tip'].textContent).toBe(LOADING_TIPS[1].text); // wraps all the way round
    stopLoadingTips(win);
    expect(ticks.length).toBe(0);
  });

  it('knows every stage index.html and the loader report', () => {
    expect(LOADING_STAGES.map((stage) => stage.id)).toEqual(['painted', 'scripts', 'signedin', 'world', 'frame']);
  });
});
