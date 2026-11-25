// #3782: which lettering a stored choice draws, and that a face is fetched once and only when asked for.
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORDMARK_ID } from '../../shared/wordmark-set.js';
import { WORDMARK_FACES, WORDMARK_COLOUR_PAIRS, resolveWordmark, renderWordmark, loadWordmarkFace } from './wordmark.js';

const all = { styles: [DEFAULT_WORDMARK_ID, ...Object.keys(WORDMARK_FACES)], colours: [DEFAULT_WORDMARK_ID, ...Object.keys(WORDMARK_COLOUR_PAIRS)] };

function fakeElement() {
  const attrs = {};
  const style = {};
  return {
    textContent: '',
    dataset: new Proxy(attrs, { set(target, key, value) { target[key] = value; return true; } }),
    style: { setProperty: (k, v) => { style[k] = v; }, removeProperty: (k) => { delete style[k]; }, props: style },
    removeAttribute(name) { delete attrs[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())]; },
    attrs,
  };
}
const fakeApi = (log) => ({
  FontFace: class { constructor(family, source, descriptors) { this.family = family; log.push({ family, source, descriptors }); } async load() { return this; } },
  fonts: { add: (font) => log.push({ added: font.family }) },
});

describe('which lettering a stored choice draws (#3782)', () => {
  it('draws the default when the shared list offers nothing else, whatever is stored', () => {
    expect(resolveWordmark({ styleId: 'script', colourId: 'berry' })).toEqual({ styleId: DEFAULT_WORDMARK_ID, colourId: DEFAULT_WORDMARK_ID });
  });
  it('draws an id the list offers and the renderer knows', () => {
    expect(resolveWordmark({ styleId: 'script', colourId: 'berry' }, all)).toEqual({ styleId: 'script', colourId: 'berry' });
  });
  it('draws the default for an id it does not know, even if the list offered it', () => {
    expect(resolveWordmark({ styleId: 'comic-sans', colourId: 'neon' }, { styles: ['comic-sans'], colours: ['neon'] })).toEqual({ styleId: DEFAULT_WORDMARK_ID, colourId: DEFAULT_WORDMARK_ID });
  });
  it('knows a face file and weight for every candidate style, and ink and accent for every pair', () => {
    for (const face of Object.values(WORDMARK_FACES)) expect(face).toMatchObject({ family: expect.any(String), file: expect.stringMatching(/\.woff2$/), weight: expect.any(String) });
    for (const pair of Object.values(WORDMARK_COLOUR_PAIRS)) expect(pair).toMatchObject({ ink: expect.stringMatching(/^#[0-9a-f]{6}$/), accent: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  });
});

describe('renderWordmark (#3782)', () => {
  it('writes the name as text, sets the style and colour hooks, and marks the face as loading', () => {
    const el = fakeElement();
    renderWordmark(el, { name: "Pip's Corner", styleId: 'serif', colourId: 'sky' }, all);
    expect(el.textContent).toBe("Pip's Corner");
    expect(el.attrs.wordmark).toBe('serif');
    expect(el.attrs.wordmarkColour).toBe('sky');
    expect(el.style.props).toEqual({ '--wm-ink': WORDMARK_COLOUR_PAIRS.sky.ink, '--wm-accent': WORDMARK_COLOUR_PAIRS.sky.accent });
    expect(el.attrs.wordmarkLoading).toBe('true');
  });
  it('leaves the default look bare: no hooks, no variables, nothing loading', () => {
    const el = fakeElement();
    renderWordmark(el, { name: 'Maple lándlet', styleId: 'script', colourId: 'berry' }, all);
    renderWordmark(el, { name: 'Maple lándlet', styleId: DEFAULT_WORDMARK_ID, colourId: DEFAULT_WORDMARK_ID }, all);
    expect(el.attrs).toEqual({});
    expect(el.style.props).toEqual({});
  });
  it('does nothing to a missing element', () => {
    expect(() => renderWordmark(null, { name: 'x' })).not.toThrow();
  });
});

describe('loading a face (#3782)', () => {
  it('fetches a face once however many names ask, registers it under its own family, from its own file', async () => {
    const log = [];
    const api = fakeApi(log);
    const results = await Promise.all([loadWordmarkFace('hand', api), loadWordmarkFace('hand', api), loadWordmarkFace('hand', api)]);
    expect(results).toEqual([true, true, true]);
    expect(log.filter((e) => e.family)).toHaveLength(1);
    expect(log[0]).toMatchObject({ family: 'WM Hand-drawn', descriptors: { weight: '400' } });
    expect(log[0].source).toContain('patrick-hand-latin-400-normal.woff2');
    expect(log.filter((e) => e.added)).toEqual([{ added: 'WM Hand-drawn' }]);
  });
  it('answers false, and keeps the fallback, when a face cannot load', async () => {
    const api = { FontFace: class { async load() { throw new Error('404'); } }, fonts: { add() {} } };
    expect(await loadWordmarkFace('round', api)).toBe(false);
  });
  it('asks again for a face that failed once, after the wait, and stops after three tries in all (#4316)', async () => {
    let tries = 0;
    const api = { FontFace: class { async load() { tries += 1; throw new Error('blip'); } }, fonts: { add() {} } };
    let clock = 0;
    const now = () => clock;
    expect(await loadWordmarkFace('serif', api, now)).toBe(false);
    clock = 10000; // too soon
    expect(await loadWordmarkFace('serif', api, now)).toBe(false);
    expect(tries).toBe(1);
    clock = 50000;
    await loadWordmarkFace('serif', api, now);
    expect(tries).toBe(2);
    clock = 100000;
    await loadWordmarkFace('serif', api, now);
    expect(tries).toBe(3);
    clock = 200000; // used up
    await loadWordmarkFace('serif', api, now);
    expect(tries).toBe(3);
  });
  it('a face that loads on the second try is kept and not asked for again (#4316)', async () => {
    let attempts = 0;
    const added = [];
    const api = { FontFace: class { constructor(family) { this.family = family; } async load() { attempts += 1; if (attempts === 1) throw new Error('blip'); return this; } }, fonts: { add: (f) => added.push(f.family) } };
    let clock = 0;
    const now = () => clock;
    expect(await loadWordmarkFace('stencil', api, now)).toBe(false);
    clock = 60000;
    expect(await loadWordmarkFace('stencil', api, now)).toBe(true);
    clock = 200000;
    expect(await loadWordmarkFace('stencil', api, now)).toBe(true);
    expect(attempts).toBe(2);
    expect(added).toEqual(['WM Stencil']);
  });
  it('asks for no face for the default or an unknown id', async () => {
    const log = [];
    expect(await loadWordmarkFace(DEFAULT_WORDMARK_ID, fakeApi(log))).toBe(false);
    expect(await loadWordmarkFace('nope', fakeApi(log))).toBe(false);
    expect(log).toEqual([]);
  });
});
