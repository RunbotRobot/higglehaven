// #3800 (part of #3614): the assistant handbook (docs/assistant-handbook.md) is
// served by the live site itself, as /assistant-handbook.md, built from the
// repository file in the same deploy as the app. An assistant's shift program
// fetches it from there, so what she says matches the interface people see
// instead of the copy pinned in her environment's setup script.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HANDBOOK_SERVED_AS = 'assistant-handbook.md';
export const HANDBOOK_SOURCE_PATH = fileURLToPath(new URL('../docs/assistant-handbook.md', import.meta.url));

export function assistantHandbookPlugin(read = () => readFileSync(HANDBOOK_SOURCE_PATH, 'utf8')) {
  return {
    name: 'assistant-handbook',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: HANDBOOK_SERVED_AS, source: read() });
    },
  };
}
