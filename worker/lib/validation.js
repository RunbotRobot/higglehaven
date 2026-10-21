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
