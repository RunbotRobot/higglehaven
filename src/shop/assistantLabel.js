// #3445 (part of #3444): what a shopper reads above a fleet assistant. Pure,
// so it is unit-testable without three.js; the sprite is drawn in
// assistantAvatar.js.
//
// The name is the agent name the server sends (never a session name once the
// owner's mapping is filled in). The second line is the plain word
// "assistant", so nobody mistakes an agent for another shopper.
export const ASSISTANT_WORD = 'assistant';
export const ASSISTANT_NAME_MAX_CHARS = 24;

// Normalises whatever a presence poll carried for `assistant` to a display
// name, or null when the avatar is an ordinary shopper (key absent, an older
// server, or anything malformed). Only a non-empty string name counts.
export function assistantNameFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  return name || null;
}

export function assistantTagLines(name) {
  const shown = name.length > ASSISTANT_NAME_MAX_CHARS ? `${name.slice(0, ASSISTANT_NAME_MAX_CHARS - 1)}…` : name;
  return [shown, ASSISTANT_WORD];
}

// One line for places that list people as text (nearby chat, the voice
// roster) rather than drawing a tag over an avatar: "Juniper · assistant".
// Same name rules as the tag above, so the two never disagree.
export function assistantSpeakerLabel(name) {
  const [shown, word] = assistantTagLines(name);
  return `${shown} \u00b7 ${word}`;
}
