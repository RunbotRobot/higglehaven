// #2843 (sub-issue of #2841): the W-8BEN form's own `country` field
// (worker/lib/seller-payouts-tax.js's validateTaxIdForm) is a free-text
// input (src/main.js's tax-paperwork form has a plain <input type="text">
// for it, no country-code picker) — but tax_education_content.country_code
// (#2842) is a strict ISO 3166-1 alpha-2 code, since that's what an admin
// authoring content keys an entry on. Matching a real filer's free-text
// "France"/"Germany" against that requires a name->code lookup; this is
// that lookup, not a new location-collection mechanism (the signal itself
// still comes entirely from the existing W-9/W-8BEN form).
//
// Covers every ISO 3166-1 official short English name plus a short list of
// extremely common informal names (USA/UK/South Korea/etc.) likely to show
// up in a free-text field in practice. Deliberately NOT attempting fuzzy
// matching beyond this fixed list — a filer who types a country name this
// list doesn't recognize (a typo, an unusual abbreviation, a name in their
// own language) simply gets no jurisdiction-matched content, the same
// outcome as having no tax form on file at all. That's an acceptable rough
// edge for this feature's first version, not a correctness bug: it never
// produces a WRONG jurisdiction, only sometimes no jurisdiction.
const COUNTRY_NAME_TO_CODE = {
  'afghanistan': 'AF', 'albania': 'AL', 'algeria': 'DZ', 'andorra': 'AD', 'angola': 'AO',
  'antigua and barbuda': 'AG', 'argentina': 'AR', 'armenia': 'AM', 'australia': 'AU', 'austria': 'AT',
  'azerbaijan': 'AZ', 'bahamas': 'BS', 'bahrain': 'BH', 'bangladesh': 'BD', 'barbados': 'BB',
  'belarus': 'BY', 'belgium': 'BE', 'belize': 'BZ', 'benin': 'BJ', 'bhutan': 'BT',
  'bolivia': 'BO', 'bosnia and herzegovina': 'BA', 'botswana': 'BW', 'brazil': 'BR', 'brunei': 'BN',
  'bulgaria': 'BG', 'burkina faso': 'BF', 'burundi': 'BI', 'cabo verde': 'CV', 'cambodia': 'KH',
  'cameroon': 'CM', 'canada': 'CA', 'central african republic': 'CF', 'chad': 'TD', 'chile': 'CL',
  'china': 'CN', 'colombia': 'CO', 'comoros': 'KM', 'congo': 'CG',
  'democratic republic of the congo': 'CD', 'costa rica': 'CR', 'croatia': 'HR', 'cuba': 'CU',
  'cyprus': 'CY', 'czech republic': 'CZ', 'czechia': 'CZ', 'denmark': 'DK', 'djibouti': 'DJ',
  'dominica': 'DM', 'dominican republic': 'DO', 'ecuador': 'EC', 'egypt': 'EG', 'el salvador': 'SV',
  'equatorial guinea': 'GQ', 'eritrea': 'ER', 'estonia': 'EE', 'eswatini': 'SZ', 'ethiopia': 'ET',
  'fiji': 'FJ', 'finland': 'FI', 'france': 'FR', 'gabon': 'GA', 'gambia': 'GM',
  'georgia': 'GE', 'germany': 'DE', 'ghana': 'GH', 'greece': 'GR', 'grenada': 'GD',
  'guatemala': 'GT', 'guinea': 'GN', 'guinea-bissau': 'GW', 'guyana': 'GY', 'haiti': 'HT',
  'honduras': 'HN', 'hungary': 'HU', 'iceland': 'IS', 'india': 'IN', 'indonesia': 'ID',
  'iran': 'IR', 'iraq': 'IQ', 'ireland': 'IE', 'israel': 'IL', 'italy': 'IT',
  'ivory coast': 'CI', "cote d'ivoire": 'CI', 'jamaica': 'JM', 'japan': 'JP', 'jordan': 'JO',
  'kazakhstan': 'KZ', 'kenya': 'KE', 'kiribati': 'KI', 'kosovo': 'XK', 'kuwait': 'KW',
  'kyrgyzstan': 'KG', 'laos': 'LA', 'latvia': 'LV', 'lebanon': 'LB', 'lesotho': 'LS',
  'liberia': 'LR', 'libya': 'LY', 'liechtenstein': 'LI', 'lithuania': 'LT', 'luxembourg': 'LU',
  'madagascar': 'MG', 'malawi': 'MW', 'malaysia': 'MY', 'maldives': 'MV', 'mali': 'ML',
  'malta': 'MT', 'marshall islands': 'MH', 'mauritania': 'MR', 'mauritius': 'MU', 'mexico': 'MX',
  'micronesia': 'FM', 'moldova': 'MD', 'monaco': 'MC', 'mongolia': 'MN', 'montenegro': 'ME',
  'morocco': 'MA', 'mozambique': 'MZ', 'myanmar': 'MM', 'burma': 'MM', 'namibia': 'NA',
  'nauru': 'NR', 'nepal': 'NP', 'netherlands': 'NL', 'new zealand': 'NZ', 'nicaragua': 'NI',
  'niger': 'NE', 'nigeria': 'NG', 'north korea': 'KP', 'north macedonia': 'MK', 'macedonia': 'MK',
  'norway': 'NO', 'oman': 'OM', 'pakistan': 'PK', 'palau': 'PW', 'panama': 'PA',
  'papua new guinea': 'PG', 'paraguay': 'PY', 'peru': 'PE', 'philippines': 'PH', 'poland': 'PL',
  'portugal': 'PT', 'qatar': 'QA', 'romania': 'RO', 'russia': 'RU', 'russian federation': 'RU',
  'rwanda': 'RW', 'saint kitts and nevis': 'KN', 'saint lucia': 'LC', 'saint vincent and the grenadines': 'VC',
  'samoa': 'WS', 'san marino': 'SM', 'sao tome and principe': 'ST', 'saudi arabia': 'SA', 'senegal': 'SN',
  'serbia': 'RS', 'seychelles': 'SC', 'sierra leone': 'SL', 'singapore': 'SG', 'slovakia': 'SK',
  'slovenia': 'SI', 'solomon islands': 'SB', 'somalia': 'SO', 'south africa': 'ZA', 'south korea': 'KR',
  'korea': 'KR', 'south sudan': 'SS', 'spain': 'ES', 'sri lanka': 'LK', 'sudan': 'SD',
  'suriname': 'SR', 'sweden': 'SE', 'switzerland': 'CH', 'syria': 'SY', 'taiwan': 'TW',
  'tajikistan': 'TJ', 'tanzania': 'TZ', 'thailand': 'TH', 'timor-leste': 'TL', 'togo': 'TG',
  'tonga': 'TO', 'trinidad and tobago': 'TT', 'tunisia': 'TN', 'turkey': 'TR', 'turkiye': 'TR',
  'turkmenistan': 'TM', 'tuvalu': 'TV', 'uganda': 'UG', 'ukraine': 'UA', 'united arab emirates': 'AE',
  'uae': 'AE', 'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'u.s.a.': 'US', 'u.s.': 'US',
  'uruguay': 'UY', 'uzbekistan': 'UZ', 'vanuatu': 'VU', 'vatican city': 'VA', 'venezuela': 'VE',
  'vietnam': 'VN', 'yemen': 'YE', 'zambia': 'ZM', 'zimbabwe': 'ZW',
};

export function countryNameToCode(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
  return COUNTRY_NAME_TO_CODE[normalized] || null;
}

// Same free-text problem as country above, for the W-9 form's own `state`
// field (worker/lib/seller-payouts-tax.js's w9Fields) -- "California" vs.
// "CA". US states + DC, plus the inhabited US territories (#2951) -- a W-9
// is the correct form for a US person resident in Puerto Rico, Guam, the
// U.S. Virgin Islands, American Samoa, or the Northern Mariana Islands
// too, and transmitTax1099Form (#2939) now fails closed on an unresolved
// state rather than just degrading a soft jurisdiction-content lookup, so
// this table being incomplete would permanently block a real filing for
// one of these filers.
const US_STATE_NAME_TO_CODE = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL',
  'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA',
  'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
  'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR',
  'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA',
  'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
  'puerto rico': 'PR', 'guam': 'GU', 'u.s. virgin islands': 'VI', 'virgin islands': 'VI',
  'american samoa': 'AS', 'northern mariana islands': 'MP',
};

export function usStateNameToCode(name) {
  if (typeof name !== 'string') return null;
  const normalized = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
  return US_STATE_NAME_TO_CODE[normalized] || null;
}
