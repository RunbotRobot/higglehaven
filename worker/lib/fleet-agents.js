// #3445 (part of #3444): the names shoppers see for the fleet's assistants.
//
// ONE mapping, session name -> agent name. `POST /api/auth/fleet-login` keeps
// taking the session name and sets the account's username to the agent name,
// on create and on every login, so changing a value here takes effect at that
// session's next login. A session name is never shown to a shopper once its
// agent name is set here.
//
// The names are the owner's to choose (asked by email 2026-11-11), and nothing
// here is invented in the meantime: a session with no entry keeps its session
// name as its username, exactly as before this file existed. Filling in this
// map is the last step; it is reviewed on its own.
//
// A name here is reserved for the fleet: signup refuses it (isReservedUsername),
// and fleet-login refuses to take a name a regular account already holds.
// Add each entry as `higglehaven3: 'Name'`.
// The allow-list of session names: `higglehaven` plus digits, exactly the names
// AGENTS.md assigns. Anything else is refused by fleet-login, so the key cannot
// mint an account under any other name (or sign in as a real person).
export const FLEET_NAME_PATTERN = /^higglehaven[0-9]{1,3}$/;

export const FLEET_AGENT_NAMES = {};

// The username a fleet session's account carries.
export function agentNameFor(sessionName) {
  return Object.prototype.hasOwnProperty.call(FLEET_AGENT_NAMES, sessionName)
    ? FLEET_AGENT_NAMES[sessionName]
    : sessionName;
}

const normalise = (value) => String(value).trim().toLowerCase();

// True for a username only the fleet may hold: any session name
// ("higglehaven" plus digits) or any mapped agent name, ignoring case and
// surrounding space so "Higglehaven3" or " Name " cannot sneak past.
export function isReservedUsername(username) {
  const name = normalise(username);
  if (FLEET_NAME_PATTERN.test(name)) return true;
  return Object.values(FLEET_AGENT_NAMES).some((agent) => normalise(agent) === name);
}
