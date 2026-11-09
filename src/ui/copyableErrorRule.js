// #3303: the one decision behind the Copy button on error lines, kept
// dependency-free (no DOM) so it is unit-testable. Does this status line
// currently hold an error worth a Copy button? An empty line, or a plain
// progress/success note, does not.
export function shouldOfferCopy({ text, hasErrorClass, role }) {
  if (!String(text ?? '').trim()) return false;
  return Boolean(hasErrorClass) || role === 'alert';
}
