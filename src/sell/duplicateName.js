// #4344: Duplicate names the copy "<name> (copy)". The server holds a product's name to 100 characters
// (labelValue in worker/lib/validation.js; the upload field's own maxlength is the same), so a name of 94 to 100
// characters made a copy the server refused with a message about a field name. The base is trimmed so the copy
// fits; a shorter name is untouched.
export const PRODUCT_NAME_MAX_CHARS = 100;
const COPY_SUFFIX = ' (copy)';

export function duplicateName(name) {
  const room = PRODUCT_NAME_MAX_CHARS - COPY_SUFFIX.length;
  const base = name.length > room ? name.slice(0, room).trimEnd() : name;
  return `${base}${COPY_SUFFIX}`;
}
