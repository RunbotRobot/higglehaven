import { describe, it, expect, vi } from 'vitest';
import { buyTimeAccountRefusal } from './buyAccountRefusal.js';

const deps = () => ({
  requireLogin: vi.fn(async () => ({})),
  requireVerification: vi.fn(async (u) => u),
  currentAuthUser: vi.fn(() => ({ id: 1 })),
  setCurrentAuthUser: vi.fn(),
});

describe('buyTimeAccountRefusal (#4461)', () => {
  it('a 401 says the session ended and nothing was charged, then clears the stale user and opens login', async () => {
    const d = deps();
    const r = buyTimeAccountRefusal(Object.assign(new Error('Not authenticated'), { status: 401 }), d);
    expect(r.message).toMatch(/session ended/);
    expect(r.message).toMatch(/not charged/);
    await r.fix();
    expect(d.setCurrentAuthUser).toHaveBeenCalledWith(null);
    expect(d.requireLogin).toHaveBeenCalledWith('login', expect.any(String));
    expect(d.setCurrentAuthUser.mock.invocationCallOrder[0]).toBeLessThan(d.requireLogin.mock.invocationCallOrder[0]);
  });

  it('a verification refusal says what to do and opens verification for the signed-in user', async () => {
    const d = deps();
    const r = buyTimeAccountRefusal(Object.assign(new Error('Age attestation...'), { status: 403, body: { verificationRequired: true } }), d);
    expect(r.message).toMatch(/Verify your age/);
    expect(r.message).toMatch(/not charged/);
    await r.fix();
    expect(d.requireVerification).toHaveBeenCalledWith({ id: 1 });
  });

  it('anything else is left to the normal notice', () => {
    expect(buyTimeAccountRefusal(Object.assign(new Error('x'), { status: 403 }), deps())).toBeNull();
    expect(buyTimeAccountRefusal(Object.assign(new Error('x'), { status: 500 }), deps())).toBeNull();
    expect(buyTimeAccountRefusal(new Error('x'), deps())).toBeNull();
  });
});
