// #3738 (part of #3735, #3539): the opening screen (#loading-screen in
// index.html) tells the truth about how far along the app is. Its bar moves only
// when a real stage is reached, never on a timer; the words under it name the
// stage being waited on; a stage that fails says so in a sentence a person can
// select and offers Try again, instead of sitting there looking busy.
//
// This module is loaded by its own small script tag in index.html, ahead of
// src/main.js, so the tips and the bar work while the large bundle is still
// downloading; main.js and the shop's loader import the same module and report
// the stages. It touches the page only through the elements it finds by id, and
// takes the document as a parameter so a unit test can drive it.
import { LOADING_TIPS, tipReadingMs } from './loadingTips.js';
import { loadingTipsEnabled, nextTipIndex, rememberTipShown } from './loadingTipPrefs.js';

// What has been reached, the bar's share at that point, and what is being
// waited on next. "painted" is reached by the page itself: index.html's own CSS
// starts the bar there, so nothing has to run for the screen to look alive.
export const LOADING_STAGES = [
  { id: 'painted', progress: 0.12, waitingOn: 'Getting ready' },
  { id: 'scripts', progress: 0.35, waitingOn: 'Signing you in' },
  { id: 'signedin', progress: 0.55, waitingOn: 'Loading the world' },
  { id: 'world', progress: 0.85, waitingOn: 'Almost there' },
  { id: 'frame', progress: 1, waitingOn: 'Ready' },
];

const reached = new Set(['painted']);
let failed = false;
let tipTimer = null;
let tipsStarted = false;

export function loadingFailed() { return failed; }

function currentProgress() {
  let best = 0;
  for (const stage of LOADING_STAGES) if (reached.has(stage.id)) best = Math.max(best, stage.progress);
  return best;
}

function paint(doc) {
  const screen = doc && doc.getElementById('loading-screen');
  if (!screen) return;
  screen.style.setProperty('--loading-progress', String(currentProgress()));
  const label = doc.getElementById('loading-stage');
  if (!label) return;
  // The words name what is being waited on after the furthest stage reached.
  const last = [...LOADING_STAGES].reverse().find((stage) => reached.has(stage.id));
  label.textContent = last.waitingOn;
}

// Called by whatever just finished a stage. A stage reached out of order still
// counts (the bar only ever moves forward), and unknown ids are ignored.
export function markLoadingStage(id, doc = typeof document === 'undefined' ? null : document) {
  if (failed || !LOADING_STAGES.some((stage) => stage.id === id) || reached.has(id)) return;
  reached.add(id);
  paint(doc);
}

// The whole bar at once: used when the screen is about to lift for any reason
// (including a mode that never passes through the shop's own stages).
export function completeLoadingBar(doc = typeof document === 'undefined' ? null : document) {
  for (const stage of LOADING_STAGES) reached.add(stage.id);
  paint(doc);
}

export function failLoadingStage(sentence, doc = typeof document === 'undefined' ? null : document) {
  failed = true;
  stopLoadingTips();
  const screen = doc && doc.getElementById('loading-screen');
  if (!screen) return;
  screen.classList.add('loading-screen-failed');
  screen.classList.remove('loading-screen-hidden');
  screen.style.display = '';
  screen.removeAttribute('aria-hidden');
  const text = doc.getElementById('loading-problem-text');
  if (text) text.textContent = sentence;
  const problem = doc.getElementById('loading-problem');
  if (problem) problem.hidden = false;
}

// #3763: one tip per load, held for as long as it takes to read (tipReadingMs),
// and only replaced if the load is still going after that. A tap on the tip
// shows the next one at once, so a fast reader is not kept waiting and a slow
// one is never hurried. The world never waits for a tip: hideLoadingScreen stops
// them and the screen hands over as before. With the Settings switch off there
// is no tip at all (the bar and the words stay).
export function startLoadingTips(doc = typeof document === 'undefined' ? null : document, win = typeof window === 'undefined' ? null : window, storage) {
  const el = doc && doc.getElementById('loading-tip');
  if (!el || tipsStarted || !win) return;
  tipsStarted = true;
  if (!loadingTipsEnabled(storage)) { el.hidden = true; return; }
  el.hidden = false;
  let index = nextTipIndex(LOADING_TIPS.length, storage);
  const show = () => {
    const tip = LOADING_TIPS[index];
    el.textContent = tip.text;
    // Restart the soft fade-in each time the line changes.
    el.classList.remove('loading-tip-show');
    void el.offsetWidth;
    el.classList.add('loading-tip-show');
    rememberTipShown(index, LOADING_TIPS.length, storage);
    index = (index + 1) % LOADING_TIPS.length;
    if (tipTimer !== null) win.clearTimeout(tipTimer);
    tipTimer = win.setTimeout(show, tipReadingMs(tip.text));
  };
  show();
  el.addEventListener('click', () => {
    if (!tipsStarted || tipTimer === null) return; // stopped: the screen is lifting
    // Selecting a few words to copy is not a tap for the next tip.
    const selection = win.getSelection ? String(win.getSelection()) : '';
    if (selection) return;
    show();
  });
}

export function stopLoadingTips(win = typeof window === 'undefined' ? null : window) {
  if (tipTimer !== null && win) win.clearTimeout(tipTimer);
  tipTimer = null;
}

// Test-only: back to a page that has just opened.
export function resetLoadingStagesForTest() {
  reached.clear();
  reached.add('painted');
  failed = false;
  tipTimer = null;
  tipsStarted = false;
}
