// #4175 (slice b): what a look-only admin does not need to see. A viewer opens the same read routes an admin
// does, but personal details come back masked: an email as `j***@g***.com`, no card details, no tax form
// details, no free-text evidence notes. The admin dashboard's layout, counts and states all still read.
// A handler passes the user requireAdminOrViewer returned; `admin.adminViewer` is only ever true for a viewer.

// "jane.doe@gmail.com" -> "j***@g***.com". The first character of the name, the first of the domain's
// first label, and the last label (the ending) stay, so the shape reads and the address does not.
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return email == null ? email : '***';
  const at = email.lastIndexOf('@');
  const name = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const label = dot > 0 ? domain.slice(0, dot) : domain;
  const ending = dot > 0 ? domain.slice(dot) : '';
  const first = (text) => (text ? [...text][0] : '');
  return `${first(name)}***@${first(label)}***${ending}`;
}

export const isViewer = (admin) => admin?.adminViewer === true;

// The email as this caller may see it.
export const emailFor = (admin, email) => (isViewer(admin) ? maskEmail(email) : email);
