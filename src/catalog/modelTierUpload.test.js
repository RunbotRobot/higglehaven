// #3414 (Model tiers 2/7, #3412): the seller-side glue that turns an optimised
// model into stored mid and far versions. The browser-only pieces (parse,
// export, frame wait, upload) are injected, so this checks the decisions: what
// is stored, what is skipped, and that nothing here ever fails an upload.
import { describe, expect, it, vi } from 'vitest';
import { createAndUploadModelTiers, generateModelTierBlobs, rescaleAndUploadModelTiers } from './modelTierUpload.js';

const FULL_SIZE = 1000;
const fullBlob = new Blob([new Uint8Array(FULL_SIZE)], { type: 'model/gltf-binary' });

function blobOf(size) {
  return new Blob([new Uint8Array(size)], { type: 'model/gltf-binary' });
}

function deps({ mid = { object: 'mid-object', sharesFullModel: false }, far = { object: 'far-object', sharesFullModel: false }, sizes = { 'mid-object': 300, 'far-object': 40 } } = {}) {
  const upload = vi.fn(async (file, { tier }) => ({ modelUrl: `/uploads/models/${tier}.glb`, sizeBytes: file.size }));
  return {
    parseModel: vi.fn(async () => 'scene'),
    buildTiers: vi.fn(async () => ({ mid, far })),
    exportGlb: vi.fn(async (object) => blobOf(sizes[object] ?? 5)),
    nextFrame: vi.fn(async () => {}),
    upload,
  };
}

describe('generateModelTierBlobs', () => {
  it('exports the mid and far versions as blobs smaller than the full model', async () => {
    const d = deps();
    const out = await generateModelTierBlobs(fullBlob, d);
    expect(out.mid.size).toBe(300);
    expect(out.far.size).toBe(40);
    expect(d.parseModel).toHaveBeenCalledWith(fullBlob);
  });

  it('skips a tier the builder returned as the full model itself (nothing smaller to store)', async () => {
    const d = deps({ mid: { object: 'mid-object', sharesFullModel: true } });
    const out = await generateModelTierBlobs(fullBlob, d);
    expect(out.mid).toBeNull();
    expect(out.far).not.toBeNull();
  });

  it('skips a tier whose exported file is not smaller than the full model', async () => {
    const d = deps({ sizes: { 'mid-object': FULL_SIZE, 'far-object': 40 } });
    const out = await generateModelTierBlobs(fullBlob, d);
    expect(out.mid).toBeNull();
    expect(out.far.size).toBe(40);
  });

  it('reports progress in plain words', async () => {
    const onProgress = vi.fn();
    await generateModelTierBlobs(fullBlob, { ...deps(), onProgress });
    expect(onProgress).toHaveBeenCalledWith('Preparing distance versions…');
  });
});

describe('createAndUploadModelTiers', () => {
  it('uploads each tier as its own kind and returns the URLs', async () => {
    const d = deps();
    const out = await createAndUploadModelTiers(fullBlob, FULL_SIZE, d);
    expect(out).toEqual({ modelMidUrl: '/uploads/models/mid.glb', modelFarUrl: '/uploads/models/far.glb' });
    expect(d.upload.mock.calls.map(([, options]) => options)).toEqual([{ tier: 'mid' }, { tier: 'far' }]);
  });

  it('never rejects: a failure to build leaves the product with no tiers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    d.buildTiers = vi.fn(async () => { throw new Error('simplifier choked'); });
    await expect(createAndUploadModelTiers(fullBlob, FULL_SIZE, d)).resolves.toEqual({ modelMidUrl: null, modelFarUrl: null });
    warn.mockRestore();
  });

  it('keeps the tier that stored when the other fails to upload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    d.upload = vi.fn(async (file, { tier }) => {
      if (tier === 'mid') throw new Error('storage full');
      return { modelUrl: '/uploads/models/far.glb', sizeBytes: file.size };
    });
    await expect(createAndUploadModelTiers(fullBlob, FULL_SIZE, d)).resolves.toEqual({ modelMidUrl: null, modelFarUrl: '/uploads/models/far.glb' });
    warn.mockRestore();
  });

  it('does not send a tier the server would refuse as no smaller than the stored full model', async () => {
    const d = deps();
    d.upload = vi.fn(async (file, { tier }) => ({ modelUrl: `/uploads/models/${tier}.glb`, sizeBytes: tier === 'mid' ? FULL_SIZE : file.size }));
    const out = await createAndUploadModelTiers(fullBlob, FULL_SIZE, d);
    expect(out).toEqual({ modelMidUrl: null, modelFarUrl: '/uploads/models/far.glb' });
  });

  it('stops uploading once the seller has moved on', async () => {
    const d = deps();
    let calls = 0;
    const out = await createAndUploadModelTiers(fullBlob, FULL_SIZE, { ...d, shouldContinue: () => calls++ < 1 });
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(out.modelFarUrl).toBeNull();
  });
});

describe('rescaleAndUploadModelTiers', () => {
  it('rescales each named tier by the same factor and stores it again', async () => {
    const d = deps();
    d.fetchBlob = vi.fn(async () => blobOf(80));
    d.rescale = vi.fn(async (blob, factor) => blobOf(blob.size + factor));
    const out = await rescaleAndUploadModelTiers(
      { modelMidUrl: '/uploads/models/a.glb', modelFarUrl: '/uploads/models/b.glb' }, 2, FULL_SIZE, d,
    );
    expect(out).toEqual({ modelMidUrl: '/uploads/models/mid.glb', modelFarUrl: '/uploads/models/far.glb' });
    expect(d.rescale.mock.calls.map(([, factor]) => factor)).toEqual([2, 2]);
  });

  it('skips a tier that is not there and drops one that fails, without rejecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    d.fetchBlob = vi.fn(async () => { throw new Error('gone'); });
    const out = await rescaleAndUploadModelTiers({ modelMidUrl: '/uploads/models/a.glb', modelFarUrl: null }, 2, FULL_SIZE, d);
    expect(out).toEqual({ modelMidUrl: null, modelFarUrl: null });
    expect(d.fetchBlob).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
