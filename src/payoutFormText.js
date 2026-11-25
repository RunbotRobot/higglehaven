// #4339: the payout form and the tax paperwork form say what is wrong in the words on their own labels.
// The server names a field by its API name ("individual.ssnLast4 must be exactly 4 digits"); a seller reads
// "SSN (last 4 digits) must be exactly 4 digits". Checking before sending uses the same labels, so a blank
// field is refused on the step that holds it (docs: "A required field ... is validated on the step that holds it").
export const PAYOUT_FIELD_LABELS = {
  'individual.firstName': 'First name',
  'individual.lastName': 'Last name',
  'individual.dobDay': 'Birth day',
  'individual.dobMonth': 'Birth month',
  'individual.dobYear': 'Birth year',
  'individual.ssnLast4': 'SSN (last 4 digits)',
  'individual.idNumber': 'SSN or ITIN',
  'individual.phone': 'Phone number',
  'individual.addressLine1': 'Street address',
  'individual.addressCity': 'City',
  'individual.addressState': 'State',
  'individual.addressPostalCode': 'ZIP code',
  'individual.addressCountry': 'Country',
  'externalAccount.routingNumber': 'Bank routing number',
  'externalAccount.accountNumber': 'Bank account number',
  'externalAccount.currency': 'Currency',
  legalName: 'Legal name',
  addressLine1: 'Street address',
  city: 'City',
  state: 'State',
  postalCode: 'ZIP code',
  taxIdNumber: 'SSN or EIN',
  country: 'Country',
  countryOfCitizenship: 'Country of citizenship',
  foreignTaxId: 'Foreign tax ID',
};

// Longest names first so "individual.addressLine1" is never read as the bare "addressLine1".
const NAMES_LONGEST_FIRST = Object.keys(PAYOUT_FIELD_LABELS).sort((a, b) => b.length - a.length);

export function plainPayoutMessage(message) {
  if (typeof message !== 'string') return message;
  let out = message;
  for (const name of NAMES_LONGEST_FIRST) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9.])${name.replace('.', '\\.')}(?![A-Za-z0-9])`, 'g');
    out = out.replace(pattern, (_m, lead) => `${lead}${PAYOUT_FIELD_LABELS[name]}`);
  }
  // A sentence starts with a capital whichever label led it.
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// specs: [[key, label], ...] in the order they appear; values: { key: string }.
// Returns "First name is required." for the first blank one, or null.
export function firstBlankFieldMessage(specs, values) {
  for (const [key, label] of specs) {
    if (String(values[key] ?? '').trim() === '') return `${label} is required.`;
  }
  return null;
}
