// #3303: a short, in-memory list of the last few error/refusal strings a
// person was actually shown, so a bug report carries the exact words even when
// they could not copy them (the owner hit a Group refusal on a phone and could
// not send the text on). Dependency-free so it stays in the plain
// src/**/*.test.js pool. Recorded by whichever surface shows an error or
// refusal (see showSelectionActionStatus in src/build/scene.js) and read by
// src/feedback/submitFeedbackUI.js.
const MAX_MESSAGES = 5;
const MAX_LENGTH = 500;

let messages = [];

export function recordVisibleMessage(text) {
  const trimmed = String(text ?? '').trim().slice(0, MAX_LENGTH);
  if (!trimmed) return;
  // The same refusal shown twice in a row is one thing the person saw.
  if (messages.length && messages[messages.length - 1].text === trimmed) return;
  messages.push({ text: trimmed, shownAt: new Date().toISOString() });
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
}

export function getRecentVisibleMessages() {
  return messages.map((entry) => ({ ...entry }));
}

export function clearRecentVisibleMessages() {
  messages = [];
}
