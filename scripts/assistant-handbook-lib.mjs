// #3615 (part of #3614): reads docs/assistant-handbook.md and checks it. The
// handbook is the exact steps an assistant answers "how do I" questions from.
// This file knows nothing about the network or the filesystem: it takes the
// text and returns entries and problems, so a plain unit test can run it and
// e2e/assistant-handbook-controls.test.mjs can reuse the same parse to walk the
// real app. The format is described at the top of the handbook itself.

export const CONTROL_MODES = ['any', 'shop', 'build', 'sell'];
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
      else if (!normal(entry.text).includes(normal(control.words))) {
        problems.push(`${at}: the steps never name "${control.words}", which its controls list says they do`);
      }
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
export function controlMatches(reading, words) {
  if (!reading || !reading.exists) return false;
  const wanted = normal(words);
  return [reading.text, reading.ariaLabel, reading.placeholder, reading.title, reading.value]
    .some((candidate) => normal(candidate).includes(wanted));
}
