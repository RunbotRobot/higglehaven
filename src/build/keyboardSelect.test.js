import { describe, it, expect } from 'vitest';
import { selectionStops, stepIndex, announceStop, isStepKeyEvent, isDeselectKeyEvent } from './keyboardSelect.js';

const mesh = (instanceId, groupId = null, visible = true) => ({ visible, uuid: instanceId, userData: { instanceId, groupId } });

describe('selectionStops', () => {
  it('makes a bundle one stop and skips hidden items', () => {
    const stops = selectionStops([mesh('a'), mesh('b', 'g1'), mesh('c', 'g1'), mesh('d', null, false), mesh('e')]);
    expect(stops.map((s) => s.key)).toEqual(['a', 'g1', 'e']);
    expect(stops[1].mesh.userData.instanceId).toBe('b');
  });
});

describe('stepIndex', () => {
  const stops = selectionStops([mesh('a'), mesh('b'), mesh('c')]);
  it('starts at the first going forward and the last going back', () => {
    expect(stepIndex(stops, new Set(), false)).toBe(0);
    expect(stepIndex(stops, new Set(), true)).toBe(2);
  });
  it('steps on and wraps round both ways', () => {
    expect(stepIndex(stops, new Set(['a']), false)).toBe(1);
    expect(stepIndex(stops, new Set(['c']), false)).toBe(0);
    expect(stepIndex(stops, new Set(['a']), true)).toBe(2);
  });
  it('has nowhere to go with nothing placed', () => {
    expect(stepIndex([], new Set(), false)).toBe(-1);
  });
});

describe('announceStop', () => {
  it('says the name and the place in the walk, and when it is a bundle', () => {
    expect(announceStop('Rustic Storage Crate', 2, 12)).toBe('Rustic Storage Crate, 3 of 12');
    expect(announceStop('Reading Corner', 0, 3, { bundle: true })).toBe('Reading Corner, a bundle, 1 of 3');
  });
});

describe('keys', () => {
  const key = (props) => ({ code: '', key: '', repeat: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: { tagName: 'BODY' }, ...props });
  it('N steps, Shift+N too, but not held, modified or while typing', () => {
    expect(isStepKeyEvent(key({ code: 'KeyN' }))).toBe(true);
    expect(isStepKeyEvent(key({ code: 'KeyN', shiftKey: true }))).toBe(true);
    expect(isStepKeyEvent(key({ code: 'KeyN', repeat: true }))).toBe(false);
    expect(isStepKeyEvent(key({ code: 'KeyN', ctrlKey: true }))).toBe(false);
    expect(isStepKeyEvent(key({ code: 'KeyN', target: { tagName: 'INPUT' } }))).toBe(false);
    expect(isStepKeyEvent(key({ code: 'KeyN', target: { tagName: 'DIV', closest: () => ({}) } }))).toBe(false);
  });
  it('Escape deselects unless something already took it', () => {
    expect(isDeselectKeyEvent(key({ key: 'Escape' }))).toBe(true);
    expect(isDeselectKeyEvent(key({ key: 'Escape', defaultPrevented: true }))).toBe(false);
    expect(isDeselectKeyEvent(key({ key: 'Escape', target: { tagName: 'TEXTAREA' } }))).toBe(false);
  });
});
