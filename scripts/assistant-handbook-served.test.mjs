import { describe, expect, it } from 'vitest';
import handbook from '../docs/assistant-handbook.md?raw';
import { assistantHandbookPlugin, HANDBOOK_SERVED_AS } from './vite-assistant-handbook.mjs';
import { refreshHandbook, HANDBOOK_FIRST_LINE } from './assistant-lib.mjs';

// #3800 (part of #3614): the handbook is served by the live site, equal to the
// repository's, and the shift program refreshes its installed copy from there.
describe('the served handbook', () => {
  // That the default reader returns the repository's file is checked against the
  // real filesystem by scripts/check-assistant-handbook-served.mjs (a pretest step).
  it('is emitted by the build as /assistant-handbook.md', () => {
    const emitted = [];
    assistantHandbookPlugin(() => handbook).generateBundle.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe(HANDBOOK_SERVED_AS);
    expect(emitted[0].source).toBe(handbook);
  });
});

function memoryFs(initial) {
  const files = new Map(initial ? [['/opt/assistant/assistant-handbook.md', initial]] : []);
  return {
    files,
    existsSync: () => true,
    readFileSync: (path) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path); },
    writeFileSync: (path, text) => { files.set(path, text); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  };
}
const answer = (body, { status = 200, type = 'text/markdown' } = {}) => async () => new Response(body, { status, headers: { 'content-type': type } });
const NEW = `${HANDBOOK_FIRST_LINE}\n\nnew steps`;
const OLD = `${HANDBOOK_FIRST_LINE}\n\nold steps`;
const run = (fs, fetchImpl) => refreshHandbook({ baseUrl: 'https://higglehaven.com', path: '/opt/assistant/assistant-handbook.md', fetchImpl, fs });

describe('refreshHandbook', () => {
  it('replaces the installed copy with the served one', async () => {
    const fs = memoryFs(OLD);
    expect(await run(fs, answer(NEW))).toBe('updated');
    expect(fs.files.get('/opt/assistant/assistant-handbook.md')).toBe(NEW);
    expect(fs.files.size).toBe(1);
  });
  it('leaves an identical copy alone', async () => {
    const fs = memoryFs(NEW);
    expect(await run(fs, answer(NEW))).toBe('unchanged');
  });
  it('keeps the pinned copy when the fetch fails, answers wrongly, or is not the handbook', async () => {
    for (const fetchImpl of [
      async () => { throw new Error('offline'); },
      answer('nope', { status: 500 }),
      answer('<html>sign in</html>', { type: 'text/html' }),
      answer('something else entirely'),
      answer(`${HANDBOOK_FIRST_LINE}\n${'x'.repeat(400000)}`),
    ]) {
      const fs = memoryFs(OLD);
      expect(await run(fs, fetchImpl)).toBe('kept');
      expect(fs.files.get('/opt/assistant/assistant-handbook.md')).toBe(OLD);
    }
  });
  it('does nothing where the install directory does not exist', async () => {
    const fs = { ...memoryFs(OLD), existsSync: () => false };
    expect(await run(fs, answer(NEW))).toBe('kept');
  });
});
