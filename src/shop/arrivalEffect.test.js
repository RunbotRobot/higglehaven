// #3406: the arrival fog and the dither dissolve: lifecycle and nothing leaked.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  arrivalFogPuffCount, createArrivalFog, createArrivalDissolve, patchDissolveShader,
  ARRIVAL_FOG_PEAK_OPACITY,
} from './arrivalEffect.js';

const EXTENT = { width: 6, depth: 2, height: 4 };

function tracksDispose(resource) {
  const state = { disposed: false };
  resource.addEventListener('dispose', () => { state.disposed = true; });
  return state;
}

describe('arrivalFogPuffCount', () => {
  it('has a floor, grows with the footprint and has a ceiling', () => {
    expect(arrivalFogPuffCount({ width: 0.5, depth: 0.5 })).toBe(3);
    expect(arrivalFogPuffCount({ width: 12, depth: 12 })).toBeGreaterThan(arrivalFogPuffCount({ width: 4, depth: 4 }));
    expect(arrivalFogPuffCount({ width: 500, depth: 500 })).toBe(10);
  });
});

describe('createArrivalFog', () => {
  it('sits at the centre, starts invisible, and its opacity follows the level', () => {
    const fog = createArrivalFog({ center: { x: 4, y: 5, z: 1 }, extent: EXTENT, seed: 7 });
    expect(fog.object.position.toArray()).toEqual([4, 5, 1]);
    expect(fog.object.children.length).toBe(fog.puffCount);
    const material = fog.object.children[0].material;
    expect(material.opacity).toBe(0);
    fog.setLevel(1);
    expect(material.opacity).toBeCloseTo(ARRIVAL_FOG_PEAK_OPACITY);
    expect(fog.object.visible).toBe(true);
    fog.setLevel(0);
    expect(fog.object.visible).toBe(false);
    fog.setLevel(5); // clamped
    expect(material.opacity).toBeCloseTo(ARRIVAL_FOG_PEAK_OPACITY);
  });

  it('is the same fog every time for the same seed', () => {
    const a = createArrivalFog({ center: { x: 0, y: 0, z: 0 }, extent: EXTENT, seed: 3 });
    const b = createArrivalFog({ center: { x: 0, y: 0, z: 0 }, extent: EXTENT, seed: 3 });
    expect(a.object.children.map((s) => s.position.toArray())).toEqual(b.object.children.map((s) => s.position.toArray()));
  });

  it('never writes depth and is not itself fogged', () => {
    const fog = createArrivalFog({ center: { x: 0, y: 0, z: 0 }, extent: EXTENT });
    const material = fog.object.children[0].material;
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.fog).toBe(false);
  });

  it('dispose releases the material and texture, detaches from the scene, and is repeatable', () => {
    const scene = new THREE.Scene();
    const fog = createArrivalFog({ center: { x: 0, y: 0, z: 0 }, extent: EXTENT });
    scene.add(fog.object);
    const material = fog.object.children[0].material;
    const materialState = tracksDispose(material);
    const textureState = tracksDispose(material.map);
    fog.dispose();
    expect(materialState.disposed).toBe(true);
    expect(textureState.disposed).toBe(true);
    expect(scene.children.length).toBe(0);
    expect(fog.object.children.length).toBe(0);
    expect(() => { fog.dispose(); fog.setLevel(1); }).not.toThrow();
  });
});

describe('patchDissolveShader', () => {
  const SOURCE = '#include <common>\nvoid main() {\n#include <clipping_planes_fragment>\n  gl_FragColor = vec4(1.0);\n}';

  it('declares the uniform, discards by noise against it, and shares the one uniform object', () => {
    const uniform = { value: 0.3 };
    const shader = { uniforms: {}, fragmentShader: SOURCE };
    expect(patchDissolveShader(shader, uniform)).toBe(true);
    expect(shader.uniforms.uArrivalLevel).toBe(uniform);
    expect(shader.fragmentShader).toContain('uniform float uArrivalLevel;');
    expect(shader.fragmentShader).toContain('>= uArrivalLevel) discard;');
    // the discard sits inside main(), after the clipping include
    expect(shader.fragmentShader.indexOf('discard')).toBeGreaterThan(shader.fragmentShader.indexOf('void main'));
  });

  it('a second dissolve with its own uniform name patches the same shader without redeclaring (#3494)', () => {
    const arrival = { value: 1 };
    const fade = { value: 0 };
    const shader = { uniforms: {}, fragmentShader: SOURCE };
    expect(patchDissolveShader(shader, arrival)).toBe(true);
    expect(patchDissolveShader(shader, fade, 'uTierFadeLevel')).toBe(true);
    expect(shader.fragmentShader.match(/uniform float uArrivalLevel;/g)).toHaveLength(1);
    expect(shader.fragmentShader.match(/uniform float uTierFadeLevel;/g)).toHaveLength(1);
    expect(shader.uniforms.uArrivalLevel).toBe(arrival);
    expect(shader.uniforms.uTierFadeLevel).toBe(fade);
  });

  it('leaves a shader without the expected markers untouched', () => {
    const shader = { uniforms: {}, fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' };
    expect(patchDissolveShader(shader, { value: 0 })).toBe(false);
    expect(shader.fragmentShader).toBe('void main() { gl_FragColor = vec4(1.0); }');
    expect(shader.uniforms.uArrivalLevel).toBeUndefined();
  });
});

describe('createArrivalDissolve', () => {
  function buildItem() {
    const shared = new THREE.MeshStandardMaterial({ color: 0x884422 });
    const other = new THREE.MeshStandardMaterial({ color: 0x228844 });
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    const c = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [shared, other]);
    root.add(a, b, c);
    return { root, shared, other, a, b, c };
  }

  it('swaps in one clone per distinct material, never touching the originals', () => {
    const { root, shared, other, a, b, c } = buildItem();
    const dissolve = createArrivalDissolve(root);
    expect(dissolve.materialCount).toBe(2);
    expect(a.material).not.toBe(shared);
    expect(a.material).toBe(b.material); // one clone per original
    expect(c.material[0]).toBe(a.material);
    expect(c.material[1]).not.toBe(other);
    expect(a.material.transparent).toBe(false); // never switched to transparent
    expect(shared.onBeforeCompile).toBe(THREE.Material.prototype.onBeforeCompile);
  });

  it('drives the shared uniform from setLevel, clamped', () => {
    const { root, a } = buildItem();
    const dissolve = createArrivalDissolve(root);
    const shader = { uniforms: {}, fragmentShader: '#include <common>\nvoid main() {\n#include <clipping_planes_fragment>\n}' };
    a.material.onBeforeCompile(shader, null);
    expect(shader.uniforms.uArrivalLevel.value).toBe(0);
    dissolve.setLevel(0.4);
    expect(shader.uniforms.uArrivalLevel.value).toBeCloseTo(0.4);
    dissolve.setLevel(3);
    expect(shader.uniforms.uArrivalLevel.value).toBe(1);
    dissolve.setLevel(-1);
    expect(shader.uniforms.uArrivalLevel.value).toBe(0);
  });

  it('restore puts the originals back, disposes only the clones, and is repeatable', () => {
    const { root, shared, other, a, b, c } = buildItem();
    const sharedState = tracksDispose(shared);
    const otherState = tracksDispose(other);
    const dissolve = createArrivalDissolve(root);
    const clones = [a.material, c.material[1]];
    const cloneStates = clones.map(tracksDispose);
    dissolve.restore();
    expect(a.material).toBe(shared);
    expect(b.material).toBe(shared);
    expect(c.material).toEqual([shared, other]);
    expect(cloneStates.every((s) => s.disposed)).toBe(true);
    expect(sharedState.disposed).toBe(false);
    expect(otherState.disposed).toBe(false);
    expect(() => dissolve.restore()).not.toThrow();
  });

  it('chains a material\'s own onBeforeCompile and uses its own program key', () => {
    const material = new THREE.MeshStandardMaterial();
    let called = 0;
    material.onBeforeCompile = () => { called += 1; };
    const root = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    createArrivalDissolve(root);
    const shader = { uniforms: {}, fragmentShader: '#include <common>\nvoid main() {\n#include <clipping_planes_fragment>\n}' };
    root.material.onBeforeCompile(shader, null);
    expect(called).toBe(1);
    expect(root.material.customProgramCacheKey()).toContain('arrival-dissolve');
  });

  it('an item with no meshes is a harmless no-op', () => {
    const dissolve = createArrivalDissolve(new THREE.Group());
    expect(dissolve.materialCount).toBe(0);
    expect(() => { dissolve.setLevel(1); dissolve.restore(); }).not.toThrow();
  });
});
