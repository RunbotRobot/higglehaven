// #2555 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): per-mode identity resolution,
// extracted wholesale from src/main.js. Real login (docs/API.md's
// "Authentication") replaced the dev-mode identity picker that used to live
// here — entering Build or Sell mode now requires a real account, and the
// resulting builder/seller profile is whichever one that account already
// has (auto-provisioned server-side — see
// migrations/0054_link_builders_sellers_to_users.sql), not a free-text
// label picked from a shared list. ensureBuilderIdentity/ensureSellerIdentity
// below keep the exact same Promise<id-or-null> contract the old
// picker-backed versions had (null only if the login prompt is dismissed
// without logging in), so every call site across the app needed no changes.
import { requireLogin, requireVerification } from './auth.js';
import { fetchMyBuilder, fetchMySeller } from '../api.js';
import { builderId, setBuilderId, sellerId, setSellerId } from '../world/state.js';

// Two independent in-flight promises (not one shared "identity" flow),
// for the same reason the old picker's own comment gave: Build mode's own
// startup can be awaiting a login at the very moment the Sell nav button
// triggers its own, and each needs to resolve independently.
let builderIdentityFlowPromise = null;
export async function ensureBuilderIdentity() {
  if (builderId) return builderId;
  if (!builderIdentityFlowPromise) {
    builderIdentityFlowPromise = (async () => {
      let user = await requireLogin('signup', 'Sign up (or log in) to start building.');
      if (!user) return null;
      user = await requireVerification(user);
      if (!user) return null;
      const builder = await fetchMyBuilder();
      setBuilderId(builder.builderId);
      return builderId;
    })();
  }
  const id = await builderIdentityFlowPromise;
  builderIdentityFlowPromise = null;
  return id;
}

let sellerIdentityFlowPromise = null;
export async function ensureSellerIdentity() {
  if (sellerId) return sellerId;
  if (!sellerIdentityFlowPromise) {
    sellerIdentityFlowPromise = (async () => {
      let user = await requireLogin('signup', 'Sign up (or log in) to start selling.');
      if (!user) return null;
      user = await requireVerification(user);
      if (!user) return null;
      const seller = await fetchMySeller();
      setSellerId(seller.sellerId);
      return sellerId;
    })();
  }
  const id = await sellerIdentityFlowPromise;
  sellerIdentityFlowPromise = null;
  return id;
}

// #2554: src/account/auth.js's own resetLocalSessionState (shared by its
// logout/delete-account flows, #432) needs to clear these two guards
// alongside builderId/sellerId.
export function resetIdentityFlowPromises() {
  builderIdentityFlowPromise = null;
  sellerIdentityFlowPromise = null;
}

// N44 (owner, Control Room, 2026-09-12): "I do want age attestation and
// credit card to gate login for shopping... restrict minors from using any
// part of the application" — Shop mode used to need no identity at all,
// unlike Build/Sell above. Unlike those two, shopping has no separate
// profile of its own to provision (no builderId/sellerId equivalent) — this
// just blocks on the same login + #556 verification gate and hands back
// the verified user, or null if they declined either step. requireLogin/
// requireVerification already short-circuit once currentAuthUser is set and
// verified, so — unlike builderId/sellerId above — there's no cheap
// `if (x) return x` to check first; the flow-promise guard below still
// exists to collapse concurrent callers (e.g. bootstrap() and a stray
// re-entry) into one shared prompt instead of two.
let shopperIdentityFlowPromise = null;
export async function ensureShopperIdentity() {
  if (!shopperIdentityFlowPromise) {
    shopperIdentityFlowPromise = (async () => {
      let user = await requireLogin('signup', 'Sign up (or log in) — age verification is required to use higglehaven.');
      if (!user) return null;
      return requireVerification(user);
    })();
  }
  const user = await shopperIdentityFlowPromise;
  shopperIdentityFlowPromise = null;
  return user;
}
