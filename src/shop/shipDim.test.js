import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyShipDim, patchShipDimShader, setShipDim, shipDimUniform, SHIP_DIM_UNIFORM_NAME } from './shipDim.js';

const fragment = '#include <common>\nvoid main() {\n  #include <dithering_fragment>\n}';

describe('the ship dim (#4602)', () => {
  it('washes the fragment toward cream by one uniform, after the last colour step', () => {
    const shader = { fragmentShader: fragment, uniforms: {} };
    const uniform = { value: 0 };
    expect(patchShipDimShader(shader, uniform)).toBe(true);
    expect(shader.uniforms[SHIP_DIM_UNIFORM_NAME]).toBe(uniform);
    expect(shader.fragmentShader).toMatch(/uniform float uShipDim;/);
    expect(shader.fragmentShader.indexOf('dithering_fragment')).toBeLessThan(shader.fragmentShader.indexOf('mix(gl_FragColor.rgb'));
  });
  it('leaves a shader without the markers alone', () => {
    const shader = { fragmentShader: 'void main() {}', uniforms: {} };
    expect(patchShipDimShader(shader, { value: 0 })).toBe(false);
    expect(shader.fragmentShader).toBe('void main() {}');
  });
  it('patches each material once, chains an earlier patch, and is switched by a number, not a recompile', () => {
    const material = new THREE.MeshStandardMaterial();
    let earlier = 0;
    material.onBeforeCompile = () => { earlier += 1; };
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    applyShipDim(root, 'models/a.glb');
    applyShipDim(root, 'models/a.glb');
    const shader = { fragmentShader: fragment, uniforms: {} };
    material.onBeforeCompile(shader, null);
    expect(earlier).toBe(1);
    expect(shader.uniforms.uShipDim).toBe(shipDimUniform('models/a.glb'));
    const versionBefore = material.version;
    setShipDim([{ key: 'models/a.glb', dim: true }]);
    expect(shader.uniforms.uShipDim.value).toBe(1);
    setShipDim([{ key: 'models/a.glb', dim: false }]);
    expect(shader.uniforms.uShipDim.value).toBe(0);
    expect(material.version).toBe(versionBefore);
    expect(material.customProgramCacheKey()).toMatch(/ship-dim$/);
  });
});
