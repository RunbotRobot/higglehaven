// #3445 (part of #3444): the names shoppers see for the assistants.
//
// There are two kinds of fleet account, both flagged users.is_fleet (so both
// are kept out of moderation and reputation): the coding sessions
// (`higglehaven2` ... `higglehaven12`), which work behind the scenes and are
// ordinary avatars with their session names when they visit the live site, and
// the assistants (owner decision 2026-11-11, #3444), which are separate
// sessions whose only job is to be in the world and help people. Only an
// assistant is shown with an agent name, the word "assistant" and the shirt.
//
// ONE mapping, assistant login name -> agent name. `POST /api/auth/fleet-login`
// takes the login name and sets the account's username to the agent name, on
// create and on every login, so changing a value here takes effect at that
// assistant's next login. An account is an assistant exactly when its username
// is one of the agent names below (isAssistantUsername); a coding session has
// no entry and is never one.
//
// The names and their order are the owner's (2026-11-11, #3445): assistants roll
// out in this order, starting with Juniper. All eleven are reserved now, so
// nobody can take one before its assistant exists: signup refuses them
// (isReservedUsername), and fleet-login refuses to take a name a regular account
// already holds. To add or rename an assistant, change this list.
export const ASSISTANT_AGENT_NAMES = [
  'Juniper', 'Clover', 'Fig', 'Sorrel', 'Maple', 'Tansy', 'Bramble', 'Moss', 'Basil', 'Fern', 'Sage',
];
// The login name an assistant session signs in with: `assistant-` plus the
// agent name in lower case. Distinct from the coding sessions' names, so the
// two kinds can never be confused.
const assistantLoginFor = (agentName) => `assistant-${agentName.toLowerCase()}`;

// The allow-list of coding-session names: `higglehaven` plus digits, exactly the
// names AGENTS.md assigns. fleet-login refuses anything that is neither one of
// these nor an assistant login below, so the key cannot mint an account under
// any other name (or sign in as a real person).
export const FLEET_NAME_PATTERN = /^higglehaven[0-9]{1,3}$/;

export const FLEET_AGENT_NAMES = Object.fromEntries(
  ASSISTANT_AGENT_NAMES.map((agentName) => [assistantLoginFor(agentName), agentName]),
);

// Whether fleet-login may mint or sign in an account under this name.
export function isFleetLoginName(name) {
  return FLEET_NAME_PATTERN.test(name) || Object.prototype.hasOwnProperty.call(FLEET_AGENT_NAMES, name);
}

// The username a fleet login's account carries.
export function agentNameFor(sessionName) {
  return Object.prototype.hasOwnProperty.call(FLEET_AGENT_NAMES, sessionName)
    ? FLEET_AGENT_NAMES[sessionName]
    : sessionName;
}

const normalise = (value) => String(value).trim().toLowerCase();

// True for a username only the fleet may hold: a mapped agent name, ignoring
// case and surrounding space so "Name" or " name " cannot sneak past.
//
// Session names ("higglehaven3") are deliberately NOT reserved here: they are
// never shown to a shopper once mapped, and scripts/live-site.mjs's local mode
// (--login local, against a throwaway wrangler dev) signs up an ordinary
// account under the session name. fleet-login already refuses to sign in as a
// regular account that holds one.
export function isReservedUsername(username) {
  const name = normalise(username);
  return Object.values(FLEET_AGENT_NAMES).some((agent) => normalise(agent) === name);
}

// True when a fleet account's username is an assistant's agent name. The
// presence payload marks only these as assistants (a coding session's account
// is an ordinary avatar), and derives it here from the server's own data, never
// from anything a client sends.
export function isAssistantUsername(username) {
  const name = normalise(username);
  return Object.values(FLEET_AGENT_NAMES).some((agent) => normalise(agent) === name);
}
