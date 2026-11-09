// #3249: an in-app replacement for window.confirm() in a row of buttons.
// A browser can suppress native dialogs (Chrome's "prevent this page from
// creating additional dialogs", some embedded/PWA contexts), and a
// suppressed confirm() returns false at once -- the action then silently
// does nothing. This shows the question next to the buttons instead and
// resolves true on the yes button, false on the no button.
export function inlineConfirm(hostEl, message, { yesLabel = 'Yes', noLabel = 'Never mind' } = {}) {
  return new Promise((resolve) => {
    const box = document.createElement('span');
    box.className = 'seller-row-confirm inline-confirm';
    const text = document.createElement('span');
    text.textContent = message;
    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'seller-row-action-btn inline-confirm-yes-btn';
    yesBtn.textContent = yesLabel;
    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'seller-row-action-btn inline-confirm-no-btn';
    noBtn.textContent = noLabel;
    const finish = (answer) => {
      box.remove();
      resolve(answer);
    };
    yesBtn.addEventListener('click', () => finish(true));
    noBtn.addEventListener('click', () => finish(false));
    box.append(text, yesBtn, noBtn);
    hostEl.appendChild(box);
    yesBtn.focus();
  });
}
