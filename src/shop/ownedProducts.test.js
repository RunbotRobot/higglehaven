import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMyOwnedAvatars = vi.fn();
const fetchMyOwnedAnimations = vi.fn();
vi.mock('../api.js', () => ({ fetchMyOwnedAvatars, fetchMyOwnedAnimations }));

async function freshModule() {
  vi.resetModules();
  return import('./ownedProducts.js');
}

beforeEach(() => {
  fetchMyOwnedAvatars.mockReset();
  fetchMyOwnedAnimations.mockReset();
});

describe('ownedProducts (#3681)', () => {
  it('knows nothing is owned before it has read anything', async () => {
    const { isOwnedProduct } = await freshModule();
    expect(isOwnedProduct('t-1')).toBe(false);
    expect(isOwnedProduct(null)).toBe(false);
  });

  it('reads every page of both lists, once', async () => {
    fetchMyOwnedAvatars
      .mockResolvedValueOnce({ avatars: [{ templateId: 'a-1' }], nextCursor: 'c2' })
      .mockResolvedValueOnce({ avatars: [{ templateId: 'a-2' }], nextCursor: null });
    fetchMyOwnedAnimations.mockResolvedValueOnce({ animations: [{ templateId: 'n-1' }], nextCursor: null });
    const { loadOwnedProducts, isOwnedProduct } = await freshModule();
    await loadOwnedProducts();
    expect(['a-1', 'a-2', 'n-1'].every(isOwnedProduct)).toBe(true);
    expect(isOwnedProduct('physical-1')).toBe(false);
    expect(fetchMyOwnedAvatars).toHaveBeenCalledTimes(2);
    expect(fetchMyOwnedAvatars).toHaveBeenLastCalledWith('c2');
    // Asking again costs nothing: the card does this on every tap.
    await loadOwnedProducts();
    expect(fetchMyOwnedAvatars).toHaveBeenCalledTimes(2);
    expect(fetchMyOwnedAnimations).toHaveBeenCalledTimes(1);
  });

  it('shares one read between cards that ask at the same moment', async () => {
    fetchMyOwnedAvatars.mockResolvedValue({ avatars: [], nextCursor: null });
    fetchMyOwnedAnimations.mockResolvedValue({ animations: [], nextCursor: null });
    const { loadOwnedProducts } = await freshModule();
    await Promise.all([loadOwnedProducts(), loadOwnedProducts(), loadOwnedProducts()]);
    expect(fetchMyOwnedAvatars).toHaveBeenCalledTimes(1);
  });

  it('reads again when asked to (after a purchase) and picks up what was just bought', async () => {
    fetchMyOwnedAvatars.mockResolvedValueOnce({ avatars: [], nextCursor: null })
      .mockResolvedValueOnce({ avatars: [{ templateId: 'a-9' }], nextCursor: null });
    fetchMyOwnedAnimations.mockResolvedValue({ animations: [], nextCursor: null });
    const { loadOwnedProducts, isOwnedProduct } = await freshModule();
    await loadOwnedProducts();
    expect(isOwnedProduct('a-9')).toBe(false);
    await loadOwnedProducts({ force: true });
    expect(isOwnedProduct('a-9')).toBe(true);
  });

  it('a failed read never throws and shows nothing owned; the next ask tries again', async () => {
    fetchMyOwnedAvatars.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ avatars: [{ templateId: 'a-1' }], nextCursor: null });
    fetchMyOwnedAnimations.mockResolvedValue({ animations: [], nextCursor: null });
    const { loadOwnedProducts, isOwnedProduct } = await freshModule();
    await expect(loadOwnedProducts()).resolves.toBeUndefined();
    expect(isOwnedProduct('a-1')).toBe(false);
    await loadOwnedProducts();
    expect(isOwnedProduct('a-1')).toBe(true);
  });

  it('stops after a bounded number of pages', async () => {
    fetchMyOwnedAvatars.mockResolvedValue({ avatars: [{ templateId: 'a' }], nextCursor: 'more' });
    fetchMyOwnedAnimations.mockResolvedValue({ animations: [], nextCursor: null });
    const { loadOwnedProducts } = await freshModule();
    await loadOwnedProducts();
    expect(fetchMyOwnedAvatars).toHaveBeenCalledTimes(20);
  });
});
