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

// #3448: shown when a conversation was passed from one assistant to another, so
// the shopper knows who they are talking to now and that nothing has to be
// repeated. Null when it was never handed over.
export function handoverNotice(conversation) {
  const handedOver = conversation?.handedOver;
  const to = conversation?.assistant?.name;
  if (!handedOver || !to) return null;
  return handedOver.fromName
    ? `${handedOver.fromName} passed your conversation to ${to}, who can see everything you wrote.`
    : `Your conversation was passed to ${to}, who can see everything you wrote.`;
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

// #3448: when the assistant a shopper asked is busy or off shift, the server
// names one who is free (error body `freeAssistant`). Returns who to offer, or
// null when it named nobody or sent something unusable.
export function freeAssistantOffer(body) {
  const free = body && body.freeAssistant;
  if (!free || typeof free.userId !== 'string' || !free.userId) return null;
  if (typeof free.name !== 'string' || !free.name) return null;
  return { userId: free.userId, name: free.name };
}

export function offerLabel(name) {
  return `${name} is free. Talk to ${name} instead`;
}

// #3448: when no assistant is free, a shopper can leave the question instead.
// The server's refusal says which case it was (busy, or off shift); anything
// else (a block, the adult-only gate, a rate limit) is not a reason to offer it.
export function canLeaveQuestion(body) {
  return Boolean(body) && (body.assistantBusy === true || body.assistantOnShift === false);
}

export const leaveLabel = 'Leave my question for the assistants';
export const withdrawLabel = 'Take my question back';
export const doneLabel = 'Done';

const isInLine = (question) => question.status === 'waiting' || question.status === 'claimed';
export const questionInLine = isInLine;

// What the panel says about a left question, in a shopper's words. Every number
// (the place in line, how many days it is kept, how many assistants are on the
// floor) arrives in the server's reply; nothing is a second copy of a limit.
export function questionNotice(question, { keptDays, assistantsOnShift }) {
  if (question.status === 'expired') {
    return `Nobody answered your question within ${keptDays} days. You can ask again.`;
  }
  if (!isInLine(question)) return '';
  const place = question.status === 'claimed'
    ? 'An assistant is reading your question.'
    : `You're number ${question.position} in line.`;
  const floor = assistantsOnShift === 0 ? ' No assistant is on the floor right now, so this may take a while.' : '';
  return `${place}${floor} You can close this and your place is kept: you'll get a notification when it's answered. Questions are kept for ${keptDays} days.`;
}
