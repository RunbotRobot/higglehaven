// #3303/#3348: the one decision behind recording a modal status line as a
// message the person was shown, kept dependency-free (no DOM) so it is
// unit-testable. Does this line currently hold an error? An empty line, or a
// plain progress/success note, does not.
export function isErrorLine({ text, hasErrorClass, role }) {
  if (!String(text ?? '').trim()) return false;
  return Boolean(hasErrorClass) || role === 'alert';
}
