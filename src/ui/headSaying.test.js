// #3889: something true of the whole app is a word beside the head that opens to its sentence.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bud = vi.hoisted(() => ({
  setBudWord: vi.fn(),
  clearBudWord: vi.fn(),
  openLeaf: vi.fn(),
  closeLeaf: vi.fn(),
  currentLeafId: vi.fn(() => null),
}));
vi.mock('./bud.js', () => bud);

import { sayAtHead, clearSaying } from './headSaying.js';

beforeEach(() => {
  Object.values(bud).forEach((fn) => fn.mockClear());
  bud.currentLeafId.mockReturnValue(null);
});

describe('sayAtHead (#3889)', () => {
  it('sets the head word with a door and a spoken label, and opens nothing by itself', () => {
    sayAtHead('connection', { word: 'Offline', title: 'No connection', message: 'Sentence.' });
    expect(bud.setBudWord).toHaveBeenCalledTimes(1);
    const [key, word, options] = bud.setBudWord.mock.calls[0];
    expect([key, word]).toEqual(['connection', 'Offline']);
    expect(typeof options.open).toBe('function');
    expect(options.label).toBe('No connection. Open for details.');
    expect(bud.openLeaf).not.toHaveBeenCalled();
  });

  it('opens one leaf named for the key, titled with the title', () => {
    sayAtHead('graphics', { word: 'Graphics paused', title: 'Graphics were interrupted', message: 'x' });
    bud.setBudWord.mock.calls[0][2].open();
    expect(bud.openLeaf).toHaveBeenCalledTimes(1);
    const leaf = bud.openLeaf.mock.calls[0][0];
    expect(leaf.id).toBe('saying-graphics');
    expect(leaf.title).toBe('Graphics were interrupted');
  });
});

describe('readOnce (#3889)', () => {
  it('clears the word when its leaf is closed, and keeps it otherwise', () => {
    sayAtHead('orb-limit', { word: 'Orb limit', title: 'Orb limit reached', message: 'x', readOnce: true });
    bud.setBudWord.mock.calls[0][2].open();
    const leaf = bud.openLeaf.mock.calls[0][0];
    expect(bud.clearBudWord).not.toHaveBeenCalled();
    leaf.onClose();
    expect(bud.clearBudWord).toHaveBeenCalledWith('orb-limit');

    bud.openLeaf.mockClear();
    sayAtHead('connection', { word: 'Offline', title: 'No connection', message: 'x' });
    bud.setBudWord.mock.calls[1][2].open();
    expect(bud.openLeaf.mock.calls[0][0].onClose).toBeNull();
  });
});

describe('clearSaying (#3889)', () => {
  it('clears the word, and closes the leaf only if it is the one showing this saying', () => {
    bud.currentLeafId.mockReturnValue('saying-connection');
    clearSaying('connection');
    expect(bud.clearBudWord).toHaveBeenCalledWith('connection');
    expect(bud.closeLeaf).toHaveBeenCalledTimes(1);
  });

  it('leaves a different leaf alone', () => {
    bud.currentLeafId.mockReturnValue('help');
    clearSaying('connection');
    expect(bud.clearBudWord).toHaveBeenCalledWith('connection');
    expect(bud.closeLeaf).not.toHaveBeenCalled();
  });
});
