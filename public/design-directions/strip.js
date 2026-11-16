// The strip across the top of every direction page (#3600): Overview, A, B, C. A
// direction page includes it with one line: <script src="strip.js" defer></script>.
// A direction whose page is not there yet shows as "coming" instead of a dead link.
(function () {
  const here = location.pathname.split('/').pop() || 'index.html';
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'strip.css';
  document.head.append(css);
  const nav = document.createElement('nav');
  nav.className = 'dd-strip';
  nav.setAttribute('aria-label', 'Design directions');
  const items = [['./', 'Overview', 'index.html'], ['a.html', 'A', 'a.html'], ['b.html', 'B', 'b.html'], ['c.html', 'C', 'c.html']];
  for (const [href, label, file] of items) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    if (file === here || (here === '' && file === 'index.html')) link.className = 'here';
    nav.append(link);
    if (file === 'index.html' || file === here) continue;
    fetch(href, { method: 'HEAD' }).then((res) => {
      const html = (res.headers.get('content-type') || '').includes('text/html');
      if (res.ok && html) return;
      const note = document.createElement('span');
      note.className = 'coming';
      note.textContent = `${label} (coming)`;
      link.replaceWith(note);
    }).catch(() => {});
  }
  document.body.prepend(nav);
})();
