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

// The Worker's refusals are read by people too (the client shows them as they are). Only the sentence a
// person can see is checked: the text of an HttpError(...) or an `error:` field, never a log line or a name.
const WORKER_SENTENCE = /(?:HttpError\(\s*\d+\s*,\s*|\berror:\s*)(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

export function findWorkerVoiceBreaks(files) {
  const breaks = [];
  for (const { file, source } of files) {
    for (const m of source.matchAll(WORKER_SENTENCE)) {
      const text = m[2].replace(/\$\{[^}]*\}/g, ' ');
      const line = source.slice(0, m.index).split('\n').length;
      if (/\blandlets?\b/i.test(text)) breaks.push({ file, line, text: m[2], word: 'landlet', why: 'say "lándlet", with the accent' });
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

export function main() {
  const breaks = [...findVoiceBreaks(collectCopy()), ...findWorkerVoiceBreaks(workerSources())];
  if (breaks.length === 0) {
    console.log('check-copy-voice: no banned words in what people read');
    return 0;
  }
  console.error(`check-copy-voice: ${breaks.length} string(s) use a word the voice note bans (docs/DESIGN.md, "Voice"):`);
  for (const b of breaks) console.error(`  ${b.file}:${b.line}  [${b.word}: ${b.why}]  ${b.text}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
