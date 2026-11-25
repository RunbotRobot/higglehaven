// #3782 (part of #3771): the one renderer that draws a lándlet's name in the lettering and colours its
// builder chose, wherever the lándlet is named (the open menu first, #3770, then every other place, #3784).
//
//   renderWordmark(element, { name, styleId, colourId })
//
// - The name is real text (textContent), so it stays selectable ("Any text a user can read, they can
//   copy"); the renderer only sets a data attribute and two CSS variables on the element. The layout
//   around the name (src/ui/budPlace.js and its CSS) is not touched.
// - Which styles and colour pairs a builder may choose is not decided here but in shared/wordmark-set.js,
//   the one list the Worker also checks. An id that list does not offer (or does not know) draws the
//   default look. Today that list holds only `default`, so nothing changes on screen until the owner picks
//   from the lettering page (#3780); the pick is then one line in that list, because every candidate's
//   face and colours are already defined below.
// - A face is fetched only when a lándlet that uses it is being drawn, with the FontFace API, which loads
//   off the frame ("Moving, looking and drawing never wait on loading"). The name shows at once in a
//   fallback face sized to match (src/app.css, the "WM ... fallback" faces), then swaps with no change in
//   how much room it takes.
//
// Imports only the shared list, so it also runs in the unit-test pool.
import { DEFAULT_WORDMARK_ID, WORDMARK_STYLE_IDS, WORDMARK_COLOR_IDS } from '../../shared/wordmark-set.js';

// The candidates from the lettering page (public/design-directions/wordmark.html, #3780): self-hosted
// Latin subsets (with the accented a) under the SIL OFL, licences in wordmark-fonts/LICENSES.txt.
// `family` is the CSS name the face is registered under; the matching "<family> fallback" face lives in
// src/app.css.
const FACE_DIR = '/design-directions/wordmark-fonts/';
export const WORDMARK_FACES = {
  round: { family: 'WM Round', file: 'fredoka-latin-600-normal.woff2', weight: '600' },
  airy: { family: 'WM Airy', file: 'quicksand-latin-700-normal.woff2', weight: '700' },
  serif: { family: 'WM Serif', file: 'fraunces-latin-700-normal.woff2', weight: '700' },
  slab: { family: 'WM Slab', file: 'zilla-slab-latin-600-normal.woff2', weight: '600' },
  script: { family: 'WM Script', file: 'pacifico-latin-400-normal.woff2', weight: '400' },
  stencil: { family: 'WM Stencil', file: 'stardos-stencil-latin-700-normal.woff2', weight: '700' },
  hand: { family: 'WM Hand-drawn', file: 'patrick-hand-latin-400-normal.woff2', weight: '400' },
};

// The colour pairs from the same page: the name's ink, and the accent under it.
export const WORDMARK_COLOUR_PAIRS = {
  meadow: { ink: '#2f6a14', accent: '#6ca42e' },
  ink: { ink: '#16240a', accent: '#6ca42e' },
  berry: { ink: '#8a2450', accent: '#e2694f' },
  sky: { ink: '#17608f', accent: '#4a9bd1' },
  clay: { ink: '#7d4310', accent: '#e0a030' },
  bark: { ink: '#4a3520', accent: '#f6d65c' },
};

// What a stored choice draws: the id itself when the shared list offers it and the renderer knows it,
// the default otherwise. `offered` is the shared list by default; a test passes its own.
export function resolveWordmark({ styleId, colourId } = {}, offered = {}) {
  const styles = offered.styles ?? WORDMARK_STYLE_IDS;
  const colours = offered.colours ?? WORDMARK_COLOR_IDS;
  return {
    styleId: styles.includes(styleId) && WORDMARK_FACES[styleId] ? styleId : DEFAULT_WORDMARK_ID,
    colourId: colours.includes(colourId) && WORDMARK_COLOUR_PAIRS[colourId] ? colourId : DEFAULT_WORDMARK_ID,
  };
}

// One load per face for the page's life while it works. #4316: a failed load used to be remembered as failed for
// the rest of the visit, so one network blip left a lándlet's name in the plain font until reload. A failed face
// is asked for again by the next name that wants it once FACE_RETRY_AFTER_MS has passed, at most FACE_MAX_TRIES
// times in all; until then the plain fallback stays (a name drawn meanwhile swaps by itself when a later load
// adds the face, as any FontFace added to document.fonts does).
const FACE_RETRY_AFTER_MS = 45000;
const FACE_MAX_TRIES = 3;
const loads = new Map();
const failures = new Map(); // styleId -> { tries, at }
// e2e only: how many faces were asked for and how long each took (the issue asks the renderer to report
// its cost while a face loads). Read through window.__wordmarkStats.
const stats = { requested: 0, loaded: 0, failed: 0, loadMs: [] };

export function loadWordmarkFace(
  styleId,
  fontFaceApi = typeof FontFace === 'undefined' ? null : { FontFace, fonts: document.fonts },
  now = () => Date.now(),
) {
  const face = WORDMARK_FACES[styleId];
  if (!face || !fontFaceApi) return Promise.resolve(false);
  if (loads.has(styleId)) {
    const failure = failures.get(styleId);
    // Still loading or loaded, or failed too recently / too often to ask again: the answer already given stands.
    if (!failure || failure.tries >= FACE_MAX_TRIES || now() - failure.at < FACE_RETRY_AFTER_MS) return loads.get(styleId);
  }
  stats.requested += 1;
  const started = typeof performance === 'undefined' ? 0 : performance.now();
  const promise = (async () => {
    try {
      const font = new fontFaceApi.FontFace(face.family, `url(${FACE_DIR}${face.file}) format("woff2")`, { weight: face.weight, display: 'swap' });
      await font.load();
      fontFaceApi.fonts.add(font);
      failures.delete(styleId);
      stats.loaded += 1;
      stats.loadMs.push(Math.round((typeof performance === 'undefined' ? 0 : performance.now()) - started));
      return true;
    } catch {
      stats.failed += 1;
      failures.set(styleId, { tries: (failures.get(styleId)?.tries ?? 0) + 1, at: now() });
      return false;
    }
  })();
  loads.set(styleId, promise);
  return promise;
}

export function renderWordmark(element, { name, styleId, colourId } = {}, offered = undefined) {
  if (!element) return;
  const choice = resolveWordmark({ styleId, colourId }, offered);
  element.textContent = name ?? '';
  if (choice.styleId === DEFAULT_WORDMARK_ID) element.removeAttribute('data-wordmark');
  else element.dataset.wordmark = choice.styleId;
  if (choice.colourId === DEFAULT_WORDMARK_ID) {
    element.removeAttribute('data-wordmark-colour');
    element.style.removeProperty('--wm-ink');
    element.style.removeProperty('--wm-accent');
  } else {
    const pair = WORDMARK_COLOUR_PAIRS[choice.colourId];
    element.dataset.wordmarkColour = choice.colourId;
    element.style.setProperty('--wm-ink', pair.ink);
    element.style.setProperty('--wm-accent', pair.accent);
  }
  if (choice.styleId !== DEFAULT_WORDMARK_ID) {
    // The name is on screen now in the fallback; the face arrives later and the CSS swaps to it by itself
    // (a FontFace added to document.fonts takes over the same family name).
    element.dataset.wordmarkLoading = 'true';
    loadWordmarkFace(choice.styleId).then((ok) => {
      if (element.dataset.wordmark === choice.styleId) element.removeAttribute('data-wordmark-loading');
      return ok;
    });
  } else {
    element.removeAttribute('data-wordmark-loading');
  }
}

// e2e only: draws any candidate, as if the owner had offered all of them (shared/wordmark-set.js holds only
// `default` until the pick). Inert unless a test calls it.
if (typeof window !== 'undefined') {
  window.__testRenderWordmark = (element, spec) => renderWordmark(element, spec, {
    styles: [DEFAULT_WORDMARK_ID, ...Object.keys(WORDMARK_FACES)],
    colours: [DEFAULT_WORDMARK_ID, ...Object.keys(WORDMARK_COLOUR_PAIRS)],
  });
}
if (typeof window !== 'undefined') window.__wordmarkStats = () => ({ ...stats, loadMs: [...stats.loadMs] });
