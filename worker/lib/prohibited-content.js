import { HttpError } from './http.js';

// #921: the baseline prohibited-content check, shared by catalog templates
// (worker/lib/catalog.js) and bundle names (worker/lib/auctions.js) so the
// phrase list can never drift between the two community-visible surfaces.
// Baseline prohibited-content policy (docs/SPEC.md §4: "Prohibited
// categories (baseline, eBay/Etsy-referenced): weapons capable of serious
// harm, controlled substances/paraphernalia, adult content,
// counterfeit/unauthorized trademarked goods, live animals."). A plain
// phrase blocklist checked against name/category/subcategory — not real
// content moderation (no image/AI review exists anywhere in this dev-mode
// backend), just the same "honest simplest form" baseline this project
// applies elsewhere. Deliberately phrase-based rather than single loose
// words ("firearm," not "gun" alone) to keep false positives low against a
// catalog that's mostly ordinary placeholder/furniture names.
const PROHIBITED_CONTENT_PHRASES = [
  'firearm', 'handgun', 'assault rifle', 'ammunition', 'explosive device',
  'illegal drug', 'narcotic', 'drug paraphernalia', 'cocaine', 'heroin', 'methamphetamine',
  'adult content', 'pornographic', 'explicit sexual content',
  'counterfeit', 'knockoff replica',
  'live animal', 'live pet sale',
];

export function assertNotProhibitedContent(template, noun = 'listing') {
  const haystack = [template.name, template.category, template.subcategory]
    .filter(Boolean).join(' ').toLowerCase();
  const match = PROHIBITED_CONTENT_PHRASES.find((phrase) => haystack.includes(phrase));
  if (match) {
    throw new HttpError(`This ${noun} appears to violate higglehaven's prohibited-categories policy (matched "${match}")`, 400);
  }
}
