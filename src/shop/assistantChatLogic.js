// #3447 (part of #3444): the pure rules behind the assistant chat panel
// (src/shop/assistantChat.js), kept apart so they can be unit tested without a
// DOM. Nothing here knows a limit: every number (how long a reply may take, how
// many messages a shopper may send) arrives in the server's reply.

// Merges polled messages into what the panel already shows, by the server's
// `seq`, so a message that arrives twice (a poll racing a send) shows once.
export function mergeMessages(existing, incoming) {
  const bySeq = new Map(existing.map((message) => [message.seq, message]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// Where the latest question stands: 'none' when the assistant has answered it
// (or nothing was asked), 'reading' while the assistant has it, 'slow' once it
// has waited `replyWaitSeconds` with no reply.
export function replyState({ messages, nowMs, replyWaitSeconds }) {
  const last = messages[messages.length - 1];
  if (!last || last.sender !== 'shopper') return 'none';
  const waitedMs = nowMs - Date.parse(last.createdAt);
  return waitedMs >= replyWaitSeconds * 1000 ? 'slow' : 'reading';
}

// What the panel says when a conversation is over, in a shopper's words.
export function endedNotice({ endedBy }, name) {
  if (endedBy === 'assistant') return `${name} ended the conversation.`;
  if (endedBy === 'timeout') return 'This conversation timed out because nobody wrote for a while.';
  return 'This conversation has ended.';
}

export function readingNotice(name) {
  return `${name} is reading your message…`;
}

export function slowNotice(name) {
  return `${name} hasn't answered yet and may be busy. You can keep waiting, or close this and try again later.`;
}

export function offShiftNotice(name) {
  return `${name} isn't on shift right now.`;
}

// The one line shown at the start of a fresh conversation. The label above an
// assistant already says "assistant"; this says what that means.
export function disclosureText(name) {
  return `${name} is an AI assistant. It can help with questions about the world. For anything about money, an order, or an account, it will tell you what happens next and pass it to the team.`;
}
