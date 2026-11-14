#!/usr/bin/env node
// #3458 (part of #3444): prints the two texts an assistant environment needs.
//
//   node scripts/assistant-environment.mjs setup --commit <40-char commit id>
//       the environment's setup script for that commit: it downloads the three
//       programs from the public repository at exactly that commit and checks
//       them against checksums computed here, from `git show`, so what the
//       session runs is what was reviewed. Paste it into the environment's
//       setup-script field; regenerate it (a new commit) whenever a program
//       changes.
//   node scripts/assistant-environment.mjs rules --name juniper
//       the settings object (permission mode `default` plus the exact
//       pre-approved commands) to start that assistant's session with.
//   node scripts/assistant-environment.mjs briefing --name juniper
//       the briefing that assistant's session is started with: the runbook
//       (docs/assistant-runbook.md) from "Who you are" onward, with that
//       assistant's exact commands filled in (#3523).
//
// Reads git objects and the runbook file only; never touches the network. docs/assistant-environment.md
// explains where each goes and what it does and does not protect.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PROGRAM_FILES, buildSetupScript, buildBriefing, permissionRules, DEFAULT_REPO } from './assistant-environment-lib.mjs';
import { parseArgs } from './assistant-lib.mjs';

const fail = (message) => {
  console.error(`assistant-environment: ${message}`);
  process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);
try {
  const { options } = parseArgs(rest, ['commit', 'name', 'repo']);
  if (command === 'setup') {
    if (!options.commit) fail('--commit is required (a full 40-character commit id)');
    const files = {};
    for (const name of PROGRAM_FILES) {
      const content = execFileSync('git', ['show', `${options.commit}:scripts/${name}`], { maxBuffer: 5 * 1024 * 1024 });
      files[name] = createHash('sha256').update(content).digest('hex');
    }
    process.stdout.write(buildSetupScript({ commit: options.commit, files, repo: options.repo || DEFAULT_REPO }));
  } else if (command === 'rules') {
    if (!options.name) fail('--name is required (for example --name juniper)');
    process.stdout.write(`${JSON.stringify(permissionRules(options.name), null, 2)}\n`);
  } else if (command === 'briefing') {
    if (!options.name) fail('--name is required (for example --name juniper)');
    const runbook = readFileSync(new URL('../docs/assistant-runbook.md', import.meta.url), 'utf8');
    process.stdout.write(`${buildBriefing({ runbook, name: options.name })}\n`);
  } else {
    fail('the first word must be setup, rules or briefing');
  }
} catch (error) {
  fail(error.stderr ? `${error.message.split('\n')[0]} (is the commit fetched locally?)` : error.message);
}
