// Measurements for e2e/bud-a11y.test.mjs (#3818): what the bud's menu and leaves expose to a person
// who cannot see them or cannot use touch.

const MENU_SURFACES = '#account-menu-panel, #bud-modes, [id^="bud-leaf-"], #account-menu-toggle, #bud-note, .bud-word';

export function setupBudWordHelpers(page) {
  // Every drawn piece of text in the menu or a leaf that is under 12px.
  const smallText = () => page.evaluate((surfaces) => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (!text) continue;
      const el = node.parentElement;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (!el.closest(surfaces)) continue;
      if (el.closest('[aria-hidden="true"]') && !el.closest('#compass-panel')) continue;
      const px = parseFloat(style.fontSize);
      if (px < 12) out.push(`${el.className || el.tagName}:${text.slice(0, 16)}:${px}px`);
    }
    return out;
  }, MENU_SURFACES);

  // Controls in the open menu or ring whose tap area is under 44px either way. The ring's petals are
  // turned shapes, so their layout box is measured, not their bounding box.
  const tapTargetsUnder44 = () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#account-menu-panel button, #bud-row button, #bud-modes button')) {
      if (el.hidden) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const ring = !!el.closest('#bud-modes');
      const w = ring ? el.offsetWidth : box.width;
      const h = ring ? el.offsetHeight : box.height;
      if (Math.min(w, h) < 44) out.push(`${el.id || el.dataset.mode}:${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });

  const headName = () => page.getAttribute('#account-menu-toggle', 'aria-label');
  return { smallText, tapTargetsUnder44, headName };
}
