import { describe, expect, it } from 'vitest';
import { MAX_MODEL_BYTES, modelTooLargeMessage, isUploadableModelName } from '../../shared/model-limits.js';
import { MAX_MODEL_BYTES as WORKER_MAX } from '../../worker/lib/storage.js';

describe('model limits (#4345)', () => {
  it('the Worker and the upload step read one number', () => {
    expect(WORKER_MAX).toBe(MAX_MODEL_BYTES);
    expect(MAX_MODEL_BYTES).toBe(20 * 1024 * 1024);
  });
  it('accepts .glb and .fbx in any case, nothing else', () => {
    for (const ok of ['a.glb', 'A.GLB', 'b.fbx', 'x.y.Fbx']) expect(isUploadableModelName(ok)).toBe(true);
    for (const bad of ['a.obj', 'a.glb.txt', 'glb', '', null, undefined]) expect(isUploadableModelName(bad)).toBe(false);
  });
  it('the too-large message names both sizes', () => {
    const m = modelTooLargeMessage('31.0MB', '20.0MB');
    expect(m).toContain('31.0MB');
    expect(m).toContain('20.0MB');
  });
});
