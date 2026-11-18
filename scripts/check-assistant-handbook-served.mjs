// #3800: what the build serves as /assistant-handbook.md must be exactly
// docs/assistant-handbook.md. Runs the real Vite plugin against the real file.
import { readFileSync } from 'node:fs';
import { assistantHandbookPlugin, HANDBOOK_SERVED_AS, HANDBOOK_SOURCE_PATH } from './vite-assistant-handbook.mjs';

const emitted = [];
assistantHandbookPlugin().generateBundle.call({ emitFile: (file) => emitted.push(file) });
const [file] = emitted;
if (emitted.length !== 1 || file.fileName !== HANDBOOK_SERVED_AS || file.source !== readFileSync(HANDBOOK_SOURCE_PATH, 'utf8') || !file.source.length) {
  console.error('the build does not serve docs/assistant-handbook.md as /assistant-handbook.md (scripts/vite-assistant-handbook.mjs)');
  process.exit(1);
}
console.log('check-assistant-handbook-served: /assistant-handbook.md equals docs/assistant-handbook.md');
