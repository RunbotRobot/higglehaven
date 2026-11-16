// The frame for #3540 (leaf #3600): a direction whose page is not there yet shows
// "coming" instead of a dead link, and a thumbnail that is missing is hidden.
(function () {
  for (const card of document.querySelectorAll('.direction')) {
    fetch(card.dataset.page, { method: 'HEAD' }).then((res) => {
      const html = (res.headers.get('content-type') || '').includes('text/html');
      if (res.ok && html) return;
      card.classList.add('coming');
      const open = card.querySelector('.open');
      if (open) open.textContent = 'Coming';
    }).catch(() => {});
  }
  for (const img of document.querySelectorAll('.thumbs img')) {
    img.addEventListener('error', () => { img.hidden = true; });
  }
})();
