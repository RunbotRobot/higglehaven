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
  mergeMessages, replyState, endedNotice, readingNotice, slowNotice, offShiftNotice, disclosureText, freeAssistantOffer, offerLabel,
  canLeaveQuestion, questionNotice, questionInLine, leaveLabel, withdrawLabel, doneLabel,
} from './assistantChatLogic.js';

const POLL_INTERVAL_MS = 2000;
// A left question is not a live chat, so it is checked less often.
const QUESTION_POLL_INTERVAL_MS = 5000;

const panelEl = document.getElementById('assistant-chat-panel');
const nameEl = document.getElementById('assistant-chat-name');
const closeEl = document.getElementById('assistant-chat-close');
const blockEl = document.getElementById('assistant-chat-block');
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
let replyWaitSeconds = 90; // replaced by the server's number on every reply
let assistantOnShift = true;
let endedText = null; // why the last conversation ended, shown until the next send
let errorText = null; // the last failed action's message, shown until the next action
let offer = null; // a free assistant the server named after a busy/off-shift refusal (#3448)
let question = null; // #3448: the shopper's left question (the server's view), or null
let keptDays = 7; // replaced by the server's number on every reply
let assistantsOnShift = null; // how many are on the floor; from the server
let canLeave = false; // the last refusal said an assistant was busy or off shift
let pollTimer = null;
let questionTimer = null;
let inFlight = false;
let openToken = 0; // a stale open() must not write into a newer one

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

function renderLog() {
  logEl.replaceChildren();
  if (question) {
    const rows = [['You', question.text, 'shopper']];
    if (question.answer) rows.push([question.answer.assistantName || 'An assistant', question.answer.text, 'assistant']);
    for (const [name, body, sender] of rows) {
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
    logEl.scrollTop = logEl.scrollHeight;
    return;
  }
  if (!assistant) return;
  if (messages.length === 0 && !conversationOpen()) {
    const note = document.createElement('div');
    note.className = 'assistant-chat-note';
    note.textContent = disclosureText(assistant.name);
    logEl.append(note);
  }
  for (const message of messages) {
    const row = document.createElement('div');
    row.className = `assistant-chat-message ${message.sender}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = message.sender === 'shopper' ? 'You' : assistant.name;
    const text = document.createElement('span');
    text.textContent = message.text;
    row.append(who, text);
    logEl.append(row);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function render() {
  nameEl.textContent = assistant ? assistant.name : 'Assistants';
  formEl.hidden = question !== null;
  leaveEl.hidden = !(canLeave && question === null);
  leaveEl.textContent = leaveLabel;
  withdrawEl.hidden = question === null;
  withdrawEl.textContent = question && questionInLine(question) ? withdrawLabel : doneLabel;
  blockEl.hidden = !assistant?.builderId;
  offerEl.hidden = !offer;
  offerEl.textContent = offer ? offerLabel(offer.name) : '';
  renderLog();
  renderStatus();
  // Exposed for the e2e (added for #3447): what the panel actually shows.
  window.__assistantChat = {
    open: isOpen(),
    assistantName: assistant?.name ?? null,
    conversationStatus: conversation?.status ?? null,
    messages: messages.map((message) => ({ sender: message.sender, text: message.text })),
    status: statusEl.textContent,
    offer: offer ? { userId: offer.userId, name: offer.name } : null,
    canLeaveQuestion: !leaveEl.hidden,
    question: question ? {
      status: question.status, position: question.position ?? null, text: question.text, answer: question.answer?.text ?? null,
    } : null,
    statusIsError: statusEl.classList.contains('error'),
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
    assistant = { ...assistant, userId: reply.conversation.assistant.userId, name: reply.conversation.assistant.name ?? assistant?.name };
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
  if (!reply.conversation || reply.conversation.status !== 'open') {
    if (reply.messages) messages = mergeMessages(messages, reply.messages);
    conversation = reply.conversation;
    endedText = reply.conversation ? endedNotice(reply.conversation, assistant.name) : 'This conversation has ended.';
    stopPolling();
  } else {
    adopt(reply);
  }
  render();
}

function startPolling() {
  if (pollTimer !== null) return;
  const token = openToken;
  pollTimer = setInterval(() => { poll(token); }, POLL_INTERVAL_MS);
}

// Opens the panel for an assistant. If the shopper already has an open
// conversation (this tab or another) it resumes that one: there is only ever one.
export async function openAssistantChat(target) {
  if (isOpen() && conversationOpen()) {
    inputEl.focus();
    return;
  }
  const token = ++openToken;
  stopPolling();
  assistant = target ? { userId: target.userId, builderId: target.builderId ?? null, name: target.name } : null;
  conversation = null;
  messages = [];
  endedText = null;
  errorText = null;
  offer = null;
  question = null;
  canLeave = false;
  stopQuestionPolling();
  panelEl.hidden = false;
  render();
  inputEl.focus();
  try {
    const reply = await fetchAssistantChat();
    if (token !== openToken) return;
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
  assistant = null;
  conversation = null;
  messages = [];
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
