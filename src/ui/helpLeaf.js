// #3762 (the flower, 3/5; part of #3759): the "?" leaf. It replaces "How to move" in the menu
// and holds how to move, how higglehaven works, short manuals for shopping, building and
// selling, and the way to an assistant (which left Settings in the same change). The words of
// every page are the handbook's own entries (src/ui/helpManuals.js), so this and what an assistant
// says can never disagree.
import { openLeaf, closeLeaf, addBudPetals } from './bud.js';
import { MANUALS, buildManuals } from './helpManuals.js';
import { parseHandbook } from '../../scripts/assistant-handbook-lib.mjs';
import { openAssistantQuestions, warmAssistantThread } from '../shop/assistantChat.js';

let pagesPromise = null;

// The handbook is read when a page is first opened, not with the app: it is a lot of text and
// nothing on the opening screen needs it (moving, looking and drawing never wait on loading).
function loadPages() {
  if (!pagesPromise) {
    pagesPromise = import('../../docs/assistant-handbook.md?raw')
      .then((handbook) => buildManuals(parseHandbook(handbook.default)));
    pagesPromise.catch(() => { pagesPromise = null; });
  }
  return pagesPromise;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderList(body) {
  body.replaceChildren();
  const list = el('ul', 'help-list');
  for (const manual of MANUALS) {
    const item = el('li');
    const row = el('button', 'help-row', manual.title);
    row.type = 'button';
    row.dataset.helpPage = manual.id;
    row.addEventListener('click', () => renderPage(body, manual.id));
    item.appendChild(row);
    list.appendChild(item);
  }
  const ask = el('li');
  const askRow = el('button', 'help-row', 'Ask an assistant');
  askRow.type = 'button';
  askRow.id = 'help-ask-assistant-btn';
  askRow.addEventListener('click', async () => {
    // #3773: the row stays, marked busy, until the window is up with its conversation in it.
    askRow.setAttribute('aria-busy', 'true');
    try { await openAssistantQuestions(); } finally { askRow.removeAttribute('aria-busy'); }
    closeLeaf();
  });
  warmAssistantThread(); // #3773: so most opens find the thread already fetched
  ask.appendChild(askRow);
  list.appendChild(ask);
  body.appendChild(list);
}

async function renderPage(body, id) {
  body.replaceChildren(el('p', 'help-note', 'Opening…'));
  let pages;
  try {
    pages = await loadPages();
  } catch {
    // Said plainly, and the way back stays (selectable text, never a silent blank).
    body.replaceChildren(el('p', 'help-note', 'These pages could not be opened just now. Check your connection and try again.'));
    body.appendChild(backButton(body));
    return;
  }
  const page = pages.find((candidate) => candidate.id === id);
  if (!page) return;
  body.replaceChildren(backButton(body), el('h3', 'help-page-title', page.title));
  for (const entry of page.entries) {
    const details = el('details', 'help-entry');
    if (page.entries.length === 1) details.open = true;
    details.appendChild(el('summary', null, entry.title));
    const steps = el('ol', 'help-steps');
    for (const step of entry.steps) steps.appendChild(el('li', null, step));
    details.appendChild(steps);
    if (entry.see) details.appendChild(el('p', 'help-see', entry.see));
    body.appendChild(details);
  }
}

function backButton(body) {
  const back = el('button', 'help-back', '← Back');
  back.type = 'button';
  back.addEventListener('click', () => renderList(body));
  return back;
}

export function openHelpLeaf() {
  openLeaf({
    id: 'help',
    title: 'Help',
    render: (body) => renderList(body),
  });
}

// Shop and Build get the petal here; Sell registers its own list next to the product list it opens
// (src/sell/mode.js) and adds this one there. A module that imports the bud cannot be imported by it.
if (typeof document !== 'undefined') {
  addBudPetals('shop', [{ id: 'help', label: '?', run: openHelpLeaf }]);
  addBudPetals('build', [{ id: 'help', label: '?', run: openHelpLeaf }]);
}
