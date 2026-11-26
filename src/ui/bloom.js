// #4440: "clicking the bud opens petals, while the bud stays closed. We need opening the menu to open the bud as well
// so that the opened menu shows a normal bloomed flower." The owner has to see the look before it replaces the bud,
// so it stands behind a switch in the address, with variants to try (as the height gestures were, #4105):
//
//   ?bloom=petals   the three mode petals are joined by drawn ones all the way round, one large flower
//   ?bloom=ring     a ring of small petals close around the head, the three mode petals standing out of it
//   ?bloom=sepals   short cream petals behind the head, cupped by two green sepals
//
// With no switch (or any other value) nothing here exists and the flower is exactly as before. The pick removes the
// others ("One model, not a hybrid"). The drawn petals are plain elements beside the mode petals (#bud-modes) with the
// same shape, shadow and growing and folding as theirs, so the head and its petals are one plant in every frame; the
// head itself eases down to the flower's centre while the menu is open (src/app.css, "#4440"). The logo stays on the
// centre in every variant; the owner allowed it to give way, and none needed to.
export const BLOOM_VARIANTS = {
  // angle in degrees (the mode petals sit at 6, 36 and 66), length as a share of a mode petal, tone
  petals: [96, 126, 156, 186, 216, 246, 276, 306, 336].map((a) => ({ a, len: 0.8, tone: 'pale' })),
  ring: Array.from({ length: 12 }, (_, k) => ({ a: 6 + 30 * k, len: 0.4, tone: k % 2 ? 'green' : 'pale' })),
  sepals: [
    { a: 126, len: 0.62, tone: 'cream' }, { a: 171, len: 0.66, tone: 'cream' }, { a: 216, len: 0.66, tone: 'cream' },
    { a: 261, len: 0.66, tone: 'cream' }, { a: 306, len: 0.62, tone: 'cream' },
    { a: 148, len: 0.8, tone: 'sepal' }, { a: 284, len: 0.8, tone: 'sepal' },
  ],
};

export function bloomVariantFromSearch(search) {
  const value = new URLSearchParams(search).get('bloom');
  return value && Object.hasOwn(BLOOM_VARIANTS, value) ? value : null;
}

export function mountBloom(doc = document, search = typeof location === 'undefined' ? '' : location.search) {
  const variant = bloomVariantFromSearch(search);
  const modes = doc.getElementById('bud-modes');
  if (!variant || !modes || doc.getElementById('bud-bloom')) return null;
  doc.body.dataset.bloom = variant;
  const host = doc.createElement('div');
  host.id = 'bud-bloom';
  host.setAttribute('aria-hidden', 'true');
  BLOOM_VARIANTS[variant].forEach((petal, index) => {
    const el = doc.createElement('span');
    el.className = `bloom-petal bloom-${petal.tone}`;
    el.style.setProperty('--ring-a', String(petal.a));
    el.style.setProperty('--petal-len', String(petal.len));
    el.style.animationDelay = `${(index % 4) * 0.02}s`;
    host.appendChild(el);
  });
  modes.before(host); // beneath the mode petals, which stay the ones that can be tapped
  return host;
}

if (typeof document !== 'undefined') mountBloom();
