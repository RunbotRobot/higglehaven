// #4161: which Build button a key presses.
import { describe, expect, it } from 'vitest';
import { buildEditKeyAction } from './keyboardEdit.js';

const press = (extra) => ({ code: '', key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, ...extra });
const all = { hasSelection: true, canUndo: true, canRedo: true };

describe('buildEditKeyAction', () => {
  it('Delete and Backspace delete the selection, and only when something is selected', () => {
    expect(buildEditKeyAction(press({ code: 'Delete' }), all)).toBe('delete');
    expect(buildEditKeyAction(press({ code: 'Backspace' }), all)).toBe('delete');
    expect(buildEditKeyAction(press({ code: 'Delete' }), { ...all, hasSelection: false })).toBeNull();
  });

  it('Ctrl or Cmd with Z undoes, with Shift (or Y) redoes, only when there is something to do', () => {
    expect(buildEditKeyAction(press({ key: 'z', ctrlKey: true }), all)).toBe('undo');
    expect(buildEditKeyAction(press({ key: 'z', metaKey: true }), all)).toBe('undo');
    expect(buildEditKeyAction(press({ key: 'Z', ctrlKey: true, shiftKey: true }), all)).toBe('redo');
    expect(buildEditKeyAction(press({ key: 'y', ctrlKey: true }), all)).toBe('redo');
    expect(buildEditKeyAction(press({ key: 'z', ctrlKey: true }), { ...all, canUndo: false })).toBeNull();
    expect(buildEditKeyAction(press({ key: 'y', ctrlKey: true }), { ...all, canRedo: false })).toBeNull();
  });

  it('a plain z, an Alt combination and other Ctrl keys do nothing', () => {
    expect(buildEditKeyAction(press({ key: 'z' }), all)).toBeNull();
    expect(buildEditKeyAction(press({ key: 'z', ctrlKey: true, altKey: true }), all)).toBeNull();
    expect(buildEditKeyAction(press({ key: 'c', ctrlKey: true }), all)).toBeNull();
  });

  it('a held key is one press', () => {
    expect(buildEditKeyAction(press({ code: 'Delete', repeat: true }), all)).toBeNull();
    expect(buildEditKeyAction(press({ key: 'z', ctrlKey: true, repeat: true }), all)).toBeNull();
  });

  it('nothing while someone is typing or answering a dialog', () => {
    expect(buildEditKeyAction(press({ code: 'Backspace', target: { tagName: 'INPUT' } }), all)).toBeNull();
    expect(buildEditKeyAction(press({ key: 'z', ctrlKey: true, target: { tagName: 'TEXTAREA' } }), all)).toBeNull();
    expect(buildEditKeyAction(press({ code: 'Delete', target: { tagName: 'DIV', closest: () => ({}) } }), all)).toBeNull();
  });
});
