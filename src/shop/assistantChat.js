// #3447 (part of #3444): the panel a shopper gets on tapping an assistant in
// the world. The server's side is worker/lib/assistant-chat.js; the rules about
// what the panel says live in assistantChatLogic.js (unit tested). Every number
// shown or waited on (how long a reply may take) comes from the server's reply.
//
// One person at a time, by design: an assistant that is busy or off shift says
// so in the shopper's own words (the server's message, shown as it came) and the
// panel stays open. Text is selectable and errors stay until the next action
// ("Any text a user can read, they can copy"). The close button is in the upper
// right and ends the conversation, so an assistant is never left waiting on
// someone who walked away.
import {
  startAssistantChat, fetchAssistantChat, sendAssistantChat, endAssistantChat,
  leaveAssistantQuestion, fetchAssistantQuestion, closeAssistantQuestion,
} from '../api.js';
import { confirmAndBlockPerson } from '../blocks.js';
import {
  mergeMessages, replyState, endedNotice, readingNotice, slowNotice, offShiftNotice, disclosureText, freeAssistantOffer, handoverNotice, offerLabel,
  canLeaveQuestion, questionNotice, questionInLine, leaveLabel, withdrawLabel, pillLabel, hasNewAssistantMessage, chatPollIntervalMs,
  keyboardInset, threadRows,
} from './assistantChatLogic.js';

// A left question is not a live chat, so it is checked less often.
const QUESTION_POLL_INTERVAL_MS = 5000;

const panelEl = document.getElementById('assistant-chat-panel');
const nameEl = document.getElementById('assistant-chat-name');
const closeEl = document.getElementById('assistant-chat-close');
const blockEl = document.getElementById('assistant-chat-block');
const minimizeEl = document.getElementById('assistant-chat-minimize');
const pillEl = document.getElementById('assistant-chat-pill');
const offerEl = document.getElementById('assistant-chat-offer');
const leaveEl = document.getElementById('assistant-chat-leave');
const withdrawEl = document.getElementById('assistant-chat-withdraw');
const logEl = document.getElementById('assistant-chat-log');
const statusEl = document.getElementById('assistant-chat-status');
const formEl = document.getElementById('assistant-chat-form');
const inputEl = document.getElementById('assistant-chat-input');
const sendEl = document.getElementById('assistant-chat-send');

let assistant = null; // { userId, builderId, name } of whoever the panel is for
let conversation = null; // the server's open conversation, or null
let messages = [];
let history = []; // #3624: the earlier part of the thread, from the server's first load
let replyWaitSeconds = 90; // replaced by the server's number on every reply
let assistantOnShift = true;
let endedText = null; // why the last conversation ended, shown until the next send
let errorText = null; // the last failed action's message, shown until the next action
let offer = null; // a free assistant the server named after a busy/off-shift refusal (#3448)
let question = null; // #3448: the shopper's left question (the server's view), or null
let keptDays = 7; // replaced by the server's number on every reply
let assistantsOnShift = null; // how many are on the floor; from the server
let canLeave = false; // the last refusal said an assistant was busy or off shift
let minimized = false; // #3529: the panel is tucked away as a pill; the conversation stays open
let unread = false; // #3529: a reply arrived while minimised
let pollTimer = null;
let questionTimer = null;
let inFlight = false;
let openToken = 0; // a stale open() must not write into a newer one

// #3608: with the phone keyboard up, the panel drops to just above it and is
// never taller than what is visible, so its header (title, minimise, close)
// stays on screen. Android Chrome and iOS Safari shrink only the *visual*
// viewport for the keyboard, and report it through visualViewport; the CSS
// reads the two numbers set here. "Typing" means the text box is focused AND
// the visible area really is smaller than the page (a focused box with no
// keyboard, as on a desktop, changes nothing). Moving and looking do not happen
// while typing, so the panel need not clear the Shop controls then. A browser
// that resizes the page itself for the keyboard needs none of this: the CSS
// height cap (dvh) already keeps the header in view.
let inputFocused = false;
function syncVisibleArea() {
  const vv = window.visualViewport;
  const inset = vv ? keyboardInset({ innerHeight: window.innerHeight, visualHeight: vv.height, visualOffsetTop: vv.offsetTop }) : 0;
  const visible = vv ? Math.round(vv.height) : window.innerHeight;
  panelEl.style.setProperty('--assistant-kb-inset', `${inset}px`);
  panelEl.style.setProperty('--assistant-visible-height', `${visible}px`);
  panelEl.classList.toggle('typing', inputFocused && inset > 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncVisibleArea);
  window.visualViewport.addEventListener('scroll', syncVisibleArea);
}
inputEl.addEventListener('focus', () => {
  inputFocused = true;
  syncVisibleArea();
});
inputEl.addEventListener('blur', (event) => {
  // Tapping Send or another control in the panel keeps the panel where it is.
  if (event.relatedTarget && panelEl.contains(event.relatedTarget)) return;
  inputFocused = false;
  syncVisibleArea();
});

const isOpen = () => !panelEl.hidden;
const conversationOpen = () => conversation !== null && conversation.status === 'open';

function renderStatus() {
  let text = '';
  let isError = false;
  if (errorText) {
    text = errorText;
    isError = true;
  } else if (question) {
    text = questionNotice(question, { keptDays, assistantsOnShift });
  } else if (conversationOpen()) {
    const state = replyState({ messages, nowMs: Date.now(), replyWaitSeconds });
    if (!assistantOnShift) text = offShiftNotice(assistant.name);
    else if (state === 'reading') text = readingNotice(assistant.name);
    else if (state === 'slow') text = slowNotice(assistant.name);
  } else if (endedText) {
    text = endedText;
  }
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function appendRow(name, body, sender) {
  const row = document.createElement('div');
  row.className = `assistant-chat-message ${sender}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name;
  const text = document.createElement('span');
  text.textContent = body;
  row.append(who, text);
  logEl.append(row);
}

function renderLog() {
  logEl.replaceChildren();
  // #3624: one thread. What was said before comes first, oldest at the top.
  for (const row of threadRows(history, question, assistant?.name)) appendRow(row.name, row.text, row.sender);
  if (question) {
    appendRow('You', question.text, 'shopper');
    if (question.answer) appendRow(question.answer.assistantName || 'An assistant', question.answer.text, 'assistant');
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }
  if (!assistant) return;
  if (messages.length === 0 && history.length === 0 && !conversationOpen()) {
    const note = document.createElement('div');
    note.className = 'assistant-chat-note';
    note.textContent = disclosureText(assistant.name);
    logEl.append(note);
  }
  // #3448: once the conversation has been passed on, say so above the log.
  const handed = conversationOpen() ? handoverNotice(conversation) : null;
  if (handed) {
    const note = document.createElement('div');
    note.className = 'assistant-chat-note';
    note.textContent = handed;
    logEl.append(note);
  }
  for (const message of messages) {
    // A reply names the assistant who wrote it (a conversation can pass between
    // assistants); older rows fall back to the one in the panel.
    appendRow(message.sender === 'shopper' ? 'You' : (message.authorName || assistant.name), message.text, message.sender);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function render() {
  nameEl.textContent = assistant ? assistant.name : 'Assistants';
  formEl.hidden = question !== null;
  leaveEl.hidden = !(canLeave && question === null);
  leaveEl.textContent = leaveLabel;
  withdrawEl.hidden = !(question && questionInLine(question));
  withdrawEl.textContent = withdrawLabel;
  blockEl.hidden = !assistant?.builderId;
  panelEl.classList.toggle('minimized', minimized);
  pillEl.hidden = !(isOpen() && minimized);
  pillEl.textContent = pillLabel(assistant?.name, unread);
  pillEl.classList.toggle('unread', unread);
  offerEl.hidden = !offer;
  offerEl.textContent = offer ? offerLabel(offer.name) : '';
  renderLog();
  renderStatus();
  // Exposed for the e2e (added for #3447): what the panel actually shows.
  window.__assistantChat = {
    open: isOpen(),
    assistantName: assistant?.name ?? null,
    conversationStatus: conversation?.status ?? null,
    handoverNotice: conversationOpen() ? handoverNotice(conversation) : null, // added for #3448
    messages: messages.map((message) => ({ sender: message.sender, text: message.text })),
    history: threadRows(history, question, assistant?.name).map((row) => ({ sender: row.sender, text: row.text })), // added for #3624
    status: statusEl.textContent,
    offer: offer ? { userId: offer.userId, name: offer.name } : null,
    canLeaveQuestion: !leaveEl.hidden,
    question: question ? {
      status: question.status, position: question.position ?? null, text: question.text, answer: question.answer?.text ?? null,
    } : null,
    statusIsError: statusEl.classList.contains('error'),
    // added for #3529: the minimised state and what the pill shows
    minimized,
    pill: pillEl.hidden ? null : { text: pillEl.textContent, unread },
  };
}

function stopPolling() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
}

function stopQuestionPolling() {
  if (questionTimer !== null) clearInterval(questionTimer);
  questionTimer = null;
}

// Takes the server's view of the shopper's left question (or none) into the
// panel, and checks it every few seconds while it is still in line.
function adoptQuestion(reply) {
  if (reply.keptDays) keptDays = reply.keptDays;
  if (typeof reply.assistantsOnShift === 'number') assistantsOnShift = reply.assistantsOnShift;
  question = reply.question ?? null;
  // #3624: an answered or expired question is not a card to close: it becomes
  // part of the thread (the server keeps it there) and the box is free again.
  if (question && !questionInLine(question)) {
    const finished = question;
    const hadAnswer = history.some((item) => item.questionId === finished.questionId && item.sender === 'assistant');
    history = history.filter((item) => item.questionId !== finished.questionId);
    history.push({ sender: 'shopper', text: finished.text, createdAt: finished.createdAt, questionId: finished.questionId });
    if (finished.answer) {
      history.push({
        sender: 'assistant', text: finished.answer.text, createdAt: finished.answer.answeredAt, questionId: finished.questionId,
        ...(finished.answer.assistantName ? { authorName: finished.answer.assistantName } : {}),
      });
      if (minimized && !hadAnswer) unread = true; // #3529
    } else if (finished.status === 'expired') {
      endedText = questionNotice(finished, { keptDays, assistantsOnShift });
    }
    question = null;
    closeAssistantQuestion().catch(() => { /* the server keeps it; shown once, folded in on the next open */ });
  }
  if (question && questionInLine(question)) startQuestionPolling();
  else stopQuestionPolling();
}

async function pollQuestion(token) {
  let reply;
  try {
    reply = await fetchAssistantQuestion();
  } catch {
    return; // retried on the next tick
  }
  if (token !== openToken || !isOpen()) return;
  adoptQuestion(reply);
  render();
}

function startQuestionPolling() {
  if (questionTimer !== null) return;
  const token = openToken;
  questionTimer = setInterval(() => { pollQuestion(token); }, QUESTION_POLL_INTERVAL_MS);
}

function adopt(reply) {
  if (reply.replyWaitSeconds) replyWaitSeconds = reply.replyWaitSeconds;
  if (typeof reply.assistantOnShift === 'boolean') assistantOnShift = reply.assistantOnShift;
  if (reply.conversation) {
    conversation = reply.conversation;
    // After a hand-over the assistant is a different account: its builder id (the
    // Block target) is not known here, so drop the old one rather than block the
    // wrong person.
    const changed = assistant?.userId !== reply.conversation.assistant.userId;
    assistant = { ...assistant, userId: reply.conversation.assistant.userId, name: reply.conversation.assistant.name ?? assistant?.name };
    if (changed && assistant.builderId) assistant.builderId = undefined;
  }
  if (reply.messages) messages = mergeMessages(messages, reply.messages);
}

async function poll(token) {
  if (inFlight || !conversationOpen()) return;
  let reply;
  try {
    reply = await fetchAssistantChat({ afterSeq: messages.length ? messages[messages.length - 1].seq : 0 });
  } catch {
    return; // a missed poll is retried on the next tick
  }
  if (token !== openToken || !isOpen()) return;
  const before = messages;
  if (!reply.conversation || reply.conversation.status !== 'open') {
    if (reply.messages) messages = mergeMessages(messages, reply.messages);
    conversation = reply.conversation;
    endedText = reply.conversation ? endedNotice(reply.conversation, assistant.name) : 'This conversation has ended.';
    stopPolling();
  } else {
    adopt(reply);
  }
  // #3529: a reply (or the end of the chat) while minimised lights the pill.
  if (minimized && (hasNewAssistantMessage(before, messages) || !conversationOpen())) unread = true;
  render();
}

// #3532: a chain of timeouts rather than a fixed interval, so the next poll comes
// sooner (1 s, not 2 s) while the shopper is waiting for a reply. pollTimer stays
// non-null for as long as polling is wanted; stopPolling() ends the chain.
function startPolling() {
  if (pollTimer !== null) return;
  const token = openToken;
  const tick = async () => {
    await poll(token);
    if (pollTimer === null || token !== openToken) return;
    pollTimer = setTimeout(tick, chatPollIntervalMs(messages));
  };
  pollTimer = setTimeout(tick, chatPollIntervalMs(messages));
}

// Opens the panel for an assistant. If the shopper already has an open
// conversation (this tab or another) it resumes that one: there is only ever one.
export async function openAssistantChat(target) {
  if (isOpen() && conversationOpen()) {
    if (minimized) restorePanel(); // #3529: tapping the assistant again brings the panel back
    else inputEl.focus();
    return;
  }
  const token = ++openToken;
  stopPolling();
  assistant = target ? { userId: target.userId, builderId: target.builderId ?? null, name: target.name } : null;
  conversation = null;
  messages = [];
  history = [];
  endedText = null;
  errorText = null;
  offer = null;
  question = null;
  canLeave = false;
  minimized = false;
  unread = false;
  stopQuestionPolling();
  panelEl.hidden = false;
  render();
  inputEl.focus();
  try {
    const reply = await fetchAssistantChat();
    if (token !== openToken) return;
    history = reply.history || []; // #3624
    if (reply.conversation && reply.conversation.status === 'open') {
      adopt(reply);
      startPolling();
    }
  } catch {
    // Nothing to resume; the first send reports any real problem.
  }
  // #3448: a question the shopper left earlier (an answer may be waiting).
  if (!conversationOpen()) {
    try {
      const reply = await fetchAssistantQuestion();
      if (token !== openToken) return;
      adoptQuestion(reply);
    } catch {
      // The first send reports any real problem.
    }
  }
  render();
}

// #3448: the Settings entry. Asking from here needs no assistant to be standing
// in the world: the question goes in line and the first free assistant takes it.
export function openAssistantQuestions() {
  return openAssistantChat(null);
}

export async function closeAssistantChat() {
  if (!isOpen()) return;
  openToken += 1;
  stopPolling();
  stopQuestionPolling();
  const wasOpen = conversationOpen();
  panelEl.hidden = true;
  minimized = false;
  unread = false;
  assistant = null;
  conversation = null;
  messages = [];
  history = [];
  endedText = null;
  errorText = null;
  offer = null;
  question = null; // a question left in line stays there: closing the panel keeps the place
  canLeave = false;
  render();
  if (wasOpen) {
    try { await endAssistantChat(); } catch { /* the server ends an idle conversation by itself */ }
  }
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || inFlight) return;
  if (!assistant) {
    await leaveQuestion(text); // opened from Settings: there is no one to start a chat with
    return;
  }
  inFlight = true;
  sendEl.disabled = true;
  errorText = null;
  endedText = null;
  offer = null;
  const token = openToken;
  try {
    let reply;
    if (conversationOpen()) {
      const { message } = await sendAssistantChat(text);
      reply = { messages: [message] };
    } else {
      messages = [];
      reply = await startAssistantChat({ assistantUserId: assistant.userId, text });
    }
    if (token !== openToken) return;
    adopt(reply);
    inputEl.value = '';
    startPolling();
  } catch (err) {
    if (token !== openToken) return;
    errorText = err.message;
    offer = freeAssistantOffer(err.body);
    canLeave = canLeaveQuestion(err.body);
    if (err.body?.conversationEnded) {
      if (conversation) conversation = { ...conversation, status: 'ended' };
      stopPolling();
    }
    if (err.body?.conversationId) {
      // Already in a conversation (another tab): pick it up.
      try { adopt(await fetchAssistantChat()); startPolling(); } catch { /* shown below */ }
    }
  } finally {
    inFlight = false;
    sendEl.disabled = false;
    if (token === openToken) render();
  }
});

async function leaveQuestion(text) {
  inFlight = true;
  sendEl.disabled = true;
  leaveEl.disabled = true;
  errorText = null;
  endedText = null;
  offer = null;
  const token = openToken;
  try {
    adoptQuestion(await leaveAssistantQuestion(text));
    canLeave = false;
    inputEl.value = '';
  } catch (err) {
    if (token !== openToken) return;
    errorText = err.message;
    if (err.body?.question) adoptQuestion({ question: err.body.question }); // already has one: show it
    if (err.body?.conversationId) {
      try { adopt(await fetchAssistantChat()); startPolling(); } catch { /* shown below */ }
    }
  } finally {
    inFlight = false;
    sendEl.disabled = false;
    leaveEl.disabled = false;
    if (token === openToken) render();
  }
}

leaveEl.addEventListener('click', () => {
  const text = inputEl.value.trim();
  if (!text) {
    errorText = 'Type your question first, then tap again.';
    render();
    inputEl.focus();
    return;
  }
  if (!inFlight) leaveQuestion(text);
});

// Takes a question back while it is in line, or closes an answered or expired
// one once it has been read.
withdrawEl.addEventListener('click', async () => {
  if (!question || inFlight) return;
  inFlight = true;
  const token = openToken;
  try {
    await closeAssistantQuestion();
    if (token !== openToken) return;
    question = null;
    stopQuestionPolling();
    errorText = null;
  } catch (err) {
    if (token !== openToken) return;
    errorText = err.message;
  } finally {
    inFlight = false;
    if (token === openToken) render();
  }
});

closeEl.addEventListener('click', () => { closeAssistantChat(); });

// #3529: minimising is not ending. The conversation, its polling and the
// 10-minute idle rule are untouched; only the panel is tucked away, so the
// shopper can try what the assistant suggested. Closing the keyboard first, so
// the world is fully visible again.
function restorePanel() {
  minimized = false;
  unread = false;
  render();
}
minimizeEl.addEventListener('click', () => {
  if (!isOpen()) return;
  inputEl.blur();
  minimized = true;
  render();
});
pillEl.addEventListener('click', restorePanel);

// Go to the free assistant the server named. The shopper's typed question stays
// in the box, so asking again is one tap on Send. A conversation is never open
// here (the refusal means none was made), so nothing needs ending first.
offerEl.addEventListener('click', () => {
  if (!offer) return;
  assistant = { userId: offer.userId, builderId: null, name: offer.name };
  offer = null;
  errorText = null;
  endedText = null;
  assistantOnShift = true;
  render();
  inputEl.focus();
});

// Blocking an assistant is blocking anyone: the same confirmation, the same
// effect (they are gone from the world and cannot be messaged). It ends the
// conversation and closes the panel. Without a builder id (a conversation
// resumed from another tab before the avatar was seen) there is nothing to
// block by, so the button is hidden.
blockEl.addEventListener('click', async () => {
  if (!assistant?.builderId) return;
  const blocked = await confirmAndBlockPerson(assistant.builderId, { returnFocusEl: blockEl });
  if (blocked) closeAssistantChat();
});

render();
