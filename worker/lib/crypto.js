// #2528: small, pure crypto-adjacent primitives with no dependencies of
// their own, used across several otherwise-unrelated domains (access-gate
// passphrases, Control Room API key, password-hash comparison, Stripe/
// webhook signatures, admin-bootstrap secret, tax-ID encryption) -- not
// specific to auth, validation, or any one feature area. Extracted
// verbatim, zero behavior change.

// Not a security-critical timing defense in every caller (e.g. gating a
// handful of friends is not a real adversary) -- just cheap enough to use
// everywhere a secret gets compared instead of reaching for `===` in some
// spots and not others. timingSafeEqual: 9 call sites.
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// bytesToHex: 11 call sites. hexToBytes: 4 call sites (PBKDF2 salt decode,
// tax-ID encryption key import/IV/ciphertext decode).
export function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
