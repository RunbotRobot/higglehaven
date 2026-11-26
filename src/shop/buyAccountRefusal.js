// #4461: what a 401 or a "verification required" 403 on Buy means to the person, and the step that clears it.
// Only requests made before a payment exists can answer these (the quote and the purchase request), so "you were
// not charged" is true for both. Import-free so it can be tested without the DOM; productCheckout.js passes the
// real account functions.
export function buyTimeAccountRefusal(err, { requireLogin, requireVerification, currentAuthUser, setCurrentAuthUser }) {
  if (err?.status === 401) {
    return {
      message: 'Your session ended, so nothing was bought. You were not charged. Sign in again to buy this.',
      fix: async () => {
        setCurrentAuthUser(null); // the session is gone on the server; do not let requireLogin trust the stale user
        await requireLogin('login', 'Your session ended. Sign in to keep shopping.');
      },
    };
  }
  if (err?.status === 403 && err.body?.verificationRequired) {
    return {
      message: 'Verify your age and add a card before buying. You were not charged.',
      fix: async () => {
        const user = currentAuthUser();
        if (user) await requireVerification(user);
      },
    };
  }
  return null;
}
