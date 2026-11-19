// #3615 (part of #3614): reads docs/assistant-handbook.md and checks it. The
// handbook is the exact steps an assistant answers "how do I" questions from.
// This file knows nothing about the network or the filesystem: it takes the
// text and returns entries and problems, so a plain unit test can run it and
// e2e/assistant-handbook-controls.test.mjs can reuse the same parse to walk the
// real app. The format is described at the top of the handbook itself.

// 'sell-row' is Sell mode with one of the seller's own products opened in "My
// products": its buttons (Rename, Edit price, Delete) are built when a row is
// opened, so the test uploads a product and opens its row before looking for them.
export const CONTROL_MODES = ['any', 'shop', 'build', 'sell', 'sell-row'];
// A control with nothing written on it (a joystick, a picture): the steps name it
// by what it looks like, and the test only checks that it is on the page.
export const NO_WORDS = '(no words)';
export const SECTION_SEE = '**You will see:**';
export const SECTION_WRONG = '**If something goes wrong:**';

// Words a person must never read in an assistant's answer (docs/AGENTS "The word
// is lándlet, always"; "Public-facing copy describes what the user sees, never
// internals"): the unaccented words for a lándlet, and anything internal.
const BANNED = [
  { pattern: /\bland(?:let)?s?\b/i, why: 'say "lándlet" (with the accent), never "land" or "landlet"' },
  { pattern: /\blánd\b/i, why: 'say "lándlet", never "lánd"' },
  { pattern: /\b(?:plot|lot)s?\b/i, why: 'say "lándlet", never "plot" or "lot"' },
  { pattern: /#\d+/, why: 'no issue or pull request numbers' },
  { pattern: /\b(?:docs|src|worker|scripts|e2e)\//, why: 'no file paths' },
  { pattern: /\.(?:js|mjs|md|html|css|json)\b/, why: 'no file names' },
  { pattern: /\b(?:selector|endpoint|api|database|d1|stripe)\b/i, why: 'no internal vocabulary' },
];

// A label or title that ends on a small joining word ("Claim a") was cut short, usually at an accented
// letter (#3734: the claim sheet's title "Claim a lándlet" was written down as "Claim a"). No real label
// or title ends like that.
const DANGLING = /\b(?:a|an|the|of|to|for|and|or|your|my|with|this|that)$/i;
export function looksCutOff(words) {
  return DANGLING.test(String(words || '').trim());
}

// The controls fence: ```controls <mode> ... ```
const FENCE = /^```controls\s+(\S+)\s*$/;

export function parseHandbook(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  let chapter = null;
  let current = null;
  let fence = null; // { mode, lines: [] } while inside a controls block
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (line.trim() === '```') {
        current.controls.push(...fence.controls.map((control) => ({ ...control, mode: fence.mode })));
        current.controlBlocks += 1;
        fence = null;
      } else if (line.trim()) {
        const bar = line.indexOf('|');
        fence.controls.push(bar === -1
          ? { selector: line.trim(), words: '', line: index + 1 }
          : { selector: line.slice(0, bar).trim(), words: line.slice(bar + 1).trim(), line: index + 1 });
      }
      continue;
    }
    const heading2 = /^## (.+)$/.exec(line);
    const heading3 = /^### (.+)$/.exec(line);
    const opens = FENCE.exec(line);
    if (heading2) {
      chapter = heading2[1].trim();
      current = null;
    } else if (heading3 && chapter) {
      current = { chapter, title: heading3[1].trim(), line: index + 1, prose: [], controls: [], controlBlocks: 0 };
      entries.push(current);
    } else if (opens && current) {
      fence = { mode: opens[1], controls: [] };
    } else if (current) {
      current.prose.push(line);
    }
  }
  if (fence) throw new Error('a controls block is never closed');
  return entries.map((entry) => ({ ...entry, text: entry.prose.join('\n') }));
}

// What a person is asked to look at in each control: its words, case and
// spacing ignored.
const normal = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

// The problems with the handbook, as plain sentences naming the entry. An
// empty list means it is in the format.
export function validateHandbook(entries) {
  const problems = [];
  const titles = new Set();
  if (entries.length === 0) problems.push('the handbook has no entries');
  for (const entry of entries) {
    const at = `"${entry.title}"`;
    if (titles.has(entry.title)) problems.push(`${at}: two entries have this title`);
    titles.add(entry.title);
    if (!entry.title.endsWith('?')) problems.push(`${at}: the title must be the person's question and end with a question mark`);
    const steps = entry.prose.filter((line) => /^\d+\.\s+\S/.test(line));
    if (steps.length === 0) problems.push(`${at}: it has no numbered steps`);
    if (!entry.text.includes(SECTION_SEE)) problems.push(`${at}: it has no "${SECTION_SEE}" part`);
    if (!entry.text.includes(SECTION_WRONG)) problems.push(`${at}: it has no "${SECTION_WRONG}" part`);
    else if (entry.text.indexOf(SECTION_SEE) > entry.text.indexOf(SECTION_WRONG)) {
      problems.push(`${at}: "${SECTION_SEE}" must come before "${SECTION_WRONG}"`);
    }
    if (entry.controlBlocks === 0 || entry.controls.length === 0) problems.push(`${at}: it lists no controls`);
    for (const control of entry.controls) {
      if (!CONTROL_MODES.includes(control.mode)) problems.push(`${at}: line ${control.line}: the mode "${control.mode}" is not one of ${CONTROL_MODES.join(', ')}`);
      if (!control.selector) problems.push(`${at}: line ${control.line}: a control has no selector`);
      if (!control.words) problems.push(`${at}: line ${control.line}: "${control.selector}" has no words after the bar`);
      else if (control.words !== NO_WORDS && looksCutOff(control.words)) {
        problems.push(`${at}: line ${control.line}: "${control.words}" ends on a joining word, so it looks cut short (an accented letter dropped the rest?); write the whole label`);
      } else if (control.words !== NO_WORDS && !normal(entry.text).includes(normal(control.words))) {
        problems.push(`${at}: the steps never name "${control.words}", which its controls list says they do`);
      }
    }
    for (const quoted of entry.text.matchAll(/\btitled?\s+"([^"\n]+)"/gi)) {
      if (looksCutOff(quoted[1])) problems.push(`${at}: the quoted words "${quoted[1]}" end on a joining word, so they look cut short; write the whole label`);
    }
    for (const { pattern, why } of BANNED) {
      const found = pattern.exec(entry.text);
      if (found) problems.push(`${at}: "${found[0]}" — ${why}`);
    }
  }
  return problems;
}

// What the real app must show for one listed control: the element exists and
// something a person reads on it (its text, its label, its placeholder or its
// title) carries the words. Pure, so the unit test can try it without a browser;
// e2e/assistant-handbook-controls.test.mjs feeds it what it reads from the page.
// A title (a heading) must be written down whole: matching part of it let "Claim a" pass for "Claim a
// lándlet" (#3734). Pass `whole: true` for those; other controls are matched on part of what they say.
export function controlMatches(reading, words, { whole = false } = {}) {
  if (!reading || !reading.exists) return false;
  if (words === NO_WORDS) return true;
  const wanted = normal(words);
  if (whole) return [reading.text, reading.ariaLabel, reading.title].some((candidate) => normal(candidate) === wanted);
  return [reading.text, reading.ariaLabel, reading.placeholder, reading.title, reading.value]
    .some((candidate) => normal(candidate).includes(wanted));
}

// Selectors that name a heading, whose words are matched whole.
export const isHeadingSelector = (selector) => /(?:^|[\s>])h[1-6]\b[^\s>]*$/.test(String(selector || '').trim());
