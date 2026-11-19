// #3889 (part of the interface-week audit of messages said out of turn): something that is true
// of the whole app, with no control or thing in the world to say it at, is a short word beside
// the flower's head (shape (c)). The word is a door: one tap opens a leaf holding the full
// sentence as selectable text, and an optional button for what to do about it. Nothing stands on
// the world, nothing fades while it is a refusal or a failure, and the word goes by itself when
// the thing it announced is no longer true.
import { setBudWord, clearBudWord, openLeaf, closeLeaf, currentLeafId } from './bud.js';

const leafIdFor = (key) => `saying-${key}`;

// key: one per condition ('graphics', 'connection').
// word: the few letters beside the head. title/message: the opened leaf. label: what a screen
// reader says for the door. action: { label, run } for a button in the leaf (optional).
// readOnce: the word goes when its leaf is closed, because the sentence has then been read
// (a refusal still stays until then, never on a timer).
export function sayAtHead(key, { word, title, message, label = '', action = null, readOnce = false }) {
  const open = () => {
    openLeaf({
      id: leafIdFor(key),
      title,
      onClose: readOnce ? () => clearBudWord(key) : null,
      render: (body) => {
        const p = document.createElement('p');
        p.textContent = message;
        body.appendChild(p);
        if (action) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'saying-action';
          button.id = `${leafIdFor(key)}-action`;
          button.textContent = action.label;
          button.addEventListener('click', () => action.run());
          body.appendChild(button);
        }
      },
    });
  };
  setBudWord(key, word, { open, label: label || `${title}. Open for details.` });
}

export function clearSaying(key) {
  clearBudWord(key);
  if (currentLeafId() === leafIdFor(key)) closeLeaf();
}
