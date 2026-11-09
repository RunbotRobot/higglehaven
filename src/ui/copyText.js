// #3303 (owner decision: any text a user can read, they can copy). The one
// "copy this text and show it worked" behaviour, shared by every Copy control
// so there is a single copy affordance: the button's own label flips to
// "Copied!" (or "Couldn't copy" where the clipboard is unavailable, e.g. an
// insecure context or a denied permission) and back after a moment. First used
// by the admin camera readout (#camera-debug-copy); the Group/orb notices
// reuse it.
const RESET_MS = 1200;

export async function copyTextWithFeedback(button, text, { label = 'Copy' } = {}) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
    button.textContent = 'Copied!';
  } catch {
    button.textContent = "Couldn't copy";
  }
  setTimeout(() => {
    button.textContent = label;
  }, RESET_MS);
  return copied;
}
