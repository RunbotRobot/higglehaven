// #3294: the shared avatar mount keeps enterShopMode's behaviour exactly.
import { describe, expect, it, vi } from 'vitest';
import { mountShopAvatar } from './mountShopAvatar.js';

// #3905: the equipped avatar arrives in the background; most tests want the settled result.
async function mountSettled(args, deps) {
  const mounted = await mountShopAvatar(args, deps);
  await mounted.settled;
  return mounted;
}

function setup({ avatar, animation, customAvatar, previous = null } = {}) {
  const calls = [];
  let current = previous;
  const scene = { add: vi.fn((g) => calls.push(['add', g])), remove: vi.fn((g) => calls.push(['remove', g])) };
  const win = {};
  const defaultAvatar = { group: 'default-group', modelUrl: null, animationSource: undefined };
  const deps = {
    fetchMyEquippedAvatar: vi.fn(async () => { if (avatar instanceof Error) throw avatar; return avatar ?? { modelUrl: null, skeletonSignature: 'sig-none' }; }),
    fetchMyEquippedAnimation: vi.fn(async () => { if (animation instanceof Error) throw animation; return animation ?? { equippedTemplateId: null }; }),
    setEquippedAvatarSkeletonSignature: vi.fn((sig) => calls.push(['signature', sig])),
    getShopAvatar: () => current,
    setShopAvatar: vi.fn((a) => { current = a; }),
    disposeObject3D: vi.fn((g) => calls.push(['dispose', g])),
    createCustomShopAvatar: vi.fn(async () => { if (customAvatar instanceof Error) throw customAvatar; return customAvatar; }),
    createShopAvatar: vi.fn(() => defaultAvatar),
    shopAvatarHeightM: () => 1.7, shopAvatarCollisionHalfM: () => 0.3, shopCameraAnchorHeightM: () => 1.5,
    resetShopAvatarIdleState: vi.fn(() => calls.push(['reset'])),
    win,
  };
  return { deps, scene, win, calls, defaultAvatar, getCurrent: () => current };
}

describe('mountShopAvatar (#3294)', () => {
  it('does not call the equipped-avatar or animation endpoints when logged out, and mounts the default avatar', async () => {
    const t = setup();
    await mountSettled({ scene: t.scene, isLoggedIn: false }, t.deps);
    expect(t.deps.fetchMyEquippedAvatar).not.toHaveBeenCalled();
    expect(t.deps.fetchMyEquippedAnimation).not.toHaveBeenCalled();
    expect(t.deps.createCustomShopAvatar).not.toHaveBeenCalled();
    expect(t.getCurrent()).toBe(t.defaultAvatar);
    expect(t.scene.add).toHaveBeenCalledWith('default-group');
  });

  it('asks again before the animation fetch, so a logout that began meanwhile sends no 401 (#3498)', async () => {
    const t = setup();
    let loggedIn = true;
    t.deps.fetchMyEquippedAvatar.mockImplementation(async () => { loggedIn = false; return { modelUrl: null, skeletonSignature: 'sig-none' }; });
    await mountSettled({ scene: t.scene, isLoggedIn: () => loggedIn }, t.deps);
    expect(t.deps.fetchMyEquippedAvatar).toHaveBeenCalledTimes(1);
    expect(t.deps.fetchMyEquippedAnimation).not.toHaveBeenCalled();
    expect(t.getCurrent()).toBe(t.defaultAvatar);
  });

  it('sends neither fetch when the logout began before the mount ran (#3498)', async () => {
    const t = setup();
    await mountSettled({ scene: t.scene, isLoggedIn: () => false }, t.deps);
    expect(t.deps.fetchMyEquippedAvatar).not.toHaveBeenCalled();
    expect(t.deps.fetchMyEquippedAnimation).not.toHaveBeenCalled();
  });

  it('falls back to the default avatar, without throwing, when the equipped-avatar fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup({ avatar: new Error('boom') });
    t.deps.equippedRetryDelaysMs = [];
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.getCurrent()).toBe(t.defaultAvatar);
    expect(t.deps.createCustomShopAvatar).not.toHaveBeenCalled();
    expect(t.win.__shopAvatarModelUrl).toBeNull();
    warn.mockRestore();
  });

  it('builds the custom avatar with the applied animation, records the skeleton signature and publishes diagnostics', async () => {
    const custom = { group: 'custom-group', modelUrl: '/uploads/a.glb', animationSource: 'applied' };
    const animation = { equippedTemplateId: 'anim-1' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb', skeletonSignature: 'sig-1' }, animation, customAvatar: custom });
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.getCurrent()).toBe(custom);
    expect(t.deps.createCustomShopAvatar).toHaveBeenCalledWith('/uploads/a.glb', animation, null);
    expect(t.calls.filter(([k]) => k === 'signature').map(([, v]) => v)).toEqual([null, 'sig-1']);
    expect(t.win.__shopAvatarModelUrl).toBe('/uploads/a.glb');
    expect(t.win.__shopAvatarAnimationSource).toBe('applied');
    expect(t.win.__shopAvatarBuiltinMotion).toBe(false); // it has clips, so no built-in motion (#3777)
    expect(t.win.__shopAvatarMetrics).toEqual({ heightM: 1.7, collisionHalfM: 0.3, cameraAnchorHeightM: 1.5 });
    expect(t.deps.resetShopAvatarIdleState).toHaveBeenCalledTimes(1);
  });

  it('hands the seller\'s chosen clip roles to the custom avatar (#3314)', async () => {
    const roles = { idle: null, walk: 'mixamo.com', fly: null };
    const t = setup({ avatar: { modelUrl: '/u.glb', clipRoles: roles }, customAvatar: { group: 'c', modelUrl: '/u.glb' } });
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.deps.createCustomShopAvatar).toHaveBeenCalledWith('/u.glb', null, roles);
  });

  it('ignores an animation response with no equipped template, and survives the animation fetch failing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const custom = { group: 'c', modelUrl: '/u.glb' };
    const none = setup({ avatar: { modelUrl: '/u.glb' }, animation: { equippedTemplateId: null }, customAvatar: custom });
    await mountSettled({ scene: none.scene, isLoggedIn: true }, none.deps);
    expect(none.deps.createCustomShopAvatar).toHaveBeenCalledWith('/u.glb', null, null);
    const failed = setup({ avatar: { modelUrl: '/u.glb' }, animation: new Error('nope'), customAvatar: custom });
    await mountSettled({ scene: failed.scene, isLoggedIn: true }, failed.deps);
    expect(failed.deps.createCustomShopAvatar).toHaveBeenCalledWith('/u.glb', null, null);
    warn.mockRestore();
  });

  it('falls back to the default avatar when the custom model fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup({ avatar: { modelUrl: '/bad.glb' }, customAvatar: new Error('load failed') });
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.getCurrent()).toBe(t.defaultAvatar);
    warn.mockRestore();
  });

  it('says so once, through onModelFailed, when the worn model fails to load, and not when it loads (#4067)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = setup({ avatar: { modelUrl: '/bad.glb' }, customAvatar: new Error('load failed') });
    failed.deps.onModelFailed = vi.fn();
    await mountSettled({ scene: failed.scene, isLoggedIn: true }, failed.deps);
    expect(failed.deps.onModelFailed).toHaveBeenCalledTimes(1);
    const fine = setup({ avatar: { modelUrl: '/u.glb' }, customAvatar: { group: 'custom-group', modelUrl: '/u.glb' } });
    fine.deps.onModelFailed = vi.fn();
    await mountSettled({ scene: fine.scene, isLoggedIn: true }, fine.deps);
    expect(fine.deps.onModelFailed).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes and disposes an avatar left from a previous round trip before mounting the new one', async () => {
    const previous = { group: 'old-group' };
    const t = setup({ previous });
    await mountSettled({ scene: t.scene, isLoggedIn: false }, t.deps);
    const kinds = t.calls.map(([k, v]) => `${k}:${v ?? ''}`);
    expect(kinds.indexOf('remove:old-group')).toBeLessThan(kinds.indexOf('dispose:old-group'));
    expect(kinds.indexOf('dispose:old-group')).toBeLessThan(kinds.indexOf('add:default-group'));
  });

  it('mounts the default avatar at once, before the equipped avatar is even fetched, and swaps the custom one in when it is ready (#3905)', async () => {
    const custom = { group: 'custom-group', modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb', skeletonSignature: 'sig-1' }, customAvatar: custom });
    let release;
    t.deps.fetchMyEquippedAvatar.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ modelUrl: '/uploads/a.glb', skeletonSignature: 'sig-1' }); }));
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(mounted.avatar).toBe(t.defaultAvatar);
    expect(t.getCurrent()).toBe(t.defaultAvatar);
    expect(t.win.__shopAvatarSettled).toBe(false);
    release();
    await mounted.settled;
    expect(t.getCurrent()).toBe(custom);
    expect(t.win.__shopAvatarSettled).toBe(true);
    const kinds = t.calls.map(([k, v]) => `${k}:${v ?? ''}`);
    expect(kinds.indexOf('remove:default-group')).toBeLessThan(kinds.indexOf('add:custom-group'));
    expect(kinds).toContain('dispose:default-group');
  });

  it('hands the swap to beginAvatarSwap and is settled only once its commit has run (#3905)', async () => {
    const custom = { group: 'custom-group', modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb', skeletonSignature: 'sig-1' }, customAvatar: custom });
    let commitSwap;
    let finish;
    t.deps.beginAvatarSwap = vi.fn((commit) => {
      commitSwap = commit;
      return { done: new Promise((resolve) => { finish = () => { commit(); resolve(); }; }) };
    });
    t.deps.cancelAvatarSwap = vi.fn();
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.deps.cancelAvatarSwap).toHaveBeenCalledTimes(1); // an earlier swap is ended on mount
    await vi.waitFor(() => expect(t.deps.beginAvatarSwap).toHaveBeenCalled());
    expect(commitSwap).toBeTypeOf('function');
    expect(t.getCurrent()).toBe(t.defaultAvatar); // still the default body while the fog rises
    expect(t.win.__shopAvatarSettled).toBe(false);
    finish();
    await mounted.settled;
    expect(t.getCurrent()).toBe(custom);
    expect(t.win.__shopAvatarSettled).toBe(true);
  });

  it('drops the custom body when something replaced the avatar while the fog was rising (#3905)', async () => {
    const custom = { group: 'custom-group', modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb' }, customAvatar: custom });
    t.deps.beginAvatarSwap = vi.fn((commit) => {
      t.deps.setShopAvatar({ group: 'someone-else' }); // another equip lands first
      commit();
      return { done: Promise.resolve() };
    });
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    await mounted.settled;
    expect(t.getCurrent()).toEqual({ group: 'someone-else' });
    expect(t.deps.disposeObject3D).toHaveBeenCalledWith('custom-group');
  });

  it('keeps the default avatar and is settled at once when nothing is equipped (#3905)', async () => {
    const t = setup();
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    await mounted.settled;
    expect(t.getCurrent()).toBe(t.defaultAvatar);
    expect(t.win.__shopAvatarSettled).toBe(true);
    expect(t.deps.createCustomShopAvatar).not.toHaveBeenCalled();
  });

  it('drops a custom avatar that finished after something else replaced the avatar (#3905)', async () => {
    const custom = { group: 'custom-group', modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb' }, customAvatar: custom });
    let finish;
    t.deps.createCustomShopAvatar.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(custom); }));
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const equippedMeanwhile = { group: 'equipped-meanwhile' };
    t.deps.setShopAvatar(equippedMeanwhile); // a re-equip swapped the avatar while the model downloaded
    finish();
    await mounted.settled;
    expect(t.getCurrent()).toBe(equippedMeanwhile);
    expect(t.calls.map(([k, v]) => `${k}:${v ?? ''}`)).toContain('dispose:custom-group');
  });

  it('a second mount supersedes the first one\'s background swap (#3905)', async () => {
    const custom = { group: 'custom-group', modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb' }, customAvatar: custom });
    let finish;
    t.deps.createCustomShopAvatar.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(custom); }));
    const first = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.deps.fetchMyEquippedAvatar.mockImplementation(async () => ({ modelUrl: null, skeletonSignature: null }));
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    finish();
    await first.settled;
    expect(t.getCurrent()).toBe(t.defaultAvatar);
  });
});

// #4067: the person's own body is never the default one in the place of the model they wear: fog and no body
// until the answer is in, then the right body.
describe('mountShopAvatar: fog, not a stand-in (#4067)', () => {
  function fakeHold(t) {
    const hold = {
      resolve: vi.fn((commit) => { hold.committed = commit; commit(); }),
      cancel: vi.fn(),
    };
    t.deps.beginAvatarFogHold = vi.fn(() => hold);
    return hold;
  }
  const withGroup = (t) => { t.defaultAvatar.group = { visible: true, name: 'default-group' }; t.scene.add = vi.fn(); t.scene.remove = vi.fn(); };

  it('hides the default body at once for someone who may wear their own, and shows the worn one in its place', async () => {
    const custom = { group: { visible: true }, modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb', skeletonSignature: 's' }, customAvatar: custom });
    withGroup(t);
    const hold = fakeHold(t);
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.defaultAvatar.group.visible).toBe(false); // never drawn
    await mounted.settled;
    expect(hold.resolve).toHaveBeenCalledTimes(1);
    expect(t.getCurrent()).toBe(custom);
  });

  it('someone who wears the default sees it from the fog once the answer is in', async () => {
    const t = setup(); // nothing equipped
    withGroup(t);
    const hold = fakeHold(t);
    const mounted = await mountShopAvatar({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.defaultAvatar.group.visible).toBe(false);
    await mounted.settled;
    expect(hold.resolve).toHaveBeenCalledTimes(1);
    expect(t.defaultAvatar.group.visible).toBe(true);
  });

  it('a person known to wear the default (remembered in this browser) is shown it at once, with no fog', async () => {
    const t = setup();
    withGroup(t);
    fakeHold(t);
    t.deps.readWornHint = () => 'default';
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.deps.beginAvatarFogHold).not.toHaveBeenCalled();
    expect(t.defaultAvatar.group.visible).toBe(true);
  });

  it('signed out: the default body is shown at once, with no fog and no remembering', async () => {
    const t = setup();
    withGroup(t);
    fakeHold(t);
    t.deps.writeWornHint = vi.fn();
    await mountSettled({ scene: t.scene, isLoggedIn: false }, t.deps);
    expect(t.deps.beginAvatarFogHold).not.toHaveBeenCalled();
    expect(t.deps.writeWornHint).not.toHaveBeenCalled();
    expect(t.defaultAvatar.group.visible).toBe(true);
  });

  it('remembers what the person wears, so the next arrival knows', async () => {
    const custom = { group: { visible: true }, modelUrl: '/uploads/a.glb' };
    const worn = setup({ avatar: { modelUrl: '/uploads/a.glb' }, customAvatar: custom });
    withGroup(worn);
    fakeHold(worn);
    worn.deps.writeWornHint = vi.fn();
    await mountSettled({ scene: worn.scene, isLoggedIn: true }, worn.deps);
    expect(worn.deps.writeWornHint).toHaveBeenCalledWith('custom');
    const plain = setup();
    withGroup(plain);
    fakeHold(plain);
    plain.deps.writeWornHint = vi.fn();
    await mountSettled({ scene: plain.scene, isLoggedIn: true }, plain.deps);
    expect(plain.deps.writeWornHint).toHaveBeenCalledWith('default');
  });

  it('a worn model that fails to load falls back to the default body (a failure is not a stand-in)', async () => {
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb' }, customAvatar: new Error('boom') });
    withGroup(t);
    fakeHold(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.defaultAvatar.group.visible).toBe(true);
    expect(t.getCurrent()).toBe(t.defaultAvatar);
    warn.mockRestore();
  });

  it('asks again when the read of what is worn fails once, and then shows the worn body (#4251)', async () => {
    const custom = { group: { visible: true }, modelUrl: '/uploads/a.glb' };
    const t = setup({ avatar: { modelUrl: '/uploads/a.glb' }, customAvatar: custom });
    withGroup(t);
    fakeHold(t);
    t.deps.equippedRetryDelaysMs = [0, 0];
    t.deps.writeWornHint = vi.fn();
    const ok = t.deps.fetchMyEquippedAvatar.getMockImplementation();
    t.deps.fetchMyEquippedAvatar.mockRejectedValueOnce(new Error('blip'));
    t.deps.fetchMyEquippedAvatar.mockImplementation(ok);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.deps.fetchMyEquippedAvatar).toHaveBeenCalledTimes(2);
    expect(t.getCurrent()).toBe(custom);
    expect(t.deps.writeWornHint).toHaveBeenCalledWith('custom');
    expect(t.deps.writeWornHint).not.toHaveBeenCalledWith('default');
    warn.mockRestore();
  });

  it('a read that keeps failing does not remember "wears the default" (#4251)', async () => {
    const t = setup({ avatar: new Error('down') });
    withGroup(t);
    fakeHold(t);
    t.deps.equippedRetryDelaysMs = [0, 0];
    t.deps.writeWornHint = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountSettled({ scene: t.scene, isLoggedIn: true }, t.deps);
    expect(t.deps.fetchMyEquippedAvatar).toHaveBeenCalledTimes(3);
    expect(t.deps.writeWornHint).not.toHaveBeenCalled();
    expect(t.defaultAvatar.group.visible).toBe(true); // a failure is not an invisible person
    warn.mockRestore();
  });
});
