// #3615 (part of #3614): the assistant handbook (docs/assistant-handbook.md) names
// controls by the words on them. This opens the real app at phone size, in each
// mode the handbook lists controls for, and fails when a listed control is gone or
// no longer carries those words. An interface change that renames or removes a
// button has to update the handbook in the same pull request, which is what this
// enforces; the handbook's top section says how.
//
// The format and the matching rule are scripts/assistant-handbook-lib.mjs's; the
// file is read here and checked first, so a malformed handbook fails with a plain
// sentence before any browser work.
import { readFileSync } from 'node:fs';
import { launchPage, chooseIdentity, claimLandlet, finish } from './helpers.mjs';
import { parseHandbook, validateHandbook, controlMatches } from '../scripts/assistant-handbook-lib.mjs';

const entries = parseHandbook(readFileSync(new URL('../docs/assistant-handbook.md', import.meta.url), 'utf8'));
const formatProblems = validateHandbook(entries);
if (formatProblems.length > 0) {
  console.log('handbook format problems:\n' + formatProblems.join('\n'));
  const { browser } = await launchPage();
  await finish(browser, { pass: false, label: '#3615: the handbook is in its format', errors: [] });
}

// Every listed control with where it was listed.
const controls = entries.flatMap((entry) => entry.controls.map((control) => ({ ...control, entry: entry.title })));
const modes = ['build', 'shop', 'sell'].filter((mode) => controls.some((control) => control.mode === mode));
// "any" controls are checked in the first mode visited (they are on every page).
const firstMode = modes[0] || 'build';

const LABEL = 'Handbook Controls';
const { browser, page, errors } = await launchPage({ promptAnswer: LABEL, viewport: { width: 390, height: 844 } });

async function read(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { exists: false };
    return {
      exists: true,
      text: el.innerText || el.textContent || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      placeholder: el.getAttribute('placeholder') || '',
      title: el.getAttribute('title') || '',
      value: el.tagName === 'INPUT' && ['button', 'submit'].includes(el.type) ? el.value : '',
    };
  }, selector);
}

const failures = [];
let checked = 0;
async function checkMode(mode) {
  const here = controls.filter((control) => control.mode === mode || (mode === firstMode && control.mode === 'any'));
  for (const control of here) {
    const reading = await read(control.selector);
    checked += 1;
    if (!controlMatches(reading, control.words)) {
      failures.push(`${control.entry}: "${control.selector}" ${reading.exists ? `no longer says "${control.words}" (it says "${(reading.text || reading.ariaLabel || reading.placeholder).trim().replace(/\s+/g, ' ').slice(0, 60)}")` : 'is not on the page'}`);
    }
  }
}

// Build first: signing up in Build mode is the way in, and the lándlet claim is
// what puts the Build controls on screen.
await chooseIdentity(page, { mode: 'build', label: LABEL, isNew: true });
await claimLandlet(page);
await page.waitForTimeout(1500);
if (modes.includes('build') || firstMode === 'build') await checkMode('build');
for (const mode of modes.filter((m) => m !== 'build')) {
  await page.click(`.mode-nav-btn[data-mode="${mode}"]`);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await checkMode(mode);
}

console.log(`checked ${checked} listed controls across ${entries.length} entries (${modes.join(', ')}); ${failures.length} problem(s)`);
for (const failure of failures) console.log(`PROBLEM: ${failure}`);
const pass = failures.length === 0 && checked > 0 && errors.length === 0;
await finish(browser, {
  pass,
  label: '#3615: every control the assistant handbook names is on the page and carries those words',
  errors,
});
