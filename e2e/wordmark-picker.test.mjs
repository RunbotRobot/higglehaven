// #3783 (part of #3771): the picker where a builder chooses the lettering and colours of their lándlet's name.
// shared/wordmark-set.js offers only `default` until the owner picks, so the page hook opens it as if every
// candidate were offered, with a save the test controls. Checks, in a real browser:
//   - the name is drawn in every offered lettering, so the choice is made by looking;
//   - a tap shows at once (before the save answers) and a save that works is kept;
//   - a refused save puts the previous choice back and says why, in text that stays and can be selected;
//   - "Back to the default look" and the close button at the upper right.
import { launchPage, chooseIdentity, finish } from './helpers.mjs';

const LABEL = 'Wordmark Picker';
let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };

const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });
await chooseIdentity(page, { mode: 'shop', label: LABEL, isNew: true });
await page.waitForSelector('body[data-bud="on"]', { timeout: 30000 });

await page.evaluate(() => {
  window.__saves = [];
  window.__release = null;
  window.__refuse = null;
  window.__done = null;
  window.__testOpenWordmarkPicker({
    name: 'Maple lándlet', styleId: 'default', colourId: 'default',
    save: (choice) => new Promise((resolve, reject) => {
      window.__saves.push(choice);
      window.__release = () => (window.__refuse ? reject(new Error(window.__refuse)) : resolve());
    }),
  }).then((result) => { window.__done = result; });
});
await page.waitForSelector('#wordmark-modal.visible');

const counts = await page.evaluate(() => ({
  styles: document.querySelectorAll('#wordmark-styles .wordmark-option').length,
  colours: document.querySelectorAll('#wordmark-colours .wordmark-option').length,
  sample: document.querySelector('#wordmark-styles .wordmark-option[data-id="script"] .bud-place-name')?.textContent,
  sampleStyle: document.querySelector('#wordmark-styles .wordmark-option[data-id="script"] .bud-place-name')?.dataset.wordmark,
}));
check(counts.styles === 8 && counts.colours === 7, `every lettering and colour is offered (${JSON.stringify(counts)})`);
check(counts.sample === 'Maple lándlet' && counts.sampleStyle === 'script', `each lettering shows the name itself (${JSON.stringify(counts)})`);

// A tap shows at once, before the save answers.
await page.click('#wordmark-styles .wordmark-option[data-id="script"]');
let view = await page.evaluate(() => ({ preview: document.querySelector('#wordmark-preview .bud-place-name').dataset.wordmark, saves: window.__saves.length }));
check(view.preview === 'script' && view.saves === 1, `a tap shows at once and asks the server (${JSON.stringify(view)})`);
await page.evaluate(() => window.__release());
await page.waitForFunction(() => document.querySelector('#wordmark-styles .wordmark-option[data-id="script"]').getAttribute('aria-checked') === 'true');

// A refused save puts the previous choice back and says why.
await page.evaluate(() => { window.__refuse = 'That colour is not on offer here.'; });
await page.click('#wordmark-colours .wordmark-option[data-id="berry"]');
await page.evaluate(() => window.__release());
await page.waitForFunction(() => document.getElementById('wordmark-status').classList.contains('error'));
view = await page.evaluate(() => ({
  colour: document.querySelector('#wordmark-preview .bud-place-name').dataset.wordmarkColour ?? null,
  style: document.querySelector('#wordmark-preview .bud-place-name').dataset.wordmark,
  text: document.getElementById('wordmark-status').textContent,
  select: getComputedStyle(document.getElementById('wordmark-status')).userSelect,
}));
check(view.colour === null && view.style === 'script', `a refusal restores the previous choice (${JSON.stringify(view)})`);
check(view.text === 'That colour is not on offer here.' && view.select !== 'none', `the reason stays and is selectable (${JSON.stringify(view)})`);

// Back to the default look.
await page.evaluate(() => { window.__refuse = null; });
await page.click('#wordmark-default-btn');
await page.evaluate(() => window.__release());
await page.waitForFunction(() => !document.querySelector('#wordmark-preview .bud-place-name').dataset.wordmark);
check(await page.evaluate(() => window.__saves.at(-1).styleId === 'default' && window.__saves.at(-1).colourId === 'default'), 'the default button saves the default look');

// Close, at the upper right, resolves with the last saved choice.
const box = await page.evaluate(() => { const r = document.getElementById('wordmark-modal-close-btn').getBoundingClientRect(); const m = document.getElementById('wordmark-modal-content').getBoundingClientRect(); return { right: m.right - r.right, top: r.top - m.top }; });
check(box.right < 40 && box.top < 40, `the close button is in the upper-right corner (${JSON.stringify(box)})`);
await page.click('#wordmark-modal-close-btn');
await page.waitForFunction(() => window.__done !== null);
check(await page.evaluate(() => window.__done.styleId === 'default'), 'closing returns the last saved choice');

await finish(browser, { pass, label: 'Wordmark picker: a tap shows at once, a refusal restores and says why', errors });
