// #4162: which item step a shifted key makes.
import { describe, expect, it } from 'vitest';
import { buildItemKeyAction, isItemKey, itemKeyAnnouncement, ITEM_TURN_DEGREES } from './keyboardItem.js';

const press = (code, extra) => ({ code, shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra });
const one = { singleSelected: true };

describe('buildItemKeyAction', () => {
  it('Shift with the arrows nudges, Shift with Page Up and Down lifts and lowers', () => {
    expect(buildItemKeyAction(press('ArrowLeft'), one)).toEqual({ type: 'nudge', direction: 'left' });
    expect(buildItemKeyAction(press('ArrowRight'), one)).toEqual({ type: 'nudge', direction: 'right' });
    expect(buildItemKeyAction(press('ArrowUp'), one)).toEqual({ type: 'nudge', direction: 'forward' });
    expect(buildItemKeyAction(press('ArrowDown'), one)).toEqual({ type: 'nudge', direction: 'back' });
    expect(buildItemKeyAction(press('PageUp'), one)).toEqual({ type: 'nudge', direction: 'up' });
    expect(buildItemKeyAction(press('PageDown'), one)).toEqual({ type: 'nudge', direction: 'down' });
  });

  it('Shift with Q turns it left and with E right, in whole steps', () => {
    expect(buildItemKeyAction(press('KeyQ'), one)).toEqual({ type: 'turn', degrees: ITEM_TURN_DEGREES });
    expect(buildItemKeyAction(press('KeyE'), one)).toEqual({ type: 'turn', degrees: -ITEM_TURN_DEGREES });
  });

  it('Shift with Z, X, C and V tips it about the red and green rings (#4118)', () => {
    expect(buildItemKeyAction(press('KeyZ'), one)).toEqual({ type: 'tilt', axis: 'x', degrees: ITEM_TURN_DEGREES });
    expect(buildItemKeyAction(press('KeyV'), one)).toEqual({ type: 'tilt', axis: 'y', degrees: -ITEM_TURN_DEGREES });
    expect(itemKeyAnnouncement({ type: 'tilt', axis: 'x', degrees: 5 }, 'm')).toBe('Tilted 5 degrees about the red ring.');
  });

  it('nothing without Shift (those keys are the camera\'s), or with Ctrl, Cmd or Alt', () => {
    expect(buildItemKeyAction(press('ArrowLeft', { shiftKey: false }), one)).toBeNull();
    expect(buildItemKeyAction(press('ArrowLeft', { ctrlKey: true }), one)).toBeNull();
    expect(buildItemKeyAction(press('ArrowLeft', { metaKey: true }), one)).toBeNull();
    expect(buildItemKeyAction(press('ArrowLeft', { altKey: true }), one)).toBeNull();
  });

  it('nothing unless exactly one item is selected', () => {
    expect(buildItemKeyAction(press('ArrowLeft'), { singleSelected: false })).toBeNull();
    expect(buildItemKeyAction(press('ArrowLeft'))).toBeNull();
  });

  it('nothing while someone is typing or answering a dialog, and other keys are not the item\'s', () => {
    expect(buildItemKeyAction(press('ArrowLeft', { target: { tagName: 'INPUT' } }), one)).toBeNull();
    expect(buildItemKeyAction(press('ArrowLeft', { target: { tagName: 'DIV', closest: () => ({}) } }), one)).toBeNull();
    expect(buildItemKeyAction(press('KeyW'), one)).toBeNull();
  });

  it('isItemKey says when the camera must leave a shifted key alone', () => {
    expect(isItemKey(press('ArrowLeft'), true)).toBe(true);
    expect(isItemKey(press('ArrowLeft'), false)).toBe(false);
    expect(isItemKey(press('KeyW'), true)).toBe(false);
  });
});

describe('itemKeyAnnouncement', () => {
  it('says what a press did, in the card\'s unit', () => {
    expect(itemKeyAnnouncement({ type: 'nudge', direction: 'left' }, 'm')).toBe('Moved 10 centimetres to the left.');
    expect(itemKeyAnnouncement({ type: 'nudge', direction: 'forward' }, 'ft')).toBe('Moved 3 inches forward.');
    expect(itemKeyAnnouncement({ type: 'nudge', direction: 'up' }, 'ft')).toBe('Lifted 3 inches.');
    expect(itemKeyAnnouncement({ type: 'nudge', direction: 'down' }, 'm')).toBe('Lowered 10 centimetres.');
    expect(itemKeyAnnouncement({ type: 'turn', degrees: ITEM_TURN_DEGREES }, 'm')).toBe('Turned 5 degrees left.');
    expect(itemKeyAnnouncement({ type: 'turn', degrees: -ITEM_TURN_DEGREES }, 'm')).toBe('Turned 5 degrees right.');
  });
});
