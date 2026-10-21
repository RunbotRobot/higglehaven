// #2528: request-body/field validation and database-error-translation
// helpers used from nearly every route handler below (readJson: 82 raw
// call-site occurrences, stringValue: 81, labelValue: 43, databaseHttpError:
// called once from worker/index.js's own central error-handling wrapper
// that every handle* response passes through, same shared-reach shape as
// json/HttpError in worker/lib/http.js). Extracted verbatim, zero behavior
// change.
import { HttpError } from './http.js';

export async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError('Expected application/json request body', 415);
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError('Request body is not valid JSON', 400);
  }
}

// Walks an error's own .cause chain -- not every D1 constraint message is
// on the outermost error object. Shared by databaseHttpError below and
// worker/lib/notifications.js's own isForeignKeyConstraintError.
export function errorMessages(error) {
  const messages = [];
  let current = error;
  while (current && !messages.includes(current.message)) {
    if (typeof current.message === 'string') messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' ');
}

// Translates a raw D1 constraint failure into plain, in-app phrasing
// instead of the underlying SQL constraint type verbatim ("UNIQUE
// constraint failed" -> "Resource already exists", etc.) -- the frontend
// shows this message directly via `alert(err.message || ...)`.
export function databaseHttpError(error) {
  const message = errorMessages(error);

  if (message.includes('UNIQUE constraint failed')) {
    return new HttpError('That already exists.', 409);
  }
  if (message.includes('generated ring radial overlap')) {
    return new HttpError('Generated ring would overlap existing generated rings', 409);
  }
  if (message.includes('generated ring boundary mismatch')) {
    return new HttpError('Adjacent generated rings must use matching boundary seams', 409);
  }
  if (message.includes('generated ring adjacency parent mismatch')) {
    return new HttpError('Adjacent ring does not match its parent reservation', 409);
  }
  if (message.includes('generated ring candidates are immutable')) {
    return new HttpError('Generated ring candidates cannot be changed individually', 409);
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new HttpError("That didn't go through — something it depends on is missing, or something else still depends on it.", 409);
  }
  if (message.includes('CHECK constraint failed') || message.includes('NOT NULL constraint failed')) {
    return new HttpError('That request has an invalid or missing value — please check the details and try again.', 400);
  }

  return null;
}

export function stringValue(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(`${field} is required`, 400);
  return value.trim();
}

// Found via backlog audit (#337): sign-post authorLabel, review
// authorLabel, and purchase buyerLabel are all free-text "who's this
// from" display labels validated with plain stringValue — unlike every
// other user-facing free-text field in this file (a post's own text
// capped at 280, catalog search's q at 100, password at 200), none of
// them had an upper bound. The frontend's own shopperLabel() prompt
// (src/main.js) has no maxlength either, so nothing stops an arbitrarily
// long value even through the normal UI, let alone a direct API call.
const MAX_LABEL_LENGTH = 100;

export function labelValue(value, field) {
  const label = stringValue(value, field);
  if (label.length > MAX_LABEL_LENGTH) {
    throw new HttpError(`${field} must be ${MAX_LABEL_LENGTH} characters or fewer`, 400);
  }
  return label;
}

// #2538: generic number/pagination/existence validators, used from dozens
// of unrelated route handlers across the file (finiteNumber: 29 call sites,
// queryLimit: 16, decodeCursor: 13, encodeCursor: 14, assertReferencesExist:
// 5) -- domain-agnostic in the same way readJson/stringValue/labelValue
// above already are. Extracted verbatim, zero behavior change.
export function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(`${field} must be a finite number`, 400);
  return number;
}

export function queryLimit(value, defaultValue) {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) throw new HttpError('limit must be an integer between 1 and 100', 400);
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new HttpError('limit must be an integer between 1 and 100', 400);
  return limit;
}

export function encodeCursor(createdAt, id) {
  const bytes = new TextEncoder().encode(JSON.stringify([createdAt, id]));
  return btoa(String.fromCharCode(...bytes));
}

export function decodeCursor(value) {
  if (value === null) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    // #1470: same empty-string guard decodeCatalogCursor/decodeCatalogPriceCursor
    // (still in worker/index.js) already have -- without it, a cursor
    // encoding ["",""] (never produced by encodeCursor itself) silently
    // matches every row on a descending-sort endpoint's
    // `created_at < '' OR (... id < '')` check, returning an empty page
    // instead of the 400 a malformed cursor should get.
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== 'string' || decoded[0] === '' ||
        typeof decoded[1] !== 'string' || decoded[1] === '') throw new Error();
    return { createdAt: decoded[0], id: decoded[1] };
  } catch {
    throw new HttpError('cursor is invalid', 400);
  }
}

// D1's own per-statement bound-parameter ceiling -- chunking a large
// `IN (...)` check against it the same way assertReferencesExist below
// already does is this constant's only use.
const D1_MAX_BOUND_PARAMETERS = 100;

export async function assertReferencesExist(db, table, column, values, field) {
  const uniqueValues = [...new Set(values)];
  const found = new Set();
  for (let i = 0; i < uniqueValues.length; i += D1_MAX_BOUND_PARAMETERS) {
    const chunk = uniqueValues.slice(i, i + D1_MAX_BOUND_PARAMETERS);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db.prepare(
      `SELECT ${column} AS value FROM ${table} WHERE ${column} IN (${placeholders})`,
    ).bind(...chunk).all();
    for (const row of results) found.add(row.value);
  }
  const missing = uniqueValues.find((value) => !found.has(value));
  if (missing !== undefined) throw new HttpError(`${field} "${missing}" does not exist`, 400);
}
