#!/usr/bin/env node
// #3888 (One voice): the part of docs/DESIGN.md's "Voice" that a machine can check, run by `pretest`.
// What a person reads (the app and the pages it ships, not the Worker's developer-facing errors or the
// admin dashboards) never uses a word the voice note bans: the design's own vocabulary (bud, petal,
// leaf, stem, flower, modal) is for people who build the app, not for people who use it, and a plot
// of ground is a "lándlet" with the accent, never "landlet", "lánd" or "plot". See "The word is
// lándlet, always" and "Public-facing copy describes what the user sees, never internals" in AGENTS.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { collectCopy } from './list-copy-files.mjs';

// Word, pattern, and why. Each pattern is tested against the sentence with ${...} interpolations removed.
export const BANNED = [
  { word: 'landlet', pattern: /\blandlet(s)?\b/i, why: 'say "lándlet", with the accent' },
  { word: 'lánd', pattern: /\blánd(s)?\b/i, why: 'say "lándlet"; "lánd" is retired' },
  { word: 'bud / flower', pattern: /\b(bud|flower)\b/i, why: 'design vocabulary; say "the menu" or "the round logo"' },
  { word: 'petal / leaf / stem', pattern: /\b(petal|leaf|stem)s?\b/i, why: 'design vocabulary; name the thing by what it opens' },
  { word: 'please', pattern: /\bplease\b/i, why: 'the voice note drops "please"; say "Try again"' },
  { word: 'modal', pattern: /\bmodals?\b/i, why: 'internal word; say "window" or name the thing' },
];

// Rows read by people using the app: the shell and the client code. Not the Worker's own messages
// (checked by their own tests) and not the admin dashboards (read by the owner and admins).
const READ_BY_PEOPLE = new Set(['Shell (index.html)', 'Shop', 'Build', 'Sell', 'Account and Settings', 'People and chat', 'Assistant', 'Flower and shared pieces', 'Other']);

// A log line's own prefix ("bud: ...") is for the console, not a sentence anyone reads.
const isLogLine = (text) => /^[a-z][\w-]*: \$\{/.test(text);

export function findVoiceBreaks(rows) {
  const breaks = [];
  for (const row of rows) {
    if (!READ_BY_PEOPLE.has(row.area) || isLogLine(row.text)) continue;
    const text = row.text.replace(/\$\{[^}]*\}/g, ' ');
    for (const b of BANNED) {
      if (b.pattern.test(text)) breaks.push({ file: row.file, line: row.line, text: row.text, word: b.word, why: b.why });
    }
  }
  return breaks;
}

// "Capital letters" in docs/DESIGN.md's Voice: a short label is in sentence case, so only its first word and
// the proper things below start with a capital ("Add a product", not "Add A Product"). A label is a short
// string (up to six words) with no sentence stops; a longer string is a sentence and is not checked here.
// Words that may keep a capital in the middle of a label, and why:
export const CAPITAL_OK = new Set([
  'Shop', 'Build', 'Sell', // the three places (Voice: "Capital letters")
  'Stripe', 'Tripo', 'Didit', 'Apple', 'Google', // companies the person meets by name
  'AI', 'ID', 'PNG', 'GLB', 'SSN', 'USD', 'URL', 'FAQ', // acronyms
]);

// Exact labels that break the rule on purpose, each with a one-line reason. Keep this short.
export const ALLOWED_LABELS = new Map([
  ['e.g. Brick', 'an example of what to type in a field, where the example is a name'],
  ['WM Round', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
  ['WM Airy', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
  ['WM Serif', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
  ['WM Slab', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
  ['WM Script', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
  ['WM Stencil', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
  ['WM Hand-drawn', 'a CSS font-family name for a wordmark face (src/ui/wordmark.js), never shown to a person'],
]);

const LABEL_SPLIT = /[!?.…✓▾▴+·|\/()—–:;,]|\s-\s/;

export function findCaseBreaks(rows) {
  const breaks = [];
  for (const row of rows) {
    if (!READ_BY_PEOPLE.has(row.area) || isLogLine(row.text)) continue;
    const whole = row.text.replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (ALLOWED_LABELS.has(whole)) continue;
    const words = whole.split(' ').filter((w) => /[A-Za-z]/.test(w));
    if (words.length < 2 || words.length > 6 || /[.!?…]\s*$/.test(whole)) continue;
    for (const segment of whole.split(LABEL_SPLIT)) {
      const w = segment.trim().split(/\s+/).filter((x) => /[A-Za-z]/.test(x));
      const bad = w.slice(1).filter((x) => /^[A-Z][a-zà-ÿ]/.test(x) && !CAPITAL_OK.has(x.replace(/[^A-Za-z]/g, '')));
      if (bad.length) {
        breaks.push({ file: row.file, line: row.line, text: row.text, word: 'letter case', why: `sentence case, not Title Case: "${bad.join('", "')}"` });
        break;
      }
    }
  }
  return breaks;
}

// The Worker's refusals are read by people too (the client shows them as they are). Only the sentence a
// person can see is checked: every string piece of an HttpError(message, status, extra) call (the real argument
// order; #4278 found this check had been reading `HttpError(status, message)`, which never matches, so it saw
// no refusal at all) and the text of an `error:` field, never a log line or a name.
const ERROR_FIELD = /\berror:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

// The text pieces inside the balanced parentheses that open at `start` (the character after "HttpError(").
function callStrings(source, start) {
  const pieces = [];
  let depth = 1;
  for (let i = start; i < source.length && depth > 0; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') { text += source[j + 1] ?? ''; j += 2; continue; }
        text += source[j];
        j += 1;
      }
      pieces.push(text);
      i = j;
    }
  }
  return pieces;
}

// Words a person must not read in a refusal. "land candidate" is the admin tool's own term (the owner reads it).
const WORKER_BANNED = [
  { word: 'landlet', pattern: /\blandlets?\b/i, why: 'say "lándlet", with the accent' },
  { word: 'land', pattern: /\bland(?! candidate)\b/i, why: 'say "lándlet", never "land"' },
  { word: 'plot', pattern: /\bplots?\b/i, why: 'say "lándlet", never "plot"' },
];

export function findWorkerVoiceBreaks(files) {
  const breaks = [];
  for (const { file, source } of files) {
    const sentences = [];
    for (const m of source.matchAll(ERROR_FIELD)) sentences.push({ text: m[2], index: m.index });
    for (const m of source.matchAll(/HttpError\(/g)) {
      const text = callStrings(source, m.index + m[0].length).join(' ');
      if (text) sentences.push({ text, index: m.index });
    }
    for (const { text, index } of sentences) {
      const plain = text.replace(/\$\{[^}]*\}/g, ' ');
      const line = source.slice(0, index).split('\n').length;
      for (const b of WORKER_BANNED) if (b.pattern.test(plain)) breaks.push({ file, line, text, word: b.word, why: b.why });
    }
  }
  return breaks;
}

function workerSources(dir = 'worker') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...workerSources(path));
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push({ file: path, source: readFileSync(path, 'utf8') });
  }
  return out;
}

// A control that shows a word and is given a different accessible name breaks voice control and reads as two
// names for one thing (WCAG 2.5.3, "label in name"; #3888): the visible word must appear in the aria-label or
// title. Checked where both are plain strings in the source: markup (`<button aria-label="..">Word</button>`,
// in index.html or a template string) and `el.textContent = '..'` beside `el.setAttribute('aria-label', '..')`.
// A glyph-only control (x, minus, an arrow) has no word to match and is not checked.
const norm = (t) => t.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();
const hasWord = (t) => /[A-Za-z]{2}/.test(t.replace(/&[a-z#0-9]+;/gi, ' '));
const nameHolds = (visible, name) => ` ${norm(name)} `.includes(` ${norm(visible)} `);

export function findLabelNameBreaks(files) {
  const breaks = [];
  const add = (file, source, index, visible, name) => {
    if (!hasWord(visible) || nameHolds(visible, name)) return;
    breaks.push({ file, line: source.slice(0, index).split('\n').length, text: `${visible} / ${name}`, word: 'label in name', why: `the visible word "${visible.trim()}" is not in the accessible name "${name}"` });
  };
  for (const { file, source } of files) {
    for (const m of source.matchAll(/<(?:button|a)\b[^>]*?\b(?:aria-label|title)="([^"$]*)"[^>]*>([^<$]*)</g)) add(file, source, m.index, m[2].trim(), m[1]);
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      const t = line.match(/(\w+)\.textContent\s*=\s*(['"])([^'"$]*)\2/);
      if (!t) return;
      for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 4); j++) {
        const a = lines[j].match(new RegExp(`${t[1]}\\.setAttribute\\(\\s*['"](?:aria-label|title)['"]\\s*,\\s*(['"])([^'"$]*)\\1`));
        if (a) add(file, source, source.indexOf(line), t[3], a[2]);
      }
    });
  }
  return breaks;
}

function clientSources() {
  const out = [{ file: 'index.html', source: readFileSync('index.html', 'utf8') }];
  const walkSrc = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walkSrc(path);
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push({ file: path, source: readFileSync(path, 'utf8') });
    }
  };
  walkSrc('src');
  return out;
}

export function main() {
  const rows = collectCopy();
  const breaks = [...findVoiceBreaks(rows), ...findCaseBreaks(rows), ...findWorkerVoiceBreaks(workerSources()), ...findLabelNameBreaks(clientSources())];
  if (breaks.length === 0) {
    console.log('check-copy-voice: no banned words, no Title Case labels, and every visible word is in its accessible name');
    return 0;
  }
  console.error(`check-copy-voice: ${breaks.length} string(s) use a word the voice note bans (docs/DESIGN.md, "Voice"):`);
  for (const b of breaks) console.error(`  ${b.file}:${b.line}  [${b.word}: ${b.why}]  ${b.text}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
