// #4136: what a username may be, from one place. Signup and the rename route both call these, so the rules cannot
// drift. A name is a display name for a person (one alias, shown wherever the person is shown), so single spaces are
// fine; what is refused is whatever a person cannot see or that changes how text is drawn, and what makes two names
// read the same.
import { HttpError } from './http.js';
import { ASSISTANT_AGENT_NAMES } from './fleet-agents.js';

export const USERNAME_MAX_LENGTH = 40;
export const USERNAME_CHARACTER_MESSAGE = 'That name contains a character we cannot show. Try letters, numbers and single spaces.';

// A lone surrogate half is not text; it breaks encoders further along.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Control (newline, tab, DEL), format (zero-width, direction overrides, joiners), private use, unassigned, and the
// line and paragraph separators. Odd spaces (\p{Zs}: non-breaking, em space, ideographic...) are turned into a plain
// space before this is checked, so they are not here.
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

// Validates and normalises a username a person typed: NFC, odd spaces to a plain space, runs of white space collapsed
// to one, trimmed. Returns the name to store. Throws a 400 whose message says why, in the person's terms.
export function normalizeUsername(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError('username is required', 400);
  if (LONE_SURROGATE.test(value)) throw new HttpError(USERNAME_CHARACTER_MESSAGE, 400);
  // \t, \n and friends are Cc, which would be refused below; a person pasting a tab is as unshowable as one pasting a
  // newline, so they are refused rather than silently turned into a space. Only the Zs family becomes a space.
  const spaced = value.normalize('NFC').replace(/\p{Zs}/gu, ' ');
  if (UNSHOWABLE.test(spaced)) throw new HttpError(USERNAME_CHARACTER_MESSAGE, 400);
  const name = spaced.replace(/ {2,}/g, ' ').trim();
  if (name === '') throw new HttpError('username is required', 400);
  if ([...name].length > USERNAME_MAX_LENGTH) {
    throw new HttpError(`username must be at most ${USERNAME_MAX_LENGTH} characters`, 400);
  }
  return name;
}

// Letters of other alphabets that are drawn the same as a Latin letter (lower case, after case folding). Not every
// confusable in Unicode: the Latin, Cyrillic and Greek ones that can be typed on an ordinary keyboard layout.
const LOOK_ALIKES = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't',
  'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w',
  // Greek
  'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u',
  'χ': 'x', 'ω': 'w',
  // Latin letters that are not ASCII but read as one
  'ı': 'i', 'ɡ': 'g', 'ᴀ': 'a', 'ᴇ': 'e', 'ᴏ': 'o', 'ᴘ': 'p', 'ᴜ': 'u',
};

// The folded form two names are compared by: decomposed so accents come off, lower-cased, look-alike letters mapped to
// one skeleton, white space collapsed. "Juniper", "JUNIPER" and "Junіper" (Cyrillic i) all fold to "juniper".
export function usernameSkeleton(name) {
  const base = String(name)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\p{Zs}/gu, ' ');
  let out = '';
  for (const ch of base) out += LOOK_ALIKES[ch] ?? ch;
  return out.replace(/ {2,}/g, ' ').trim();
}

// Names nobody but the fleet or the owner may hold: plainly misleading ones, and the assistants' agent names.
const MISLEADING_NAMES = ['admin', 'administrator', 'support', 'staff', 'moderator', 'higglehaven'];
const RESERVED_SKELETONS = new Set([
  ...MISLEADING_NAMES,
  ...ASSISTANT_AGENT_NAMES,
].map((name) => usernameSkeleton(name).replace(/ /g, '')));

// Compared with the spaces taken out as well, so "Hig gle haven" is no more available than "Higglehaven".
export function isReservedSkeleton(skeleton) {
  return RESERVED_SKELETONS.has(String(skeleton).replace(/ /g, ''));
}
