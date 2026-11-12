import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFarView, FAR_FADE_MS } from './farView.js';
import { createFrameBudgetQueue } from '../world/frameBudgetQueue.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ loaded = new Set(), payloads, reducedMotion = true, createDissolve } = {}) {
  let clock = 0;
  const queue = createFrameBudgetQueue({ now: () => clock, schedule: () => {} });
  const root = new THREE.Group();
  const fetched = [];
  const disposed = [];
  const view = createFarView({
    queue, root,
    fetchTile: async (x, y) => { fetched.push(`${x},${y}`); return payloads[`${x},${y}`] ?? { templates: [], landlets: [] }; },
    loadSource: async (id) => ({
      container: new THREE.Group(),
      parts: [{ geometry: new THREE.BoxGeometry(1, 1, 1), material: new THREE.MeshBasicMaterial(), matrix: new THREE.Matrix4() }],
      dispose: () => disposed.push(id),
    }),
    dimensionsFor: () => ({ width: 2, depth: 2, height: 2 }),
    elevationFor: () => 0,
    loadedLandletIds: () => loaded,
    getCamera: () => ({ x: 0, y: 0, z: 50 }),
    getView: () => ({ fovDeg: 60, viewportHeightPx: 844 }),
    now: () => clock,
    rangeM: 600,
    reducedMotion,
    ...(createDissolve ? { createDissolve } : {}),
  });
  const advance = (ms) => { clock += ms; };
  const settle = async () => { for (let i = 0; i < 14; i += 1) { advance(1000); view.update(); await flush(); await flush(); } await queue.drain(); };
  return { view, queue, root, fetched, disposed, advance, settle };
}

const payload = { templates: ['tpl'], landlets: [
  { id: 'near', cx: 300, cy: 0, items: [[0, 0, 0, 1, 0, 0, 0, 1], [0, 5, 0, 1, 0, 0, 0, 1]] },
  { id: 'loaded', cx: 100, cy: 0, items: [[0, 0, 0, 1, 0, 0, 0, 1]] },
] };

describe('createFarView (#3478)', () => {
  it('reads each tile once, loads each product once, and draws one instanced mesh per part', async () => {
    const { view, root, fetched, settle } = setup({ loaded: new Set(['loaded']), payloads: { '0,0': payload } });
    await settle();
    expect(fetched.filter((k) => k === '0,0')).toHaveLength(1);
    const meshes = root.children.flatMap((child) => child.children);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].count).toBe(2); // the loaded landlet's item is left to the normal loader
    expect(view.stats().drawCalls).toBe(1);
  });

  it('does not draw before the product model is ready, and never draws a stand-in', async () => {
    const { view, root } = setup({ payloads: { '0,0': payload } });
    view.update();
    await flush();
    expect(root.children).toHaveLength(0);
  });

  it('starts nothing in the first seconds, so the page load is never kept busy by it (#3396)', async () => {
    const { view, fetched, advance } = setup({ payloads: { '0,0': payload } });
    view.update();
    advance(2000); view.update();
    await flush();
    expect(fetched).toEqual([]);
  });

  it('waits while the world queue has nearby work, then goes one tile at a time with a gap', async () => {
    const { view, queue, fetched, advance } = setup({ payloads: { '0,0': payload } });
    queue.enqueue(() => {}, { priority: -50 }); // a nearby build waiting
    for (let i = 0; i < 8; i += 1) { advance(1000); view.update(); await flush(); }
    expect(fetched).toEqual([]);
    await queue.drain();
    for (let i = 0; i < 6; i += 1) { advance(1000); view.update(); await flush(); }
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.length).toBeLessThanOrEqual(6); // at most one per second
  });

  it('queues its builds behind any nearby build', async () => {
    const { view, queue, root, settle } = setup({ loaded: new Set(['loaded']), payloads: { '0,0': payload } });
    await settle();
    expect(root.children).toHaveLength(1);
    const order = [];
    queue.enqueue(() => order.push('nearby'), { priority: -1 });
    queue.enqueue(() => order.push('far'), { priority: 1e6 - 1 });
    await queue.drain();
    expect(order).toEqual(['nearby', 'far']);
    expect(view.stats().products).toBe(1);
  });

  it('removes a product that leaves the plan and frees everything on dispose', async () => {
    const loaded = new Set();
    const { view, queue, root, advance, disposed, settle } = setup({ loaded, payloads: { '0,0': payload } });
    await settle();
    expect(root.children).toHaveLength(1);
    loaded.add('near'); loaded.add('loaded'); // the normal loader took over every landlet
    advance(1000); view.update(); await queue.drain();
    expect(root.children).toHaveLength(0);
    view.dispose();
    expect(disposed).toEqual(['tpl']);
  });

  // #3479: hand-over with the normal loader.
  const scaleOf = (mesh, index) => {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(index, m);
    return new THREE.Vector3().setFromMatrixScale(m).x;
  };

  it('hides a landlet\'s far instances in place the moment its real content has arrived, then rebuilds without it', async () => {
    const loaded = new Set();
    const { view, queue, root, advance, settle } = setup({ loaded, payloads: { '0,0': payload } });
    await settle();
    const mesh = root.children[0].children[0];
    expect(mesh.count).toBe(3);
    const hiddenIndexBefore = [0, 1, 2].filter((i) => scaleOf(mesh, i) === 0);
    expect(hiddenIndexBefore).toEqual([]);
    loaded.add('loaded'); // its arrival run has settled
    advance(1000); view.update(); // no await, no queue: same frame
    expect([0, 1, 2].filter((i) => scaleOf(mesh, i) === 0)).toHaveLength(1);
    expect(root.children[0].children[0]).toBe(mesh); // still the same mesh, nothing popped
    await queue.drain();
    expect(root.children[0].children[0].count).toBe(2); // rebuilt without it
  });

  it('draws a landlet\'s far models again, ahead of other far work, as soon as the real one unloads', async () => {
    const loaded = new Set(['loaded']);
    const { view, queue, root, advance, settle } = setup({ loaded, payloads: { '0,0': payload } });
    await settle();
    expect(root.children[0].children[0].count).toBe(2);
    loaded.delete('loaded'); // unloaded
    advance(10); view.update(); // well inside the usual replan gap
    const order = [];
    queue.enqueue(() => order.push('nearby'), { priority: -1 });
    queue.enqueue(() => order.push('far-late'), { priority: 1e6 - 1 });
    queue.enqueue(() => order.push('far-urgent'), { priority: -1e6 });
    await queue.drain();
    expect(root.children[0].children[0].count).toBe(3);
    expect(order[0]).toBe('far-urgent');
  });

  it('rebuilds when a landlet that was hidden in place unloads before the rebuild ran', async () => {
    const loaded = new Set();
    const { view, queue, root, advance, settle } = setup({ loaded, payloads: { '0,0': payload } });
    await settle();
    loaded.add('loaded');
    advance(1000); view.update();
    loaded.delete('loaded'); // unloads again before the queue ever rebuilt
    advance(1000); view.update();
    await queue.drain();
    const mesh = root.children[0].children[0];
    expect(mesh.count).toBe(3);
    expect([0, 1, 2].filter((i) => scaleOf(mesh, i) === 0)).toEqual([]);
  });

  // #3479: far models resolve in rather than pop.
  describe('dissolving in', () => {
    function recorder() {
      const made = [];
      const createDissolve = (object) => {
        const record = { object, levels: [], restored: false };
        made.push(record);
        return { setLevel: (l) => record.levels.push(l), restore: () => { record.restored = true; } };
      };
      return { made, createDissolve };
    }

    it('starts a product at nothing and brings it to full over FAR_FADE_MS, then gives back the real materials', async () => {
      const { made, createDissolve } = recorder();
      const { view, advance, settle } = setup({ loaded: new Set(['loaded']), payloads: { '0,0': payload }, reducedMotion: false, createDissolve });
      await settle();
      expect(made).toHaveLength(1);
      expect(made[0].levels).toEqual([0]);
      advance(FAR_FADE_MS / 2); view.tick();
      expect(made[0].levels.at(-1)).toBeCloseTo(0.5, 1);
      expect(made[0].restored).toBe(false);
      advance(FAR_FADE_MS); view.tick();
      expect(made[0].restored).toBe(true);
      const calls = made[0].levels.length;
      view.tick(); // nothing left to drive
      expect(made[0].levels).toHaveLength(calls);
    });

    it('keeps what a rebuild replaces drawn underneath until the new meshes are fully in, so there is never a gap', async () => {
      const loaded = new Set(['loaded']);
      const { made, createDissolve } = recorder();
      const { view, root, queue, advance, settle } = setup({ loaded, payloads: { '0,0': payload }, reducedMotion: false, createDissolve });
      await settle();
      advance(FAR_FADE_MS * 2); view.tick(); // the first build is done fading
      expect(root.children).toHaveLength(1);
      loaded.delete('loaded'); // its far models are wanted again: a rebuild
      advance(1000); view.update(); await queue.drain();
      expect(root.children).toHaveLength(2); // old and new both in the scene
      expect(made.at(-1).restored).toBe(false);
      advance(FAR_FADE_MS * 2); view.tick();
      expect(root.children).toHaveLength(1);
      await queue.drain();
      expect(made.at(-1).restored).toBe(true);
    });

    it('completes a fade that a newer build interrupts, and hides a landlet in the meshes still underneath', async () => {
      const loaded = new Set(['loaded']);
      const { made, createDissolve } = recorder();
      const { view, root, queue, advance, settle } = setup({ loaded, payloads: { '0,0': payload }, reducedMotion: false, createDissolve });
      await settle();
      advance(FAR_FADE_MS * 2); view.tick();
      loaded.delete('loaded');
      advance(1000); view.update(); await queue.drain(); // second build, fading, first underneath
      loaded.add('near'); // a landlet's real content arrives while that fade runs
      advance(10); view.update();
      const scales = root.children.flatMap((child) => child.children).map((mesh) => {
        const out = [];
        for (let i = 0; i < mesh.count; i += 1) out.push(scaleOf(mesh, i));
        return out.filter((v) => v === 0).length;
      });
      expect(scales.every((n) => n >= 1)).toBe(true); // hidden in the new meshes and in the ones underneath
      advance(1000); view.update(); await queue.drain(); // third build while the second was still fading
      expect(made.filter((m) => m.restored).length).toBeGreaterThanOrEqual(2);
      expect(root.children.length).toBeLessThanOrEqual(2);
    });

    it('with the real dissolve, the meshes carry a patched clone while fading and the shared material afterwards', async () => {
      const { view, root, advance, settle } = setup({ loaded: new Set(['loaded']), payloads: { '0,0': payload }, reducedMotion: false });
      await settle();
      const mesh = root.children[0].children[0];
      const during = mesh.material;
      expect(during.type).toBe('MeshBasicMaterial');
      advance(FAR_FADE_MS * 2); view.tick();
      expect(mesh.material).not.toBe(during); // the clone is gone, the product's own material is back
    });

    it('skips the dissolve entirely when the person prefers reduced motion', async () => {
      const { made, createDissolve } = recorder();
      const { settle } = setup({ loaded: new Set(['loaded']), payloads: { '0,0': payload }, reducedMotion: true, createDissolve });
      await settle();
      expect(made).toHaveLength(0);
    });

    it('releases the dissolve on dispose, mid-fade', async () => {
      const { made, createDissolve } = recorder();
      const { view, settle } = setup({ loaded: new Set(['loaded']), payloads: { '0,0': payload }, reducedMotion: false, createDissolve });
      await settle();
      expect(made[0].restored).toBe(false);
      view.dispose();
      expect(made[0].restored).toBe(true);
    });
  });
});
