import { describe, expect, it } from 'vitest';
import {
  assistantArrivalLevels, assistantDepartureLevels, createAssistantTransition,
  ASSISTANT_ARRIVE_TOTAL_S, ASSISTANT_DEPART_TOTAL_S,
} from './assistantFog.js';

describe('assistantFog levels (#3449)', () => {
  it('arrival: starts as fog over nothing, ends as the whole assistant with no fog', () => {
    const start = assistantArrivalLevels(0);
    expect(start).toMatchObject({ fog: 0, item: 0, done: false });
    const mid = assistantArrivalLevels(0.6);
    expect(mid.fog).toBeGreaterThan(0);
    expect(mid.item).toBeGreaterThan(0);
    expect(mid.item).toBeLessThan(1);
    const end = assistantArrivalLevels(ASSISTANT_ARRIVE_TOTAL_S + 0.1);
    expect(end).toMatchObject({ fog: 0, item: 1, done: true });
  });

  it('departure: starts whole with no fog, thickens as it dissolves, ends gone with no fog', () => {
    expect(assistantDepartureLevels(0)).toMatchObject({ fog: 0, item: 1, done: false });
    const mid = assistantDepartureLevels(0.5);
    expect(mid.fog).toBeGreaterThan(0.5);
    expect(mid.item).toBeGreaterThan(0);
    expect(mid.item).toBeLessThan(1);
    const end = assistantDepartureLevels(ASSISTANT_DEPART_TOTAL_S);
    expect(end).toMatchObject({ fog: 0, item: 0, done: true });
  });

  it('departure never brings the assistant back up, and fog never exceeds 1', () => {
    let previousItem = 1;
    for (let age = 0; age <= 2; age += 0.05) {
      const s = assistantDepartureLevels(age);
      expect(s.item).toBeLessThanOrEqual(previousItem + 1e-9);
      expect(s.fog).toBeGreaterThanOrEqual(0);
      expect(s.fog).toBeLessThanOrEqual(1);
      previousItem = s.item;
    }
  });

  it('reduced motion: no fog at all, a short plain fade each way', () => {
    for (let age = 0; age <= 1; age += 0.05) {
      expect(assistantArrivalLevels(age, { reducedMotion: true }).fog).toBe(0);
      expect(assistantDepartureLevels(age, { reducedMotion: true }).fog).toBe(0);
    }
    expect(assistantDepartureLevels(0.3, { reducedMotion: true })).toMatchObject({ item: 0, done: true });
    expect(assistantArrivalLevels(0.3, { reducedMotion: true })).toMatchObject({ item: 1, done: true });
  });

  it('is robust to bad ages', () => {
    expect(assistantDepartureLevels(NaN).item).toBe(1);
    expect(assistantDepartureLevels(-3).item).toBe(1);
  });
});

// A fake scene graph and effects, to check the controller releases what it made.
function harness() {
  const log = { fogsCreated: 0, fogsDisposed: 0, dissolvesCreated: 0, dissolvesRestored: 0, fogLevels: [], itemLevels: [] };
  const added = [];
  const parent = { add: (o) => added.push(o) };
  const effects = {
    createFog: () => {
      log.fogsCreated += 1;
      return {
        object: { position: { set() {} } },
        setLevel: (l) => log.fogLevels.push(l),
        dispose: () => { log.fogsDisposed += 1; },
      };
    },
    createDissolve: () => {
      log.dissolvesCreated += 1;
      return { setLevel: (l) => log.itemLevels.push(l), restore: () => { log.dissolvesRestored += 1; } };
    },
  };
  const entry = { group: { position: { x: 1, y: 2, z: 0 } }, assistantTag: { visible: true } };
  return { log, parent, effects, entry, added };
}

describe('createAssistantTransition (#3449)', () => {
  it('runs an arrival to the end and releases the fog and the dissolve exactly once', () => {
    const h = harness();
    const t = createAssistantTransition({ entry: h.entry, parent: h.parent, effects: h.effects, levels: (a) => assistantArrivalLevels(a), startedAtMs: 1000 });
    expect(h.log.fogsCreated).toBe(1);
    expect(h.entry.assistantTag.visible).toBe(false); // nothing of it shows at the first frame
    expect(t.step(1500)).toBe(false);
    expect(t.step(1000 + (ASSISTANT_ARRIVE_TOTAL_S + 0.2) * 1000)).toBe(true);
    expect(t.step(9999)).toBe(true);
    expect(h.log).toMatchObject({ fogsDisposed: 1, dissolvesRestored: 1 });
    expect(h.entry.assistantTag.visible).toBe(true);
  });

  it('a departure ends with the avatar hidden and everything released', () => {
    const h = harness();
    const t = createAssistantTransition({ entry: h.entry, parent: h.parent, effects: h.effects, levels: (a) => assistantDepartureLevels(a), startedAtMs: 0 });
    expect(t.step(600)).toBe(false);
    expect(t.step(ASSISTANT_DEPART_TOTAL_S * 1000 + 50)).toBe(true);
    expect(h.log).toMatchObject({ fogsDisposed: 1, dissolvesRestored: 1 });
    expect(h.entry.assistantTag.visible).toBe(false);
  });

  it('cancel releases at once and leaves the assistant fully visible', () => {
    const h = harness();
    const t = createAssistantTransition({ entry: h.entry, parent: h.parent, effects: h.effects, levels: (a) => assistantDepartureLevels(a), startedAtMs: 0 });
    t.step(400);
    t.cancel();
    t.cancel();
    expect(h.log).toMatchObject({ fogsDisposed: 1, dissolvesRestored: 1 });
    expect(h.entry.assistantTag.visible).toBe(true);
    expect(t.released).toBe(true);
    expect(t.step(500)).toBe(true); // a released transition does nothing further
  });
});
