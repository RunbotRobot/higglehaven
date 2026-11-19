// #3888 (One voice): find every sentence a person can read, with the file and line it comes from, so
// the words can be read through in one sitting and the next pass does not start from nothing.
//
// This is a reader's aid, not a parser: it errs towards listing a little too much (a developer string
// that looks like words) over missing a real one, and says where each string was found so a person can
// judge. Pure functions here; scripts/list-copy.mjs is the command line.

// Which part of the product a file belongs to, for reading by area.
export function areaOf(file) {
  const f = file.replace(/\\/g, '/');
  if (f === 'index.html') return 'Shell (index.html)';
  if (f.startsWith('public/admin')) return 'Admin pages';
  if (f.startsWith('worker/')) return 'Server messages';
  if (/assistant/.test(f)) return 'Assistant';
  if (/(^|\/)(friends|social|blocks|nearbyChat|voiceChat)/.test(f)) return 'People and chat';
  if (f.startsWith('src/shop/')) return 'Shop';
  if (f.startsWith('src/build/')) return 'Build';
  if (f.startsWith('src/sell/') || f.startsWith('src/catalog/') || /sellerShowcase/.test(f)) return 'Sell';
  if (/^src\/(account|settings|feedback)\//.test(f) || /^src\/(settings|stripeStep|errorCopy|rateLimitNotice)/.test(f)) return 'Account and Settings';
  if (f.startsWith('src/ui/')) return 'Flower and shared pieces';
  return 'Other';
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&times;': '×', '&nbsp;': ' ', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–' };
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);

// Does this look like something a person reads (words), not an id, a class name, a path or a selector?
export function looksLikeCopy(s) {
  const t = s.trim();
  if (t.length < 2) return false;
  if (/^[#.\[]/.test(t) || /^[a-z0-9_.-]+\/[\w./-]*$/i.test(t)) return false; // selector, path
  if (/^[a-z0-9_-]+$/.test(t) && !/[A-Z ]/.test(t)) return false; // an id-like word
  if (/^(https?:|data:|\/api\/|--|#[0-9a-f]{3,8}$)/i.test(t)) return false;
  if (/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|PRAGMA|BEGIN)\b/.test(t) && /\b(FROM|INTO|SET|TABLE|VALUES)\b/.test(t)) return false; // SQL
  if (/^[\d\s.,:;%+\-×x/()]+$/.test(t)) return false; // numbers and units only
  return /[A-Za-z]{2,}/.test(t) && (/\s/.test(t) || /^[A-Z]/.test(t) || /[.!?…]$/.test(t));
}

// Strings in an HTML file: text between tags and the attributes a person can read or hear.
export function htmlCopy(file, source) {
  const out = [];
  const lines = source.split('\n');
  let skip = null; // inside <script> or <style>
  let inComment = false;
  lines.forEach((line, i) => {
    let rest = line;
    if (inComment) {
      const end = rest.indexOf('-->');
      if (end < 0) return;
      inComment = false;
      rest = rest.slice(end + 3);
    }
    rest = rest.replace(/<!--.*?-->/g, '');
    if (rest.includes('<!--')) { inComment = true; rest = rest.slice(0, rest.indexOf('<!--')); }
    const open = rest.match(/<(script|style)\b[^>]*>/i);
    if (open && !new RegExp(`</${open[1]}>`, 'i').test(rest)) skip = open[1].toLowerCase();
    if (skip) { if (new RegExp(`</${skip}>`, 'i').test(rest)) skip = null; return; }
    for (const m of rest.matchAll(/\b(aria-label|placeholder|title|alt)="([^"]*)"/g)) {
      if (looksLikeCopy(decode(m[2]))) out.push({ file, line: i + 1, kind: m[1], text: decode(m[2]).trim() });
    }
    const textOnly = rest.replace(/<[^>]*>/g, '\u0000');
    for (const piece of textOnly.split('\u0000')) {
      const t = decode(piece).replace(/\s+/g, ' ').trim();
      if (looksLikeCopy(t)) out.push({ file, line: i + 1, kind: 'text', text: t });
    }
  });
  return out;
}

// Where in JS a string is something a person reads.
const READS = /(textContent|innerHTML|innerText|placeholder|ariaLabel|\.title|setAttribute\(\s*['"](?:aria-label|title|placeholder|alt)['"]|\blabel\s*:|\bname\s*:|\btitle\s*:|\bmessage\s*:|\btext\s*:|\bhint\s*:|\bnote\s*:|\bnotice\s*:|\bsentence\s*:|Error\(|HttpError\(|showInlineActionStatus|setBudWord|status\.text|Status\(|Message\(|announce|confirmLabel|cancelLabel)/;
const STRING = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g;

// Strings in a JS file that sit on a line that sets or raises something a person reads.
export function jsCopy(file, source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || /^import\b/.test(t) || /^export .* from\b/.test(t)) return;
    if (!READS.test(line)) return;
    const code = line.replace(/\/\/.*$/, (m, off) => (line.slice(0, off).split(/['"`]/).length % 2 === 1 ? m : ''));
    for (const m of code.matchAll(STRING)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      const text = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
      if (looksLikeCopy(decode(text)) && !/^(button|click|submit|div|span|input|section|[a-z]+-[a-z-]+)$/.test(text)) {
        out.push({ file, line: i + 1, kind: 'js', text });
      }
    }
  });
  return out;
}

export function copyOf(file, source) {
  return (file.endsWith('.html') ? htmlCopy(file, source) : jsCopy(file, source)).map((r) => ({ ...r, area: areaOf(file) }));
}

export const AREAS = ['Shell (index.html)', 'Shop', 'Build', 'Sell', 'Account and Settings', 'People and chat', 'Assistant', 'Flower and shared pieces', 'Server messages', 'Admin pages', 'Other'];
