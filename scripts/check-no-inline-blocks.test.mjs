import { describe, expect, it } from 'vitest';
import { findInlineBlocks, listHtmlFiles } from './check-no-inline-blocks.mjs';

// #1360: only the pure parts are tested here (same split as
// check-worker-imports.test.mjs); main() reads the real repo files and is
// exercised by `pretest` itself.
describe('findInlineBlocks (#1360)', () => {
  it('passes a page that only references files', () => {
    const html = '<head><link rel="stylesheet" href="/a.css" /><script src="/a.js"></script></head><body><script type="module" src="/src/main.js"></script></body>';
    expect(findInlineBlocks(html)).toEqual([]);
  });

  it('flags an inline classic script and an inline module script, with line numbers', () => {
    const html = '<html>\n<script>\n  run();\n</script>\n<script type="module">\n  go();\n</script>\n</html>';
    expect(findInlineBlocks(html)).toEqual([
      { kind: 'script', line: 2 },
      { kind: 'script', line: 5 },
    ]);
  });

  it('flags any <style> element', () => {
    expect(findInlineBlocks('<head>\n<style>\n body { margin: 0 }\n</style>\n</head>')).toEqual([{ kind: 'style', line: 2 }]);
    expect(findInlineBlocks('<style media="print">a{}</style>')).toEqual([{ kind: 'style', line: 1 }]);
  });

  it('does not flag data blocks, which are never executed', () => {
    expect(findInlineBlocks('<script type="application/json" id="d">{"a":1}</script>')).toEqual([]);
    expect(findInlineBlocks('<script type="application/ld+json">{}</script>')).toEqual([]);
  });

  it('treats src in any quoting as an external script', () => {
    expect(findInlineBlocks("<script src='/a.js'></script><script defer src=/b.js></script>")).toEqual([]);
  });

  it('is case-insensitive about tag and attribute names', () => {
    expect(findInlineBlocks('<SCRIPT>x()</SCRIPT>')).toEqual([{ kind: 'script', line: 1 }]);
    expect(findInlineBlocks('<SCRIPT SRC="/a.js"></SCRIPT>')).toEqual([]);
  });

  it('ignores style="" attributes, which style-src-attr allows', () => {
    expect(findInlineBlocks('<div style="margin:0"></div>')).toEqual([]);
  });
});

describe('listHtmlFiles (#1360)', () => {
  it('lists index.html and every public/*.html', () => {
    const readdir = () => [
      { name: 'admin-a.html', isDirectory: () => false },
      { name: 'admin-a.js', isDirectory: () => false },
      { name: 'models', isDirectory: () => true },
    ];
    expect(listHtmlFiles('/r', readdir)).toEqual(['/r/index.html', '/r/public/admin-a.html']);
  });
});
