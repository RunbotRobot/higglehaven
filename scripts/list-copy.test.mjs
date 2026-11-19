import { describe, expect, it } from 'vitest';
import { areaOf, looksLikeCopy, htmlCopy, jsCopy, copyOf } from './list-copy-lib.mjs';

// #3888: only the pure parts are tested; scripts/list-copy.mjs reads the real repo files.
describe('areaOf', () => {
  it('sorts a file into the area a reader would look for it in', () => {
    expect(areaOf('index.html')).toBe('Shell (index.html)');
    expect(areaOf('src/shop/mode.js')).toBe('Shop');
    expect(areaOf('src/sell/ordersLeaf.js')).toBe('Sell');
    expect(areaOf('src/shop/assistantChat.js')).toBe('Assistant');
    expect(areaOf('src/shop/nearbyChat.js')).toBe('People and chat');
    expect(areaOf('worker/lib/purchase-lifecycle.js')).toBe('Server messages');
    expect(areaOf('public/admin-control-room.html')).toBe('Admin pages');
  });
});

describe('looksLikeCopy', () => {
  it('keeps words a person reads', () => {
    for (const s of ['Nothing new.', 'Add a product', 'Rename', 'No orders yet. When someone buys one, it shows here.']) {
      expect(looksLikeCopy(s)).toBe(true);
    }
  });
  it('drops ids, selectors, paths, numbers and SQL', () => {
    for (const s of ['seller-status', '#bud-leaf-orders', '/api/purchases', 'https://x.test', '12px', '1,000', 'SELECT * FROM landlets WHERE id = ?']) {
      expect(looksLikeCopy(s)).toBe(false);
    }
  });
});

describe('htmlCopy', () => {
  it('lists text between tags and readable attributes with their line, and skips scripts and comments', () => {
    const html = [
      '<!-- Not a sentence for a person. -->',
      '<button id="a" aria-label="Close this window">&times;</button>',
      '<p>No friends yet. Tap + Add friend.</p>',
      '<script>',
      '  const s = "Not shown here";',
      '</script>',
      '<input placeholder="Say something nearby…" />',
    ].join('\n');
    const rows = htmlCopy('index.html', html);
    expect(rows.map((r) => [r.line, r.kind, r.text])).toEqual([
      [2, 'aria-label', 'Close this window'],
      [3, 'text', 'No friends yet. Tap + Add friend.'],
      [7, 'placeholder', 'Say something nearby…'],
    ]);
  });
});

describe('jsCopy', () => {
  it('lists strings that set or raise something a person reads', () => {
    const js = [
      "import { x } from './Not words here.js';",
      "// textContent = 'A comment is not shown';",
      "el.textContent = 'Could not load your orders.';",
      "const cls = 'orders-list';",
      "throw new Error('Could not rename.');",
      "openLeaf({ id: 'orders', title: 'Orders' });",
    ].join('\n');
    expect(jsCopy('src/sell/ordersLeaf.js', js).map((r) => [r.line, r.text])).toEqual([
      [3, 'Could not load your orders.'],
      [5, 'Could not rename.'],
      [6, 'Orders'],
    ]);
  });
  it('tags every row with its area', () => {
    const rows = copyOf('src/sell/ordersLeaf.js', "el.textContent = 'No orders yet.';");
    expect(rows).toEqual([{ file: 'src/sell/ordersLeaf.js', line: 1, kind: 'js', text: 'No orders yet.', area: 'Sell' }]);
  });
});
