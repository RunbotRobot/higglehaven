import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFarView } from './farView.js';
import { createFrameBudgetQueue } from '../world/frameBudgetQueue.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ loaded = new Set(), payloads } = {}) {
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
});
