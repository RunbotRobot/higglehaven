// #4674 (walk of a buyer's addresses): the checkout form and Settings > Addresses kept two separate lists, so a person who
// had saved an address was asked to type it again, and one typed at checkout was never offered for saving. These are the
// small pure parts of joining them: a saved address as the form's fields, whether two are the same, and which saved
// addresses the seller can send to.

// A saved address (the account's own shape) as the checkout form's fields.
export function formFromSaved(saved) {
  return {
    name: saved.recipientName || '',
    line1: saved.line1 || '',
    line2: saved.line2 || '',
    city: saved.city || '',
    region: saved.region || '',
    postalCode: saved.postalCode || '',
    country: saved.country || 'US',
  };
}

// The form's fields as the account's shape, to save one typed at checkout.
export function savedFromForm(form) {
  return {
    recipientName: form.name,
    line1: form.line1,
    line2: form.line2 || '',
    city: form.city,
    region: form.region || '',
    postalCode: form.postalCode,
    country: form.country,
  };
}

const norm = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Whether the typed form is an address the person already saved (case, spacing and an empty line 2 do not matter).
export function sameAsSaved(form, saved) {
  const a = formFromSaved(saved);
  return ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'].every((field) => norm(form[field]) === norm(a[field]));
}

// The saved addresses the seller sends to: `countries` is the list of codes the product goes to, or null for everywhere.
export function savedFittingCountries(addresses, countries) {
  return (addresses || []).filter((saved) => !Array.isArray(countries) || countries.includes(saved.country));
}

// The one to start with: the default if it fits, else the first that does, else none.
export function startingSaved(fitting) {
  return fitting.find((saved) => saved.isDefault) || fitting[0] || null;
}

export function savedLabel(saved) {
  return [saved.recipientName, saved.line1, saved.city].filter(Boolean).join(', ');
}
