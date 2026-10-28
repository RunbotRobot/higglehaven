// #2554 (part of #2504/#2500's src/main.js module split, see #2503's design
// comment for the full dependency map): login/signup/verify/session flow,
// extracted wholesale from src/main.js. Two notes on cross-module coupling
// the design pass didn't fully anticipate:
// - ensureBuilderIdentity/ensureSellerIdentity/ensureShopperIdentity
//   (account/identity.js, #2555) call requireLogin/requireVerification
//   below, hence those two exports; resetLocalSessionState below needs to
//   reset their own builderIdentityFlowPromise/sellerIdentityFlowPromise
//   guards in turn, hence the resetIdentityFlowPromises() import from
//   account/identity.js.
// - hasVerifiedSession (Shop-mode presence-reporting guard, now in
//   src/shop/presenceAndContent.js, #2626) reads both currentAuthUser
//   (exported below) and its own accountSessionEnding flag, which the
//   delete-account flow below needs to set — hence the
//   setAccountSessionEnding() import from shop/presenceAndContent.js.
// Zero behavior change otherwise.
import {
  signUp, logIn, logOut, deleteAccount, exportMyData, changePassword,
  fetchCurrentUser, requestPasswordReset, resetPassword, verifyEmail,
  resendVerificationEmail, changeEmail, ageAttest, cardSetupIntent,
  confirmCard, startDiditVerification, fetchDiditVerificationStatus,
} from '../api.js';
import { openModalA11y, closeModalA11y } from '../ui/modal.js';
import { currentMode, setBuilderId, setSellerId } from '../world/state.js';
import { loadStripeJs, START_MODE_KEY } from '../main.js';
import { setAccountSessionEnding } from '../shop/presenceAndContent.js';
import { resetIdentityFlowPromises } from './identity.js';

export async function requireLogin(view = 'signup', hint) {
  if (currentAuthUser) return currentAuthUser;
  openAuthModal(view);
  // openAuthModal itself clears any status text, so this has to come
  // after — a plain, neutral message (no error/success styling) saying
  // *why* a login wall just appeared, rather than leaving a first-time
  // visitor to guess.
  if (hint) setAuthStatus(hint);
  const user = await waitForAuthResult();
  closeAuthModal();
  return user;
}

// docs/SPEC.md §6 / #556: age attestation plus credit-card (or eventual
// government-ID, #589) verification, required to build or sell — owner
// decision (Control Room, 2026-09-09): "force everyone through the new
// gates, no grandfathering in," so this applies to every account,
// including ones that logged in before this existed, not just brand-new
// signups. Modeled closely on #auth-modal/#checkout-modal's own
// open/wait/close pattern just above/below, but with no "just dismiss it"
// escape — the only way out of #verify-modal that isn't clearing the gate
// is logging out entirely (see verifyLogoutBtn below), since this app has
// no unverified-but-logged-in state a Build/Sell session can sit in.
let pendingVerifyResolvers = [];
function notifyVerifyResult(user) {
  const resolvers = pendingVerifyResolvers;
  pendingVerifyResolvers = [];
  for (const resolve of resolvers) resolve(user);
}
function waitForVerifyResult() {
  return new Promise((resolve) => pendingVerifyResolvers.push(resolve));
}

const verifyModalEl = document.getElementById('verify-modal');
const verifyAgeStepEl = document.getElementById('verify-age-step');
const verifyAgeAttestInput = document.getElementById('verify-age-attest');
const verifyCardStepEl = document.getElementById('verify-card-step');
const verifyCardFormEl = document.getElementById('verify-card-form');
const verifyCardElementEl = document.getElementById('verify-card-element');
const verifyStatusEl = document.getElementById('verify-status');
const verifyContinueBtn = document.getElementById('verify-continue-btn');
const verifyIdInsteadBtn = document.getElementById('verify-id-instead-btn');
const verifyLogoutBtn = document.getElementById('verify-logout-btn');

function setVerifyStatus(text, type) {
  verifyStatusEl.textContent = text || '';
  verifyStatusEl.classList.toggle('error', type === 'error');
}

let verifyCardElement = null;
// Set once card-setup-intent resolves for the currently-open card step —
// `simulated: true` (Stripe not configured on this deployment, see
// handleCardSetupIntent's own comment in worker/index.js) means there's no
// card element to mount at all; the Continue button goes straight to
// confirmCard(null).
let verifyStripeSetup = null;
// The same Stripe.js instance that created verifyCardElement, reused for
// confirmCardSetup below -- Stripe.js requires the exact same instance for
// both (a second `Stripe(publishableKey)` call creates a distinct object
// even with an identical key), or confirmCardSetup rejects with "Please
// use the same instance of `Stripe`...". Found live (owner report,
// 2026-10-28): calling Stripe(...) fresh in both enterVerifyCardStep and
// the click handler below hit exactly this.
let verifyStripeInstance = null;

async function enterVerifyCardStep() {
  verifyAgeStepEl.hidden = true;
  verifyCardStepEl.hidden = false;
  verifyContinueBtn.disabled = true;
  setVerifyStatus('Loading verification form…');
  try {
    verifyStripeSetup = await cardSetupIntent();
    if (verifyStripeSetup.simulated) {
      // #2862: only the real-card-only parts hide here now -- verifyCardStepEl
      // itself (and verifyIdInsteadBtn inside it) stays visible so the ID
      // alternative is still offered even when there's no real card form to
      // show (this deployment not configuring Stripe at all, same as this
      // test environment always does -- see #2859's own comment on that).
      verifyCardFormEl.hidden = true;
      verifyContinueBtn.textContent = 'Verify (dev mode)';
    } else {
      verifyCardFormEl.hidden = false;
      const Stripe = await loadStripeJs();
      verifyStripeInstance = Stripe(verifyStripeSetup.publishableKey);
      const elements = verifyStripeInstance.elements();
      verifyCardElement = elements.create('card');
      verifyCardElement.mount(verifyCardElementEl);
      verifyContinueBtn.textContent = 'Verify card';
    }
    setVerifyStatus('');
    verifyContinueBtn.disabled = false;
  } catch (err) {
    setVerifyStatus(err.message || 'Could not load card verification.', 'error');
  }
}

function openVerifyModal(user) {
  verifyStripeSetup = null;
  verifyStripeInstance = null;
  verifyAgeAttestInput.checked = false;
  verifyCardStepEl.hidden = true;
  if (verifyCardElement) { verifyCardElement.unmount(); verifyCardElement = null; }
  setVerifyStatus('');
  verifyModalEl.classList.add('visible');
  // #1731: no `closeFn` here, deliberately — see this modal's own "no
  // escape" design comment above. Passing one would wire the shared
  // Escape handler to close this modal like any other, which is exactly
  // the bug: the only way out is verifyLogoutBtn (logging out), not
  // Escape. Tab-focus-trapping is unaffected since it only depends on
  // activeModalEl, not activeModalCloseFn.
  openModalA11y(verifyModalEl, null);
  if (!user.ageAttested) {
    verifyAgeStepEl.hidden = false;
    verifyContinueBtn.textContent = 'Continue';
    verifyContinueBtn.disabled = false;
  } else {
    enterVerifyCardStep();
  }
}

function closeVerifyModal() {
  verifyModalEl.classList.remove('visible');
  closeModalA11y(verifyModalEl);
  if (verifyCardElement) { verifyCardElement.unmount(); verifyCardElement = null; }
  // #2862: this modal can resolve via the card path while an ID-verification
  // poll (started from verifyIdInsteadBtn below) is still in flight -- stop
  // it so a later "approved" tick doesn't fire against a modal that already
  // closed.
  stopDiditPoll();
}

verifyContinueBtn.addEventListener('click', async () => {
  if (!verifyAgeStepEl.hidden) {
    if (!verifyAgeAttestInput.checked) {
      setVerifyStatus('Please confirm you meet the age requirement.', 'error');
      return;
    }
    verifyContinueBtn.disabled = true;
    setVerifyStatus('');
    try {
      const user = await ageAttest();
      currentAuthUser = user;
      if (user.trustTier !== 'none') { notifyVerifyResult(user); return; }
      await enterVerifyCardStep();
    } catch (err) {
      setVerifyStatus(err.message || 'Could not confirm age.', 'error');
      verifyContinueBtn.disabled = false;
    }
    return;
  }

  verifyContinueBtn.disabled = true;
  setVerifyStatus('Verifying…');
  try {
    let setupIntentId = null;
    if (!verifyStripeSetup?.simulated) {
      const result = await verifyStripeInstance.confirmCardSetup(verifyStripeSetup.clientSecret, {
        payment_method: { card: verifyCardElement },
      });
      if (result.error) throw new Error(result.error.message || 'Card verification failed.');
      setupIntentId = result.setupIntent.id;
    }
    const user = await confirmCard(setupIntentId);
    currentAuthUser = user;
    notifyVerifyResult(user);
  } catch (err) {
    setVerifyStatus(err.message || 'Card verification failed.', 'error');
    verifyContinueBtn.disabled = false;
  }
});

verifyLogoutBtn.addEventListener('click', async () => {
  verifyLogoutBtn.disabled = true;
  await logOut().catch(() => {});
  currentAuthUser = null;
  verifyLogoutBtn.disabled = false;
  closeVerifyModal();
  notifyVerifyResult(null);
});

// #2862: the alternative this modal's own intro text promises but never
// offered -- same startDiditVerification()/poll flow authVerifyIdBtn below
// already uses, just resolving this modal's own waitForVerifyResult()
// instead of refreshing the Account panel.
verifyIdInsteadBtn.addEventListener('click', async () => {
  setVerifyStatus('');
  verifyIdInsteadBtn.disabled = true;
  try {
    const { url } = await startDiditVerification();
    window.open(url, '_blank', 'noopener');
    setVerifyStatus('Complete verification in the new tab, then come back here.');
    pollDiditVerificationStatus(setVerifyStatus, () => {
      if (currentAuthUser && currentAuthUser.trustTier !== 'none') notifyVerifyResult(currentAuthUser);
    });
  } catch (err) {
    setVerifyStatus(err.message || 'Could not start government-ID verification.', 'error');
  } finally {
    verifyIdInsteadBtn.disabled = false;
  }
});

// Blocks until `user` (already logged in) has cleared the age-attestation
// + credit-card gate above, resolving with the updated, verified user — or
// null if they logged out instead of clearing it (see verifyLogoutBtn).
// Already-verified users resolve immediately without ever showing the
// modal.
export async function requireVerification(user) {
  if (user.ageAttested && user.trustTier !== 'none') return user;
  openVerifyModal(user);
  const result = await waitForVerifyResult();
  closeVerifyModal();
  return result;
}

export let currentAuthUser = null;
export function setCurrentAuthUser(user) {
  currentAuthUser = user;
}
let pendingResetToken = null;
// Resolved by exactly one of: a successful login/signup (notifyAuthResult
// is called with the new user from both submit handlers below), or
// dismissing the modal without either (authCloseBtn calls it with null).
// This is what lets ensureBuilderIdentity/ensureSellerIdentity block on
// "the user just logged in, or gave up" regardless of which of those two
// forms — or neither — they actually used.
let pendingAuthResolvers = [];
function notifyAuthResult(user) {
  const resolvers = pendingAuthResolvers;
  pendingAuthResolvers = [];
  for (const resolve of resolvers) resolve(user);
}
function waitForAuthResult() {
  return new Promise((resolve) => pendingAuthResolvers.push(resolve));
}
const accountAuthBtn = document.getElementById('account-auth-btn');
const authModalEl = document.getElementById('auth-modal');
const authModalTitle = document.getElementById('auth-modal-title');
const authCloseBtn = document.getElementById('auth-close-btn');
const authLoggedOutEl = document.getElementById('auth-logged-out');
const authLoggedInEl = document.getElementById('auth-logged-in');
const authTabBtns = [...document.querySelectorAll('.auth-tab-btn')];
const authForms = {
  login: document.getElementById('auth-login-form'),
  signup: document.getElementById('auth-signup-form'),
  forgot: document.getElementById('auth-forgot-form'),
  reset: document.getElementById('auth-reset-form'),
};
const authStatusEl = document.getElementById('auth-status');
const authAccountEmailEl = document.getElementById('auth-account-email');
const authAccountVerifiedEl = document.getElementById('auth-account-verified');
const authAccountTrustTierEl = document.getElementById('auth-account-trust-tier');
const authVerifyIdBtn = document.getElementById('auth-verify-id-btn');
const authResendVerifyBtn = document.getElementById('auth-resend-verify-btn');
const authLogoutBtn = document.getElementById('auth-logout-btn');

function setAuthStatus(text, type) {
  authStatusEl.textContent = text || '';
  authStatusEl.classList.toggle('error', type === 'error');
  authStatusEl.classList.toggle('success', type === 'success');
}

const AUTH_VIEW_TITLES = {
  login: 'Log In',
  signup: 'Sign Up',
  forgot: 'Reset Password',
  reset: 'Reset Password',
};

// 'reset' is deliberately not one of the tab-switchable views (no
// .auth-tab-btn targets it) — it's only ever entered programmatically, via
// a password-reset email link (see the DOMContentLoaded handler below),
// never something a user taps into on their own.
function showAuthView(view) {
  for (const [name, form] of Object.entries(authForms)) form.hidden = name !== view;
  for (const btn of authTabBtns) {
    btn.classList.toggle('active', btn.dataset.authView === view);
    btn.setAttribute('aria-pressed', String(btn.dataset.authView === view));
  }
  authModalTitle.textContent = AUTH_VIEW_TITLES[view];
  setAuthStatus('');
  // Back to masked every time this view is (re)entered — form.reset()
  // (called after a successful signup) only resets values, not the type
  // attribute a toggle tap changes, so without this the field could still
  // read as plain-text on a later visit despite being empty again.
  setPasswordToggleState(authSignupPasswordInput, authSignupPasswordToggleBtn, false);
  setPasswordToggleState(authLoginPasswordInput, authLoginPasswordToggleBtn, false);
}

// Found via backlog audit (#373): refreshAccountAuthUI's own async fetches
// had no re-entrancy guard, unlike the monotonic load-token pattern used
// everywhere else in this file for an async render that can be called
// again before its own fetch resolves (axisPreviewLoadToken,
// uploadFlowToken, friendsLoadToken above, ...). Reopening the account
// menu quickly, or a login -> logout -> login-as-different-account
// sequence within one round trip, could let an earlier, slower fetch
// resolve after a newer one and overwrite the panel with stale data from
// the wrong request.
let accountAuthLoadToken = 0;

function refreshAccountAuthUI() {
  const myLoadToken = ++accountAuthLoadToken;
  if (currentAuthUser) {
    accountAuthBtn.textContent = currentAuthUser.username;
    authLoggedOutEl.hidden = true;
    authLoggedInEl.hidden = false;
    authModalTitle.textContent = 'Account';
    authAccountEmailEl.textContent = currentAuthUser.email;
    authAccountVerifiedEl.textContent = currentAuthUser.emailVerified ? '✓ Email verified' : 'Email not verified yet';
    authAccountVerifiedEl.classList.toggle('verified', currentAuthUser.emailVerified);
    authResendVerifyBtn.hidden = currentAuthUser.emailVerified;
    // docs/SPEC.md §6, #589 (sub-issue of #556): government-ID
    // verification via Didit is the higher trust tier, above the
    // credit-card tier — only offer the button while there's still
    // somewhere to go (not yet id_verified).
    const trustTierLabels = { none: 'Not ID-verified', credit_card: 'Credit-card verified', id_verified: '✓ ID-verified' };
    authAccountTrustTierEl.textContent = trustTierLabels[currentAuthUser.trustTier] || '';
    authAccountTrustTierEl.classList.toggle('verified', currentAuthUser.trustTier === 'id_verified');
    authVerifyIdBtn.hidden = currentAuthUser.trustTier === 'id_verified';
    // #1067: pollDiditVerificationStatus's own 5-minute-timeout copy
    // promises this "will pick up automatically next time you open your
    // account" — nothing here actually did that until now. Reconciles a
    // stalled-pending session (one the redirect/poll never resolved) the
    // same way pollDiditVerificationStatus itself does, fire-and-forget
    // with the same accountAuthLoadToken re-entrancy guard the rest of
    // this function uses. Cheap when there's nothing pending —
    // handleDiditVerificationStatus no-ops with no outbound Didit call in
    // that case.
    if (currentAuthUser.trustTier !== 'id_verified') {
      fetchDiditVerificationStatus().then(({ status }) => {
        if (myLoadToken !== accountAuthLoadToken) return; // superseded while loading
        if (status === 'approved') refreshCurrentUser();
      }).catch(() => {});
    }
  } else {
    accountAuthBtn.textContent = 'Log In / Sign Up';
    authLoggedOutEl.hidden = false;
    authLoggedInEl.hidden = true;
  }
}

// #1730: armed each time the modal opens, disarmed by a login/signup
// success path right before its own closeAuthModal() call (see those
// handlers below) so this doesn't resolve pendingAuthResolvers with null
// just ahead of the real notifyAuthResult(currentAuthUser) call that
// follows. Everywhere else (Escape, the explicit × button, requireLogin's
// own post-wait close, logout) wants exactly this null-resolution, the same
// one authCloseBtn's handler used to perform by itself -- Escape never did,
// leaving waitForAuthResult() permanently unsettled and wedging every
// subsequent ensureBuilderIdentity/ensureSellerIdentity call for the rest
// of the session. Same fix shape #1679 already applied to the Friends-map/
// DM modal's own Escape gap.
let notifyNullOnAuthModalClose = true;

function openAuthModal(view = 'login') {
  if (!currentAuthUser) showAuthView(view);
  setAuthStatus('');
  notifyNullOnAuthModalClose = true;
  authModalEl.classList.add('visible');
  openModalA11y(authModalEl, closeAuthModal);
}

function closeAuthModal() {
  authModalEl.classList.remove('visible');
  closeModalA11y(authModalEl);
  if (notifyNullOnAuthModalClose) notifyAuthResult(null);
}

async function refreshCurrentUser() {
  // fetchCurrentUser now throws on a genuine backend/network failure
  // instead of returning null for it the same as "really logged out" (the
  // one case /auth/me itself already returns 200/{user: null} for — see
  // that function's own comment). Leaving currentAuthUser untouched on
  // failure means a transient error here can't make an already-logged-in
  // visitor's session appear to vanish; the next successful refresh (a
  // login/signup, or simply reopening this panel) corrects it either way.
  try {
    currentAuthUser = await fetchCurrentUser();
  } catch (err) {
    console.warn('Could not refresh current user:', err);
  }
  refreshAccountAuthUI();
  return currentAuthUser;
}

accountAuthBtn.addEventListener('click', () => {
  // refreshAccountAuthUI's own trust-tier reconciliation fetch only
  // otherwise runs right after a login/signup/logout state change —
  // reopening the panel later without this would keep showing whatever
  // was true at that moment.
  if (currentAuthUser) refreshAccountAuthUI();
  openAuthModal('login');
});
authCloseBtn.addEventListener('click', closeAuthModal);
for (const btn of authTabBtns) {
  btn.addEventListener('click', () => showAuthView(btn.dataset.authView));
}
document.getElementById('auth-forgot-btn').addEventListener('click', () => showAuthView('forgot'));
document.getElementById('auth-forgot-back-btn').addEventListener('click', () => showAuthView('login'));

// Lets a builder double-check what they actually typed into a password
// field, rather than trusting a masked field with no way to catch a typo
// before submitting — an eye/eye-off icon (not a text label, so it reads
// the same regardless of the field's own current language) toggles the
// field between masked and plain text. On login and signup; not on
// reset's new-password field, which is short-lived enough not to need it.
const EYE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>'
  + '<circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.16 13.16 0 0 0 1 11s4 7 11 7a9.16 9.16 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24"/>'
  + '<line x1="1" y1="1" x2="23" y2="23"/></svg>';

function setPasswordToggleState(input, btn, showing) {
  input.type = showing ? 'text' : 'password';
  btn.innerHTML = showing ? EYE_OFF_ICON_SVG : EYE_ICON_SVG;
  const label = showing ? 'Hide password' : 'Show password';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function bindPasswordToggle(input, btn) {
  setPasswordToggleState(input, btn, false);
  btn.addEventListener('click', () => setPasswordToggleState(input, btn, input.type === 'password'));
}

const authSignupPasswordInput = document.getElementById('auth-signup-password');
const authSignupPasswordToggleBtn = document.getElementById('auth-signup-password-toggle');
bindPasswordToggle(authSignupPasswordInput, authSignupPasswordToggleBtn);

const authLoginPasswordInput = document.getElementById('auth-login-password');
const authLoginPasswordToggleBtn = document.getElementById('auth-login-password-toggle');
bindPasswordToggle(authLoginPasswordInput, authLoginPasswordToggleBtn);

// A brief press flash (see .pressed in index.html) on every auth form's
// submit button — these all wait on a network round-trip before anything
// else visibly changes, so without this a tap can read as not having
// registered at all rather than "working on it." Fired immediately on
// submit, not after the request resolves, since it's the tap itself being
// acknowledged, not the outcome.
function flashSubmitPressed(form) {
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 220);
}

authForms.login.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.login);
  const email = document.getElementById('auth-login-email').value;
  const password = document.getElementById('auth-login-password').value;
  setAuthStatus('');
  try {
    currentAuthUser = await logIn({ email, password });
    refreshAccountAuthUI();
    // #1730: disarm before closing -- notifyAuthResult(currentAuthUser)
    // below must be what resolves pendingAuthResolvers, not closeAuthModal's
    // own null-resolution.
    notifyNullOnAuthModalClose = false;
    closeAuthModal();
    authForms.login.reset();
    notifyAuthResult(currentAuthUser);
  } catch (err) {
    setAuthStatus(err.message || 'Could not log in.', 'error');
  }
});

authForms.signup.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.signup);
  const email = document.getElementById('auth-signup-email').value;
  const password = document.getElementById('auth-signup-password').value;
  const username = document.getElementById('auth-signup-username').value.trim();
  const ageAttested = document.getElementById('auth-signup-age-attest').checked;
  setAuthStatus('');
  try {
    const result = await signUp({ email, password, username, ageAttested });
    currentAuthUser = result.user;
    refreshAccountAuthUI();
    authForms.signup.reset();
    // devVerifyUrl only ever appears when no real email provider is
    // configured (see sendEmail's own comment) — surfacing it here is what
    // keeps this whole flow testable/usable in that dev-mode case, exactly
    // the way the backend's own dev-mode fallback is meant to be used.
    if (result.devVerifyUrl) {
      setAuthStatus(`Account created! (dev mode, no email configured) Verify at: ${result.devVerifyUrl}`, 'success');
    } else if (!result.verificationEmailSent) {
      // #1451: devVerifyUrl is dev-mode-only (#811) -- a real production
      // Resend failure shows up here instead, as verificationEmailSent:
      // false, and was previously never checked, silently closing the
      // modal as if the email had gone out.
      setAuthStatus('Account created, but the verification email failed to send — use "Resend verification email" from your account menu.', 'error');
    } else {
      // #1730: same disarm as the login handler above -- the real
      // notifyAuthResult(currentAuthUser) call just below must be what
      // resolves pendingAuthResolvers.
      notifyNullOnAuthModalClose = false;
      closeAuthModal();
    }
    // Notified regardless of whether the modal itself just closed —
    // requireLogin (ensureBuilderIdentity/ensureSellerIdentity's own gate)
    // closes it unconditionally once resolved, since the dev-mode status
    // message above would otherwise sit on top of the claim/build UI this
    // unblocks.
    notifyAuthResult(currentAuthUser);
  } catch (err) {
    setAuthStatus(err.message || 'Could not sign up.', 'error');
  }
});

authForms.forgot.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.forgot);
  const email = document.getElementById('auth-forgot-email').value;
  setAuthStatus('');
  try {
    const result = await requestPasswordReset(email);
    authForms.forgot.reset();
    setAuthStatus(
      result.devResetUrl
        ? `If that email has an account, a reset link was sent. (dev mode: ${result.devResetUrl})`
        : 'If that email has an account, a reset link was sent.',
      'success',
    );
  } catch (err) {
    setAuthStatus(err.message || 'Could not request a password reset.', 'error');
  }
});

authForms.reset.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authForms.reset);
  const newPassword = document.getElementById('auth-reset-password').value;
  setAuthStatus('');
  try {
    await resetPassword(pendingResetToken, newPassword);
    pendingResetToken = null;
    authForms.reset.reset();
    // Order matters: showAuthView clears #auth-status itself (a plain view
    // switch shouldn't carry over a stale message from whatever view came
    // before it), so the real success message has to be set after it, not
    // before.
    showAuthView('login');
    setAuthStatus('Password reset! You can log in with your new password now.', 'success');
  } catch (err) {
    setAuthStatus(err.message || 'Could not reset the password.', 'error');
  }
});

authResendVerifyBtn.addEventListener('click', async () => {
  setAuthStatus('');
  try {
    const result = await resendVerificationEmail();
    if (result.devVerifyUrl) {
      setAuthStatus(`Verification email sent. (dev mode: ${result.devVerifyUrl})`, 'success');
    } else if (!result.verificationEmailSent) {
      // #1451: same real-Resend-failure gap as the signup handler above.
      setAuthStatus('Could not send the verification email — please try again in a moment.', 'error');
    } else {
      setAuthStatus('Verification email sent.', 'success');
    }
  } catch (err) {
    setAuthStatus(err.message || 'Could not resend the verification email.', 'error');
  }
});

// docs/SPEC.md §6, #589 (sub-issue of #556): government-ID verification
// via Didit is a hosted flow in a separate tab, not an in-page form — this
// tab has no way to know when the builder finishes it there except by
// asking. Polls a bounded number of times rather than forever, so an
// abandoned verification (tab closed, never finished) doesn't leave a
// background timer running indefinitely; reopening the account panel and
// clicking the button again always starts a fresh poll regardless.
let diditPollTimer = null;

function stopDiditPoll() {
  if (diditPollTimer !== null) {
    clearTimeout(diditPollTimer);
    diditPollTimer = null;
  }
}

// #2862: setStatusFn/onApproved parameterize this for verifyIdInsteadBtn's
// own call site below, which polls into #verify-modal's own status line and
// resolves that modal's waitForVerifyResult() instead of just refreshing the
// Account panel -- onApproved defaults to a no-op since refreshCurrentUser()
// already calls refreshAccountAuthUI() internally, which is all the original
// authVerifyIdBtn call site below ever needed.
async function pollDiditVerificationStatus(setStatusFn = setAuthStatus, onApproved = () => {}) {
  stopDiditPoll();
  const intervalMs = 3000;
  const deadline = Date.now() + 5 * 60 * 1000;
  const tick = async () => {
    diditPollTimer = null;
    try {
      const { status } = await fetchDiditVerificationStatus();
      if (status === 'approved') {
        await refreshCurrentUser();
        setStatusFn('Government-ID verification approved!', 'success');
        onApproved();
        return;
      }
      if (status === 'declined') {
        setStatusFn('Government-ID verification was declined — you can try again.', 'error');
        return;
      }
    } catch (err) {
      // #2405: a 401 here means this browser's session ended (or never
      // existed, e.g. the Didit mobile-handoff return landing in a
      // different browser) -- not a transient blip, and retrying it for
      // the full 5 minutes never resolves since no session means the
      // builder's real status can't be fetched from here. Stop and ask
      // for a login instead of looking stuck.
      if (err.status === 401) {
        setStatusFn('Log in to check your verification status.');
        return;
      }
      // Any other failure shouldn't give up outright — keep polling
      // until the deadline, the same "best-effort background refresh"
      // spirit as refreshAccountAuthUI's own trust-tier fetch.
      console.warn('Could not check Didit verification status:', err);
    }
    if (Date.now() >= deadline) {
      setStatusFn('Still waiting on verification — this will pick up automatically next time you open your account.', '');
      return;
    }
    diditPollTimer = setTimeout(tick, intervalMs);
  };
  await tick();
}

authVerifyIdBtn.addEventListener('click', async () => {
  setAuthStatus('');
  try {
    const { url } = await startDiditVerification();
    window.open(url, '_blank', 'noopener');
    setAuthStatus('Complete verification in the new tab, then come back here.');
    pollDiditVerificationStatus();
  } catch (err) {
    setAuthStatus(err.message || 'Could not start government-ID verification.', 'error');
  }
});

// #432: shared by logout and delete-account below — both end this
// browser's session identically (no more currentAuthUser, no more cached
// builder/seller identity), and both need the exact same reset or the
// *next* login in this tab can inherit a previous account's cached
// sellerId (see #432's own history: ensureSellerIdentity's own
// `if (sellerId) return sellerId` short-circuit would otherwise hand the
// next logged-in account's Sell tab the previous account's private "My
// Products" listing).
function resetLocalSessionState() {
  currentAuthUser = null;
  setBuilderId(null);
  setSellerId(null);
  resetIdentityFlowPromises();
}

// #2754: every account-scoped mode below always reloads on logout/
// deletion now (Shop included), so a status message set just before that
// reload would otherwise never be seen — the reload replaces the page
// before anything could render it. Carried across via sessionStorage (the
// same "survive one reload, consumed once" shape START_MODE_KEY already
// uses) and shown once authInitPromise's own default branch below settles
// on the fresh page.
const PENDING_AUTH_STATUS_KEY = 'higglehaven.pendingAuthStatus';

// Build, Sell, and layout-preview all require a real, logged-in account
// (ensureBuilderIdentity/ensureSellerIdentity's own login walls) — staying
// on any of them once that account is gone would just immediately reprompt
// the login modal over whatever was on screen (or, for Sell/layout-preview,
// strand the now-stale showcase/modal with no identity behind it). A reload
// is the same clean-slate escape hatch #mode-nav's own mode switching
// already uses (see its own comment).
//
// #2754: Shop used to be excluded here on the theory that it "needs no
// account at all, so it's always a safe place to land" — true before N44,
// false since: enterShopMode() (src/shop/mode.js) now gates its own entry
// on ensureShopperIdentity() the same as Build/Sell, and is explicitly
// re-enterable without a reload (its own opening comment) specifically so
// Identity -> Shop doesn't need one. That re-entrancy is exactly what bit
// here — nothing ever re-runs it on logout/account-switch, so the previous
// account's avatar mesh, camera position, and loaded landlet content were
// left rendered under the next, possibly-unverified account. Reloading
// Shop too, same as the other three, forces a completely fresh
// enterShopMode() run (and the real login/verification gate with it) for
// whoever's on screen next, with no path left where a mode is "always
// safe to land on without reinitializing" — Shop included.
// Returns whether it reloaded (the caller's own post-logout/-deletion UI
// update is moot if so).
function leaveAccountScopedModeIfNeeded() {
  if (currentMode === 'build' || currentMode === 'sell' || currentMode === 'layoutPreview' || currentMode === 'shop') {
    sessionStorage.setItem(START_MODE_KEY, 'shop');
    location.reload();
    return true;
  }
  return false;
}

authLogoutBtn.addEventListener('click', async () => {
  stopDiditPoll();
  // The button gave zero feedback while the request was in flight —
  // nothing to distinguish a slow network from an unregistered click.
  // Mirrors claimConfirmBtn's own disable-plus-status-text pattern. Reset
  // unconditionally right after, rather than only on the non-reload path:
  // this is the same persistent DOM button across logins within one tab
  // (refreshAccountAuthUI only toggles #auth-logged-in's `hidden`, never
  // touches `disabled`), so leaving it disabled on the Build-mode reload
  // path would still matter if that reload ever stopped happening, and
  // costs nothing when it does.
  authLogoutBtn.disabled = true;
  setAuthStatus('Logging out…');
  try {
    await logOut();
  } catch {
    // Best-effort — the cookie is cleared client-side visibility regardless
    // once currentAuthUser is nulled out below, even if the network call
    // itself failed.
  }
  authLogoutBtn.disabled = false;
  resetLocalSessionState();
  if (leaveAccountScopedModeIfNeeded()) return;
  refreshAccountAuthUI();
  closeAuthModal();
});

// #1182 (sub-issue of #1126): in-session change-email form, collapsed
// behind its own trigger the same way delete-account is below — not
// because it's irreversible, but to keep the logged-in panel's default
// view uncluttered, matching the existing pattern for any action beyond
// the always-visible ones.
const authChangeEmailBtn = document.getElementById('auth-change-email-btn');
const authChangeEmailForm = document.getElementById('auth-change-email-form');
const authChangeEmailNewInput = document.getElementById('auth-change-email-new');
const authChangeEmailPasswordInput = document.getElementById('auth-change-email-password');
const authChangeEmailPasswordToggleBtn = document.getElementById('auth-change-email-password-toggle');
const authChangeEmailCancelBtn = document.getElementById('auth-change-email-cancel-btn');
bindPasswordToggle(authChangeEmailPasswordInput, authChangeEmailPasswordToggleBtn);

function closeChangeEmailForm() {
  authChangeEmailForm.hidden = true;
  authChangeEmailBtn.hidden = false;
  authChangeEmailForm.reset();
  setPasswordToggleState(authChangeEmailPasswordInput, authChangeEmailPasswordToggleBtn, false);
}

authChangeEmailBtn.addEventListener('click', () => {
  setAuthStatus('');
  authChangeEmailBtn.hidden = true;
  authChangeEmailForm.hidden = false;
  authChangeEmailNewInput.focus();
});
authChangeEmailCancelBtn.addEventListener('click', () => {
  closeChangeEmailForm();
  setAuthStatus('');
});

authChangeEmailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authChangeEmailForm);
  const newEmail = authChangeEmailNewInput.value;
  const password = authChangeEmailPasswordInput.value;
  const submitBtn = authChangeEmailForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  setAuthStatus('Changing your email…');
  try {
    const result = await changeEmail(password, newEmail);
    currentAuthUser = result.user;
    refreshAccountAuthUI();
    closeChangeEmailForm();
    // devVerifyUrl mirrors the signup handler's own dev-mode fallback
    // above — only present when no real email provider is configured.
    if (result.devVerifyUrl) {
      setAuthStatus(`Email changed! (dev mode, no email configured) Verify at: ${result.devVerifyUrl}`, 'success');
    } else if (!result.verificationEmailSent) {
      // #1451: same real-Resend-failure gap as the signup handler above.
      setAuthStatus('Email changed, but the verification email failed to send — use "Resend verification email" from your account menu.', 'error');
    } else {
      setAuthStatus('Email changed! Check your inbox to verify it.', 'success');
    }
  } catch (err) {
    setAuthStatus(err.message || 'Could not change your email.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// #1987 (sub-issue of #1983): triggers a browser download of the
// GET /auth/export-data JSON bundle via a Blob/URL.createObjectURL link
// -- no server-side file storage needed, same as extractVideoFrames'
// own createObjectURL usage above, just for a download instead of
// playback.
const authExportDataBtn = document.getElementById('auth-export-data-btn');
authExportDataBtn.addEventListener('click', async () => {
  authExportDataBtn.disabled = true;
  setAuthStatus('Preparing your data…');
  try {
    const data = await exportMyData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `higglehaven-data-export-${data.exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setAuthStatus('Your data export has started downloading.', 'success');
  } catch (err) {
    setAuthStatus(err.message || 'Could not export your data.', 'error');
  } finally {
    authExportDataBtn.disabled = false;
  }
});

const authDeleteAccountBtn = document.getElementById('auth-delete-account-btn');
const authDeleteAccountForm = document.getElementById('auth-delete-account-form');
const authDeleteAccountPasswordInput = document.getElementById('auth-delete-account-password');
const authDeleteAccountPasswordToggleBtn = document.getElementById('auth-delete-account-password-toggle');
const authDeleteAccountCancelBtn = document.getElementById('auth-delete-account-cancel-btn');
bindPasswordToggle(authDeleteAccountPasswordInput, authDeleteAccountPasswordToggleBtn);

function closeDeleteAccountForm() {
  authDeleteAccountForm.hidden = true;
  authDeleteAccountBtn.hidden = false;
  authDeleteAccountForm.reset();
  setPasswordToggleState(authDeleteAccountPasswordInput, authDeleteAccountPasswordToggleBtn, false);
}

// Collapsed behind its own trigger rather than a single click straight
// into the confirmation — this is the one action in this whole panel that
// really can't be undone.
authDeleteAccountBtn.addEventListener('click', () => {
  setAuthStatus('');
  authDeleteAccountBtn.hidden = true;
  authDeleteAccountForm.hidden = false;
  authDeleteAccountPasswordInput.focus();
});
authDeleteAccountCancelBtn.addEventListener('click', () => {
  closeDeleteAccountForm();
  setAuthStatus('');
});

authDeleteAccountForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authDeleteAccountForm);
  const password = authDeleteAccountPasswordInput.value;
  const submitBtn = authDeleteAccountForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  setAuthStatus('Deleting your account…');
  // #1771: set before the await, not after -- see hasVerifiedSession's own
  // comment (src/main.js) for why.
  setAccountSessionEnding(true);
  try {
    await deleteAccount(password);
  } catch (err) {
    setAccountSessionEnding(false);
    submitBtn.disabled = false;
    setAuthStatus(err.message || 'Could not delete your account.', 'error');
    return;
  }
  submitBtn.disabled = false;
  stopDiditPoll();
  closeDeleteAccountForm();
  resetLocalSessionState();
  // #2754: every currentMode this handler can run from now reloads (Shop
  // included) — set this *before* the reload, not after, so it survives
  // it; see PENDING_AUTH_STATUS_KEY's own comment.
  const deletedMessage = 'Your account has been deleted. You have been signed out.';
  sessionStorage.setItem(PENDING_AUTH_STATUS_KEY, JSON.stringify({ message: deletedMessage, type: 'success' }));
  if (leaveAccountScopedModeIfNeeded()) return;
  // No mode above actually needed the reload (shouldn't happen given the
  // four currentMode values above are the only ones this app ever sets,
  // but kept as a fallback rather than assuming it) — nothing will ever
  // consume the stored message now, so show it directly instead, same as
  // before #2754. Deliberately left open (unlike logout's own
  // closeAuthModal()) so this confirmation is actually seen —
  // refreshAccountAuthUI already flips the panel back to the logged-out
  // login/signup view underneath it.
  sessionStorage.removeItem(PENDING_AUTH_STATUS_KEY);
  refreshAccountAuthUI();
  setAuthStatus(deletedMessage, 'success');
});

const authChangePasswordBtn = document.getElementById('auth-change-password-btn');
const authChangePasswordForm = document.getElementById('auth-change-password-form');
const authChangePasswordCurrentInput = document.getElementById('auth-change-password-current');
const authChangePasswordCurrentToggleBtn = document.getElementById('auth-change-password-current-toggle');
const authChangePasswordNewInput = document.getElementById('auth-change-password-new');
const authChangePasswordNewToggleBtn = document.getElementById('auth-change-password-new-toggle');
const authChangePasswordCancelBtn = document.getElementById('auth-change-password-cancel-btn');
bindPasswordToggle(authChangePasswordCurrentInput, authChangePasswordCurrentToggleBtn);
bindPasswordToggle(authChangePasswordNewInput, authChangePasswordNewToggleBtn);

function closeChangePasswordForm() {
  authChangePasswordForm.hidden = true;
  authChangePasswordBtn.hidden = false;
  authChangePasswordForm.reset();
  setPasswordToggleState(authChangePasswordCurrentInput, authChangePasswordCurrentToggleBtn, false);
  setPasswordToggleState(authChangePasswordNewInput, authChangePasswordNewToggleBtn, false);
}

// Same collapsed-behind-its-own-trigger shape as Delete Account above.
authChangePasswordBtn.addEventListener('click', () => {
  setAuthStatus('');
  authChangePasswordBtn.hidden = true;
  authChangePasswordForm.hidden = false;
  authChangePasswordCurrentInput.focus();
});
authChangePasswordCancelBtn.addEventListener('click', () => {
  closeChangePasswordForm();
  setAuthStatus('');
});

authChangePasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  flashSubmitPressed(authChangePasswordForm);
  const currentPassword = authChangePasswordCurrentInput.value;
  const newPassword = authChangePasswordNewInput.value;
  const submitBtn = authChangePasswordForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  setAuthStatus('Changing your password…');
  try {
    await changePassword(currentPassword, newPassword);
  } catch (err) {
    submitBtn.disabled = false;
    setAuthStatus(err.message || 'Could not change your password.', 'error');
    return;
  }
  submitBtn.disabled = false;
  closeChangePasswordForm();
  setAuthStatus('Your password has been changed. You have been signed out of your other devices.', 'success');
});

// A verify-email or reset-password link (see issueEmailVerification/
// handleRequestPasswordReset in worker/index.js) lands back on this same
// page with a query param carrying the token — handled once, up front,
// then stripped from the URL so a page refresh doesn't replay it. Also
// where currentAuthUser first gets resolved on every page load — stored
// as authInitPromise (rather than left as a bare fire-and-forget IIFE) so
// bootstrap() (src/main.js) can await it before checking currentAuthUser
// itself. Without that, a fresh page load with an already-valid session
// cookie would race: bootstrap()'s own ensureBuilderIdentity check runs
// synchronously, reaching `if (currentAuthUser) ...` before this
// function's GET /api/auth/me round trip could possibly have resolved,
// wrongly popping the login modal open over a session that was actually
// fine (caught via a real reload-while-logged-in-and-in-Build-mode e2e
// scenario, not something a fresh-every-time page load would ever surface
// on its own).
// #454: a buyer confirming delivery (src/main.js's own module-load IIFE
// for ?confirmDelivery=) has no account here at all and is entirely
// independent of this promise, which is specifically about this browser's
// own login/session state.

// N44: set before any of this promise's own async work below, so
// enterShopMode (src/main.js, which awaits authInitPromise before running
// its own shopper-login gate) can tell whether this load is one of these
// special account-recovery flows the moment the promise settles, without
// re-parsing a URL this same IIFE already strips the token from. Shop
// mode's gate skips itself entirely in that case — see enterShopMode's own
// comment for why forcing it on top here would actively get in the way,
// not just look redundant.
export let accountRecoveryFlowActive = false;

export const authInitPromise = (async () => {
  const params = new URLSearchParams(location.search);
  const verifyToken = params.get('verifyEmail');
  const resetToken = params.get('resetPassword');
  // #589: the return leg of the Didit-hosted verification flow — Didit
  // redirects back here once a builder finishes (or abandons) it there.
  const diditReturn = params.get('diditReturn');
  // #2754: a message set by leaveAccountScopedModeIfNeeded's own reload
  // (right now, only the delete-account handler ever sets one) — treated
  // as one more reason this load needs the accountRecoveryFlowActive
  // treatment below, same as verifyToken/resetToken/diditReturn: without
  // it, Shop mode's own ensureShopperIdentity gate (which runs right after
  // this promise settles, since the reload that carried this message here
  // always lands back on Shop) would open its own modal on top of this
  // one and clear the very message this is about to show.
  const pendingStatusRaw = sessionStorage.getItem(PENDING_AUTH_STATUS_KEY);
  if (!verifyToken && !resetToken && !diditReturn && !pendingStatusRaw) {
    await refreshCurrentUser();
    return;
  }
  accountRecoveryFlowActive = true;

  history.replaceState(null, '', location.pathname);
  await refreshCurrentUser();

  if (pendingStatusRaw) {
    sessionStorage.removeItem(PENDING_AUTH_STATUS_KEY);
    const { message, type } = JSON.parse(pendingStatusRaw);
    openAuthModal('login');
    setAuthStatus(message, type);
  } else if (verifyToken) {
    try {
      await verifyEmail(verifyToken);
      await refreshCurrentUser();
      openAuthModal('login');
      setAuthStatus('Email verified!', 'success');
    } catch (err) {
      openAuthModal('login');
      setAuthStatus(err.message || 'That verification link is invalid or has expired.', 'error');
    }
  } else if (diditReturn) {
    // refreshCurrentUser() above already re-rendered the account panel if
    // this browser has an active session; openAuthModal only needs to
    // actually show it (a fresh page load starts with the modal closed).
    openAuthModal();
    // #2405: Didit's hosted flow supports a "continue on your phone" QR
    // handoff, so this return leg can land in a browser/device with no
    // session for the account that started verification. Polling a
    // session-gated endpoint from there just 401s on every tick for 5
    // minutes behind a login form — tell the user to log in instead of
    // pretending a check is actually happening.
    if (!currentAuthUser) {
      setAuthStatus('Log in to check your verification status.');
    } else {
      setAuthStatus('Checking verification status…');
      await pollDiditVerificationStatus();
    }
  } else if (resetToken) {
    pendingResetToken = resetToken;
    // Forced to the logged-out form view even if this browser happens to
    // have an active session — resetting a password is about whichever
    // account the token itself identifies, not necessarily the one
    // currently logged in here, so it should never be hidden behind
    // refreshAccountAuthUI's "you're logged in" panel.
    authLoggedOutEl.hidden = false;
    authLoggedInEl.hidden = true;
    authModalEl.classList.add('visible');
    openModalA11y(authModalEl, closeAuthModal);
    showAuthView('reset');
  }
})();
